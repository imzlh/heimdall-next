import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { parseSourceMiddleware } from "@heimdall/admin-contracts/source-middleware.ts";
import {
    type BuiltinComposition,
    loadBuiltinComposition,
} from "@heimdall/core/composition/builtins.ts";
import type { StoredSourceConfig } from "@heimdall/core/composition/source-records.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";
import { createServerApp } from "@heimdall/core/http/app.ts";
import { createServer } from "@heimdall/core/composition/server.ts";
import { OpenAIProtocolPlugin } from "../plugins/openai-protocol/mod.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";

const sourceId = "8d1bc6bf-c85f-4d3b-83d9-925a50f79830";
const sourcePluginId = "example.source";
const firstMiddleware = "example.middleware.first";
const secondMiddleware = "example.middleware.second";
const context = {
    request: new Request("http://localhost/admin/sources"),
    requestId: "source-middleware-test",
};

Deno.test("source middleware parser preserves inheritance, explicit empty chains and order", () => {
    assertEquals(parseSourceMiddleware(undefined), null);
    assertEquals(parseSourceMiddleware(null), null);
    assertEquals(parseSourceMiddleware([]), []);
    const selection = [secondMiddleware, firstMiddleware];
    const parsed = parseSourceMiddleware(selection);
    selection.reverse();
    assertEquals(parsed, [secondMiddleware, firstMiddleware]);
    assert(Object.isFrozen(parsed));
    assertEquals(parseSourceMiddleware(["x", "a".repeat(128)]), [
        "x",
        "a".repeat(128),
    ]);
    for (
        const value of [
            {},
            "example.middleware.first",
            false,
            [firstMiddleware, firstMiddleware],
            [""],
            ["-invalid"],
            ["invalid-"],
            ["Invalid"],
            ["contains spaces"],
            ["example\n"],
            ["a".repeat(129)],
            [null],
            [1],
            new Array(1),
            Array.from({ length: 65 }, (_, index) => `example.${index}`),
        ]
    ) {
        assertThrows(() => parseSourceMiddleware(value), TypeError);
    }
    let accessed = false;
    const accessor: string[] = [];
    Object.defineProperty(accessor, "0", {
        get() {
            accessed = true;
            return firstMiddleware;
        },
    });
    assertThrows(() => parseSourceMiddleware(accessor), TypeError);
    assertEquals(accessed, false);
});

async function fixture(resources: AsyncDisposableStack) {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-middleware-",
    });
    resources.defer(() => Deno.remove(directory, { recursive: true }));
    const root = new URL(`file:///${directory.replaceAll("\\", "/")}/`);
    const writePlugin = async (
        name: string,
        id: string,
        kind: "source" | "middleware",
        body: string,
    ) => {
        const path = new URL(`${name}/`, root);
        await Deno.mkdir(path);
        const manifest = {
            id,
            name,
            version: "1.0.0",
            apiVersion: "1",
            kind,
            trust: "trusted",
        };
        await Deno.writeTextFile(
            new URL("manifest.json", path),
            JSON.stringify(manifest),
        );
        await Deno.writeTextFile(
            new URL("mod.ts", path),
            `export const manifest = ${JSON.stringify(manifest)};\n${body}`,
        );
    };
    await writePlugin(
        "source",
        sourcePluginId,
        "source",
        `
        export const sourcePlugin = {
            manifest,
            validate(config) {
                if (Object.hasOwn(config, "middleware")) {
                    throw new TypeError("middleware leaked to provider");
                }
                return { ...config };
            },
            create(config) {
                if (Object.hasOwn(config, "middleware")) {
                    throw new TypeError("middleware leaked to provider");
                }
                return {
                    id: config.id,
                    capabilities: [{ operation: "generation.create", models: ["upstream"], streaming: true }],
                    uiSnapshot() { return { configKeys: Object.keys(config) }; },
                    async *execute(input) {
                        if (input.traits.model !== "upstream") throw new Error("host model mapping was skipped");
                        const base = {
                            version: 1,
                            requestId: input.requestId,
                            streamId: "fixture:" + input.requestId,
                            timestamp: new Date().toISOString(),
                        };
                        const events = [
                            { kind: "run.started", request: input },
                            { kind: "message.started", message: { id: "m", role: "assistant", parts: [] } },
                            { kind: "part.started", messageId: "m", part: { id: "p", type: "text", text: "" } },
                            { kind: "part.delta", messageId: "m", partId: "p", delta: input.payload.instructions || "empty" },
                            { kind: "part.completed", messageId: "m", partId: "p" },
                            { kind: "message.completed", messageId: "m", finishReason: "stop" },
                            { kind: "run.completed" },
                        ];
                        for (const [index, event] of events.entries()) {
                            yield { ...base, seq: index + 1, eventId: String(index), event };
                        }
                    },
                };
            },
        };
    `,
    );
    await writePlugin(
        "first",
        firstMiddleware,
        "middleware",
        `
        export default { manifest, order: 20, transformRequest(request) {
            return { ...request, payload: { ...request.payload, instructions: (request.payload.instructions || "") + "A" } };
        } };
    `,
    );
    await writePlugin(
        "second",
        secondMiddleware,
        "middleware",
        `
        export default { manifest, order: 10, transformRequest(request) {
            return { ...request, payload: { ...request.payload, instructions: (request.payload.instructions || "") + "B" } };
        } };
    `,
    );
    const kv = await Deno.openKv(":memory:");
    resources.defer(() => kv.close());
    const store = new DenoKvConfigStore(kv);
    const options = {
        configStore: store,
        pluginRoot: root,
        env: () => undefined,
    };
    const load = async () => {
        const composition = await loadBuiltinComposition(options);
        resources.defer(() => composition.close());
        return composition;
    };
    return { store, load, root };
}

