import {
    assert,
    assertEquals,
    assertExists,
    assertNotEquals,
    assertRejects,
} from "@std/assert";
import type { CreateSourceInput } from "@heimdall/admin-contracts";
import type {
    InferenceSource,
    SourceFactoryOptions,
    SourcePluginFactory,
} from "@heimdall/contracts";
import {
    type DraftProbeDependencies,
    probeSourceDraft,
} from "@heimdall/core/composition/source-draft-probe.ts";
import { createProxyPool } from "@heimdall/core/composition/proxy-pool.ts";
import { SourceProxyBindings } from "@heimdall/core/composition/source-proxy.ts";
import { withSourcePersistence } from "@heimdall/core/composition/source-factories.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";
import { loadBuiltinComposition } from "@heimdall/core/composition/builtins.ts";
import { createServerApp } from "@heimdall/core/http/app.ts";

const pluginId = "heimdall.source.openai-compatible";
const input: CreateSourceInput = {
    id: "e3ea7f49-9726-41a4-97c2-c6f00f51bb75",
    name: "草稿渠道",
    priority: 0,
    sourcePluginId: pluginId,
    config: { apiKey: "private-api-key", baseUrl: "https://example.test/v1" },
    proxy: { mode: "direct" },
};

function factory(create: SourcePluginFactory["create"]): SourcePluginFactory {
    return {
        manifest: {
            id: pluginId,
            name: "Fixture",
            version: "1.0.0",
            apiVersion: "1",
            kind: "source",
            trust: "trusted",
        },
        validate: (config) => config,
        create,
    };
}

function source(
    config: unknown,
    probe: InferenceSource["probe"],
): InferenceSource {
    return {
        id: (config as { id: string }).id,
        capabilities: [{ operation: "generation.create", streaming: true }],
        execute() {
            return (async function* () {})();
        },
        ...(probe ? { probe } : {}),
    };
}

async function fixture(create: SourcePluginFactory["create"]) {
    const resources = new AsyncDisposableStack();
    const kv = await Deno.openKv(":memory:");
    resources.defer(() => kv.close());
    const store = new DenoKvConfigStore(kv);
    const proxies = await createProxyPool(store);
    await proxies.save({
        defaultProxyId: "office",
        entries: [{
            id: "office",
            name: "办公室",
            url: "http://127.0.0.1:7890",
            enabled: true,
            basicAuth: { username: "proxy-user", password: "proxy-password" },
        }],
    });
    const wrapped = new SourceProxyBindings(proxies).wrap(
        withSourcePersistence(factory(create), store),
    );
    const dependencies: DraftProbeDependencies = {
        factories: new Map([[pluginId, wrapped]]),
        presets: [],
        enabled: () => true,
        proxies,
        timeoutMs: 100,
    };
    return { resources, dependencies, store };
}

Deno.test("draft probes preserve saved configuration, deliver selected proxy and return only bounded public discovery", async () => {
    let observed: SourceFactoryOptions | undefined;
    let probeSignal: AbortSignal | undefined;
    const oldConfig = { id: "saved-source", apiKey: "old-secret" };
    const test = await fixture((config, options) => {
        observed = options;
        assertNotEquals((config as { id: string }).id, input.id);
        return source(config, async (signal) => {
            probeSignal = signal;
            // Even an attempted token refresh cannot update a persisted source.
            await options?.onConfigUpdate?.({
                ...oldConfig,
                apiKey: "overwrite",
            }, oldConfig);
            return {
                ok: true,
                message: "private-api-key",
                models: [
                    " beta ",
                    "alpha",
                    "alpha",
                    "private-api-key",
                    "proxy-password",
                    "bad\nmodel",
                ],
            };
        });
    });
    await using _resources = test.resources;
    const configStore = test.store.namespace("heimdall", "source-config");
    await configStore.set(["saved-source"], {
        sourcePluginId: pluginId,
        config: oldConfig,
    });
    const before = await configStore.get(["saved-source"]);
    const result = await probeSourceDraft(
        { ...input, proxy: { mode: "proxy", proxyId: "office" } },
        new AbortController().signal,
        test.dependencies,
    );
    assertEquals(result.ok, true);
    assertEquals(result.models, ["alpha", "beta"]);
    assertExists(observed);
    assertEquals(observed.getProxy?.().mode, "proxy");
    assertEquals(probeSignal?.aborted, true);
    assertEquals(await configStore.get(["saved-source"]), before);
    assertEquals((await Array.fromAsync(configStore.list())).length, 1);
    assert(!JSON.stringify(result).includes("private"));
    assert(!JSON.stringify(result).includes("proxy-password"));
    const direct = await probeSourceDraft(
        input,
        new AbortController().signal,
        test.dependencies,
    );
    assertEquals(direct.ok, true);
    assertEquals(observed.getProxy?.(), {
        mode: "direct",
        selectedBy: "source",
    });
});