function appFor(composition: BuiltinComposition) {
    return createServerApp({
        adminCatalog: composition.catalog,
        adminManagement: composition.management,
    });
}

function sourceInput(middleware: unknown) {
    return {
        id: sourceId,
        name: "渠道中间件",
        priority: 4,
        sourcePluginId,
        middleware,
        config: { endpoint: "offline" },
    };
}

Deno.test("directory middleware bindings persist through CAS, config edits, switches, restart and deletion", async () => {
    await using resources = new AsyncDisposableStack();
    const { store, load } = await fixture(resources);
    const first = await load();
    const app = appFor(first);
    const sourceStore = store.namespace("heimdall", "source-config");
    assertEquals(first.middleware.list().map((plugin) => plugin.manifest.id), [
        secondMiddleware,
        firstMiddleware,
    ]);
    const selected = [firstMiddleware, secondMiddleware];
    const created = await app.request("/admin/sources", {
        method: "POST",
        body: JSON.stringify(sourceInput(selected)),
    });
    assertEquals(created.status, 201, await created.clone().text());
    const initial = await created.json();
    assertEquals(initial.source.middleware, selected);
    assertEquals(initial.source.ui.configKeys.sort(), ["endpoint", "id"]);
    const initialRecord = await sourceStore.get<StoredSourceConfig>([sourceId]);
    assertExists(initialRecord);
    assertEquals(initialRecord.value.middleware, selected);
    assert(!Object.hasOwn(initialRecord.value.config as object, "middleware"));
    assertEquals(first.sourceMiddleware().get(sourceId), selected);
    const initialSnapshot = first.sourceMiddleware();
    (first.sourceMiddleware() as Map<string, readonly string[]>).clear();
    assertEquals(first.sourceMiddleware().get(sourceId), selected);

    const update = (middleware: unknown, version: string) =>
        app.request(`/admin/sources?id=${sourceId}`, {
            method: "PATCH",
            headers: { "if-match": version },
            body: JSON.stringify({ middleware }),
        });
    const disabled = await update([], initialRecord.versionstamp);
    assertEquals(disabled.status, 200);
    assertEquals((await disabled.json()).source.middleware, []);
    assertEquals(first.sourceMiddleware().get(sourceId), []);
    assertEquals(initialSnapshot.get(sourceId), selected);
    const conflict = await update(null, initialRecord.versionstamp);
    assertEquals(conflict.status, 409);
    await conflict.body?.cancel();
    assertEquals(first.sourceMiddleware().get(sourceId), []);
    const config = await first.management.getSourceConfig?.(context, sourceId);
    const saved = await first.management.saveSourceConfig?.(
        context,
        sourceId,
        { endpoint: "updated" },
        config?.versionstamp,
    );
    assertExists(saved?.versionstamp);
    const configured = await sourceStore.get<StoredSourceConfig>([sourceId]);
    assertEquals(configured?.value.middleware, []);
    assertEquals(first.sourceMiddleware().get(sourceId), []);
    assertEquals(configured?.value.config, {
        id: sourceId,
        endpoint: "updated",
    });

    const inherited = await update(null, saved.versionstamp);
    assertEquals(inherited.status, 200);
    assertEquals((await inherited.json()).source.middleware, null);
    assertEquals(first.sourceMiddleware().has(sourceId), false);
    assertExists(inherited.headers.get("etag"));
    await first.management.setPluginEnabled?.(context, firstMiddleware, false);
    const restored = await update(selected, inherited.headers.get("etag")!);
    assertEquals(restored.status, 200);
    await restored.body?.cancel();
    assertEquals(first.sourceMiddleware().get(sourceId), selected);
    assertEquals(first.middleware.list().map((plugin) => plugin.manifest.id), [
        secondMiddleware,
    ]);

    const second = await load();
    assertEquals(second.sourceMiddleware().get(sourceId), selected);
    assertEquals(second.middleware.list().map((plugin) => plugin.manifest.id), [
        secondMiddleware,
    ]);
    const secondApp = appFor(second);
    const catalog = await secondApp.request("/admin/status");
    assertEquals(catalog.status, 200);
    const status = await catalog.json();
    assertEquals(status.sources[0].middleware, selected);
    const plugin = status.plugins.find((plugin: { id: string }) =>
        plugin.id === firstMiddleware
    );
    assertEquals([plugin.kind, plugin.enabled, plugin.canToggle], [
        "middleware",
        false,
        true,
    ]);
    await second.management.setPluginEnabled?.(context, firstMiddleware, true);
    assertEquals(second.middleware.list().map((plugin) => plugin.manifest.id), [
        secondMiddleware,
        firstMiddleware,
    ]);
    const staleDelete = await secondApp.request(
        `/admin/sources?id=${sourceId}`,
        {
            method: "DELETE",
            headers: { "if-match": initialRecord.versionstamp },
        },
    );
    assertEquals(staleDelete.status, 409);
    await staleDelete.body?.cancel();
    assertEquals(second.sourceMiddleware().get(sourceId), selected);
    const deleted = await secondApp.request(`/admin/sources?id=${sourceId}`, {
        method: "DELETE",
        headers: { "if-match": status.sources[0].versionstamp },
    });
    assertEquals(deleted.status, 200);
    await deleted.body?.cancel();
    assertEquals(second.sourceMiddleware().has(sourceId), false);
    assertEquals((await load()).sourceMiddleware().has(sourceId), false);
});

Deno.test("closing and reopening the durable store restores source bindings and middleware switches", async () => {
    await using resources = new AsyncDisposableStack();
    const { root } = await fixture(resources);
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-middleware-kv-",
    });
    resources.defer(() => Deno.remove(directory, { recursive: true }));
    const path = `${directory}/config.sqlite`;
    const selected = [firstMiddleware, secondMiddleware];
    {
        using kv = await Deno.openKv(path);
        const composition = await loadBuiltinComposition({
            configStore: new DenoKvConfigStore(kv),
            pluginRoot: root,
            env: () => undefined,
        });
        try {
            const app = appFor(composition);
            const created = await app.request("/admin/sources", {
                method: "POST",
                body: JSON.stringify({
                    ...sourceInput(selected),
                    modelMap: { public: "upstream" },
                }),
            });
            assertEquals(created.status, 201);
            await created.body?.cancel();
            await composition.management.setPluginEnabled!(
                context,
                firstMiddleware,
                false,
            );
        } finally {
            await composition.close();
        }
    }
    {
        using kv = await Deno.openKv(path);
        const composition = await loadBuiltinComposition({
            configStore: new DenoKvConfigStore(kv),
            pluginRoot: root,
            env: () => undefined,
        });
        try {
            assertEquals(
                composition.sourceMiddleware().get(sourceId),
                selected,
            );
            assertEquals(
                composition.middleware.list().map((plugin) =>
                    plugin.manifest.id
                ),
                [secondMiddleware],
            );
            const app = createServer({
                protocols: [new OpenAIProtocolPlugin()],
                sourceRegistry: composition.sources,
                middleware: composition.middleware,
                sourceMiddleware: composition.sourceMiddleware,
            });
            const response = await app.request("/v1/chat/completions", {
                method: "POST",
                body: JSON.stringify({
                    model: "public",
                    messages: [{ role: "user", content: "hello" }],
                }),
            });
            assertEquals(response.status, 200, await response.clone().text());
            assertEquals(
                (await response.json()).choices[0].message.content,
                "B",
            );
        } finally {
            await composition.close();
        }
    }
});