Deno.test("draft probes time out and propagate cancellation even when the plugin ignores it", async () => {
    let received: AbortSignal | undefined;
    const test = await fixture((config) =>
        source(config, (signal) => {
            received = signal;
            return new Promise(() => {});
        })
    );
    await using _resources = test.resources;
    const result = await probeSourceDraft(input, new AbortController().signal, {
        ...test.dependencies,
        timeoutMs: 5,
    });
    assertEquals(result.ok, false);
    assert(result.message.includes("超时"));
    assertEquals(received?.aborted, true);
    const cancellation = new AbortController();
    const pending = probeSourceDraft(
        input,
        cancellation.signal,
        test.dependencies,
    );
    cancellation.abort(new DOMException("stopped", "AbortError"));
    await assertRejects(() => pending, DOMException);
    assertEquals(received?.aborted, true);
});

Deno.test("draft probes reject unavailable plugins, invalid presets and unsupported discovery without exposing errors", async () => {
    const test = await fixture((config) => source(config, undefined));
    await using _resources = test.resources;
    await assertRejects(
        () =>
            probeSourceDraft(input, new AbortController().signal, {
                ...test.dependencies,
                enabled: () => false,
            }),
        Error,
        "源插件不可用",
    );
    await assertRejects(
        () =>
            probeSourceDraft(
                { ...input, presetId: "missing" },
                new AbortController().signal,
                test.dependencies,
            ),
        Error,
        "预设不可用",
    );
    await assertRejects(
        () =>
            probeSourceDraft(
                input,
                new AbortController().signal,
                test.dependencies,
            ),
        Error,
        "暂不支持",
    );
    const broken = {
        ...factory((config) => source(config, undefined)),
        validate() {
            throw new TypeError("private-api-key");
        },
    };
    const failure = await assertRejects(
        () =>
            probeSourceDraft(input, new AbortController().signal, {
                ...test.dependencies,
                factories: new Map([[pluginId, broken]]),
            }),
        Error,
        "配置校验失败",
    );
    assert(!failure.message.includes("private-api-key"));
});

Deno.test("draft probe endpoint is authenticated on both prefixes and never creates a channel", async () => {
    const upstream = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        onListen() {},
    }, (request) => {
        assertEquals(new URL(request.url).pathname, "/v1/models");
        assertEquals(
            request.headers.get("authorization"),
            "Bearer private-api-key",
        );
        return Response.json({ data: [{ id: "model-a" }, { id: "model-b" }] });
    });
    await using resources = new AsyncDisposableStack();
    resources.defer(() => upstream.shutdown());
    const composition = await loadBuiltinComposition({ env: () => undefined });
    resources.defer(() => composition.close());
    const app = createServerApp({
        adminAuthToken: "operator",
        adminManagement: composition.management,
        adminCatalog: composition.catalog,
    });
    for (const prefix of ["/admin", "/api/admin"]) {
        const body = JSON.stringify({
            ...input,
            presetId: "heimdall.preset.newapi",
            config: {
                apiKey: "private-api-key",
                baseUrl: `http://127.0.0.1:${upstream.addr.port}/v1`,
            },
        });
        const unauthorized = await app.request(`${prefix}/source-draft-probe`, {
            method: "POST",
            body,
        });
        assertEquals(unauthorized.status, 401);
        const response = await app.request(`${prefix}/source-draft-probe`, {
            method: "POST",
            body,
            headers: {
                authorization: "Bearer operator",
                "content-type": "application/json",
            },
        });
        assertEquals(response.status, 200);
        const result = await response.json();
        assertEquals(result.probe.models, ["model-a", "model-b"]);
        assertEquals(result.probe.ok, true);
        assertEquals(composition.sources.list().length, 0);
    }
});

Deno.test("draft probes isolate source initialization failures without exposing credentials", async () => {
    const test = await fixture(() => {
        throw new TypeError("cannot initialize with private-api-key");
    });
    await using _resources = test.resources;
    const failure = await assertRejects(
        () =>
            probeSourceDraft(
                input,
                new AbortController().signal,
                test.dependencies,
            ),
        Error,
        "无法初始化源插件",
    );
    assert(!failure.message.includes("private-api-key"));
    assertEquals((failure as Error & { status: number }).status, 400);
    assertEquals(
        (await Array.fromAsync(
            test.store.namespace("heimdall", "source-config").list(),
        )).length,
        0,
    );
});

Deno.test("draft probes accept successful connectivity with malformed optional discovery data", async () => {
    const test = await fixture((config) =>
        source(config, () =>
            Promise.resolve({
                ok: true,
                message: "connected",
                // JavaScript plugins can return data which violates their declared type.
                models: "unexpected text" as unknown as string[],
            }))
    );
    await using _resources = test.resources;
    const result = await probeSourceDraft(
        input,
        new AbortController().signal,
        test.dependencies,
    );
    assertEquals(result.ok, true);
    assertEquals(result.models, undefined);
});