Deno.test("source management rejects unknown, non-middleware and invalid bindings before durable writes", async () => {
    await using resources = new AsyncDisposableStack();
    const { load, store } = await fixture(resources);
    const composition = await load();
    const app = appFor(composition);
    const sourceStore = store.namespace("heimdall", "source-config");
    const misplaced = await app.request("/admin/sources", {
        method: "POST",
        body: JSON.stringify({
            ...sourceInput(null),
            config: { middleware: [firstMiddleware] },
        }),
    });
    assertEquals(misplaced.status, 400);
    assert((await misplaced.json()).error.message.includes("顶层 middleware"));
    assertEquals(await sourceStore.get([sourceId]), null);
    const invalid = [
        ["example.missing"],
        [sourcePluginId],
        [firstMiddleware, firstMiddleware],
        ["invalid/id"],
        {},
        Array.from({ length: 65 }, (_, index) => `example.${index}`),
    ];
    for (const middleware of invalid) {
        const response = await app.request("/api/admin/sources", {
            method: "POST",
            body: JSON.stringify(sourceInput(middleware)),
        });
        assertEquals(response.status, 400);
        assertEquals(
            (await response.json()).error.code,
            "invalid_source_middleware",
        );
        assertEquals(await sourceStore.get([sourceId]), null);
        assertEquals(composition.sources.get(sourceId), undefined);
        assertEquals(composition.sourceMiddleware().size, 0);
    }
    const valid = await app.request("/admin/sources", {
        method: "POST",
        body: JSON.stringify(sourceInput([firstMiddleware])),
    });
    assertEquals(valid.status, 201, await valid.clone().text());
    await valid.body?.cancel();
    const saved = await sourceStore.get([sourceId]);
    for (
        const [method, path] of [
            ["PUT", "/admin/source-config"],
            ["POST", "/admin/source-config/validate"],
        ]
    ) {
        const misplaced = await app.request(path!, {
            method,
            body: JSON.stringify({ sourceId, config: { middleware: [] } }),
        });
        assertEquals(misplaced.status, 400);
        assert(
            (await misplaced.json()).error.message.includes("顶层 middleware"),
        );
        assertEquals(await sourceStore.get([sourceId]), saved);
    }
    for (const middleware of invalid) {
        const response = await app.request(
            `/api/admin/sources?id=${sourceId}`,
            {
                method: "PATCH",
                body: JSON.stringify({ middleware }),
            },
        );
        assertEquals(response.status, 400);
        assertEquals(
            (await response.json()).error.code,
            "invalid_source_middleware",
        );
        assertEquals(await sourceStore.get([sourceId]), saved);
        assertEquals(composition.sourceMiddleware().get(sourceId), [
            firstMiddleware,
        ]);
    }
});

Deno.test("directory middleware and source bindings execute through the shared server and follow live management switches", async () => {
    await using resources = new AsyncDisposableStack();
    const { load } = await fixture(resources);
    const composition = await load();
    const chatStore = openSqliteChatStore(":memory:");
    resources.defer(() => chatStore.close());
    const app = createServer({
        protocols: [new OpenAIProtocolPlugin()],
        sourceRegistry: composition.sources,
        middleware: composition.middleware,
        sourceMiddleware: composition.sourceMiddleware,
        adminCatalog: composition.catalog,
        adminManagement: composition.management,
        chat: { store: chatStore },
    });
    const created = await app.request("/admin/sources", {
        method: "POST",
        body: JSON.stringify({
            ...sourceInput([firstMiddleware, secondMiddleware]),
            modelMap: { public: "upstream" },
        }),
    });
    assertEquals(created.status, 201);
    await created.body?.cancel();
    const infer = async (expected: string, stream: boolean) => {
        const response = await app.request("/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: "public",
                messages: [{ role: "user", content: "hello" }],
                stream,
            }),
        });
        assertEquals(response.status, 200, await response.clone().text());
        if (stream) {
            assert((await response.text()).includes(`"content":"${expected}"`));
        } else {assertEquals(
                (await response.json()).choices[0].message.content,
                expected,
            );}
    };
    await infer("AB", false);
    await infer("AB", true);
    const conversation = chatStore.createConversation(
        "渠道中间件测试",
        new Date().toISOString(),
    );
    const command = {
        type: "send",
        conversationId: conversation.id,
        model: "public",
        text: "hello",
    };
    const chat = await app.request("/api/chat/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
    });
    assertEquals(chat.status, 200, await chat.clone().text());
    assertEquals((await chat.json()).messages.at(-1).text, "AB");

    const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        app.fetch,
    );
    resources.defer(() => server.shutdown());
    const socket = new WebSocket(
        `ws://127.0.0.1:${server.addr.port}/api/chat/socket`,
        ["heimdall-chat"],
    );
    const done = Promise.withResolvers<string>();
    const closed = Promise.withResolvers<void>();
    socket.addEventListener("close", () => closed.resolve());
    resources.defer(async () => {
        socket.close();
        await closed.promise;
    });
    const timeout = setTimeout(
        () => done.reject(new Error("chat socket timed out")),
        5_000,
    );
    resources.defer(() => clearTimeout(timeout));
    let text = "";
    socket.addEventListener("open", () => socket.send(JSON.stringify(command)));
    socket.addEventListener(
        "error",
        () => done.reject(new Error("chat socket failed")),
    );
    socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "delta") text += message.text;
        if (message.type === "error") {
            done.reject(new Error(JSON.stringify(message)));
        }
        if (message.type === "done") done.resolve(text);
    });
    assertEquals(await done.promise, "AB");
    await composition.management.setPluginEnabled!(
        context,
        firstMiddleware,
        false,
    );
    await infer("B", false);
    await composition.management.setPluginEnabled!(
        context,
        firstMiddleware,
        true,
    );
    await composition.management.updateSource!(context, sourceId, {
        middleware: null,
    });
    await infer("BA", true);
    await composition.management.updateSource!(context, sourceId, {
        middleware: [],
    });
    await infer("empty", false);
});

Deno.test("damaged persisted middleware isolates one source and can be repaired; absent plugins retain bindings", async () => {
    await using resources = new AsyncDisposableStack();
    const { load, store } = await fixture(resources);
    const initial = await load();
    const healthyId = "58a54b69-aea3-4551-9c63-ce7a8c121af8";
    const missingPluginId = "16b99d18-cb15-49ee-aa46-f6b4b4c1b1fa";
    for (const id of [sourceId, healthyId, missingPluginId]) {
        await initial.management.createSource!(context, {
            ...sourceInput([firstMiddleware]),
            id,
            middleware: [firstMiddleware],
        });
    }
    const sourceStore = store.namespace("heimdall", "source-config");
    const damaged = await sourceStore.get<StoredSourceConfig>([sourceId]);
    assertExists(damaged);
    await sourceStore.set([sourceId], {
        ...damaged.value,
        middleware: "broken",
    });
    const missing = await sourceStore.get<StoredSourceConfig>([
        missingPluginId,
    ]);
    assertExists(missing);
    await sourceStore.set([missingPluginId], {
        ...missing.value,
        middleware: ["example.middleware.removed"],
    });

    const composition = await load();
    const app = appFor(composition);
    assertEquals(composition.sources.get(sourceId), undefined);
    assertExists(composition.sources.get(healthyId));
    assertExists(composition.sources.get(missingPluginId));
    assertEquals(composition.sourceMiddleware().has(sourceId), false);
    assertEquals(composition.sourceMiddleware().get(missingPluginId), [
        "example.middleware.removed",
    ]);
    const readDamaged = async () => {
        const response = await app.request("/admin/status");
        assertEquals(response.status, 200);
        const status = await response.json();
        return status.sources.find((source: { id: string }) =>
            source.id === sourceId
        );
    };
    const shown = await readDamaged();
    assertEquals(shown.enabled, false);
    assertEquals(shown.middleware, []);
    assert(shown.configurationError.includes("中间件配置损坏"));
    await composition.management.saveSourceConfig!(context, sourceId, {
        endpoint: "updated without clearing host error",
    });
    assertEquals(composition.sources.get(sourceId), undefined);
    assert((await readDamaged()).configurationError.includes("中间件配置损坏"));
    await composition.management.setPluginEnabled!(
        context,
        sourcePluginId,
        false,
    );
    await composition.management.setPluginEnabled!(
        context,
        sourcePluginId,
        true,
    );
    assertEquals(composition.sources.get(sourceId), undefined);
    const repaired = await app.request(`/admin/sources?id=${sourceId}`, {
        method: "PATCH",
        body: JSON.stringify({ middleware: [] }),
    });
    assertEquals(repaired.status, 200);
    const result = (await repaired.json()).source;
    assertEquals(result.enabled, true);
    assertEquals(result.configurationError, undefined);
    assertExists(composition.sources.get(sourceId));
    assertEquals(composition.sourceMiddleware().get(sourceId), []);
    const healthy = await sourceStore.get<StoredSourceConfig>([healthyId]);
    await composition.management.updateSource!(context, healthyId, {
        enabled: false,
    }, healthy?.versionstamp);
    assertEquals(composition.sourceMiddleware().has(healthyId), false);
    assertEquals(
        (await sourceStore.get<StoredSourceConfig>([healthyId]))?.value
            .middleware,
        [firstMiddleware],
    );
    const restarted = await load();
    assertExists(restarted.sources.get(sourceId));
    assertEquals(restarted.sourceMiddleware().get(sourceId), []);
    assertEquals(restarted.sourceMiddleware().has(healthyId), false);
});
