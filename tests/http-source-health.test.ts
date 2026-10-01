import { assert, assertEquals, assertExists } from "@std/assert";
import type { SourceDto } from "@heimdall/admin-contracts";
import type { OperationRequest, StreamFrame } from "@heimdall/hip";
import { loadBuiltinComposition } from "@heimdall/core/composition/builtins.ts";
import { createServerApp } from "@heimdall/core/http/app.ts";
import { SystemLog } from "@heimdall/core/observability/system-log.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";

const pluginId = "heimdall.source.openai-compatible";
const sourceId = "5a5e5d42-32c0-42e1-873e-87b079008def";
const backupId = "758719b4-0c5d-4507-9e2b-f2161bc48c6c";
const token = "health-operator-key";
const credentials = "health-private-source-key";
const upstreamDetail = "private-upstream-diagnostic-do-not-publish";
const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
};

Deno.test("both cooldown-reset aliases authenticate before parsing or invoking management", async () => {
    let calls = 0;
    const log = new SystemLog();
    const app = createServerApp({
        adminAuthToken: token,
        systemLog: log,
        adminManagement: {
            clearSourceCooldown: (_context, sourceId) => {
                calls++;
                return { sourceId, cleared: true, health: "ready" };
            },
        },
    });
    for (const prefix of ["/admin", "/api/admin"]) {
        for (const authorization of [undefined, "Bearer incorrect-key"]) {
            const response = await app.request(
                `${prefix}/source-health/reset`,
                {
                    method: "POST",
                    headers: authorization ? { authorization } : {},
                    body: "{invalid private request body",
                },
            );
            assertEquals(response.status, 401);
            assertEquals((await response.json()).error.code, "unauthorized");
        }
    }
    assertEquals(calls, 0);
    assertEquals(log.size, 0);
});

Deno.test("cooldown-reset validates the source id and forwards only that id through either alias", async () => {
    const calls: { id: string; path: string; requestId: string }[] = [];
    const app = createServerApp({
        adminAuthToken: token,
        adminManagement: {
            clearSourceCooldown: (context, id) => {
                calls.push({
                    id,
                    path: new URL(context.request.url).pathname,
                    requestId: context.requestId,
                });
                return { sourceId: id, cleared: false, health: "ready" };
            },
        },
    });
    for (const prefix of ["/admin", "/api/admin"]) {
        for (
            const body of [null, [], 1, {}, { sourceId: " " }, { sourceId: 1 }]
        ) {
            const response = await app.request(
                `${prefix}/source-health/reset`,
                {
                    method: "POST",
                    headers,
                    body: JSON.stringify(body),
                },
            );
            assertEquals(response.status, 400);
            assertEquals((await response.json()).error.code, "invalid_request");
        }
        const malformed = await app.request(`${prefix}/source-health/reset`, {
            method: "POST",
            headers,
            body: "{",
        });
        assertEquals(malformed.status, 400);
        assertEquals((await malformed.json()).error.code, "invalid_json");
    }
    assertEquals(calls, []);
    for (const prefix of ["/admin", "/api/admin"]) {
        const response = await app.request(`${prefix}/source-health/reset`, {
            method: "POST",
            headers: { ...headers, "x-request-id": "health-reset" },
            body: JSON.stringify({
                sourceId: ` ${sourceId} `,
                enabled: true,
                config: { apiKey: "must-not-be-forwarded" },
            }),
        });
        assertEquals(response.status, 200);
        assertEquals(
            response.headers.get("x-heimdall-request-id"),
            "health-reset",
        );
        assertEquals(await response.json(), {
            source: { sourceId, cleared: false, health: "ready" },
        });
    }
    assertEquals(
        calls,
        ["/admin", "/api/admin"].map((prefix) => ({
            id: sourceId,
            path: `${prefix}/source-health/reset`,
            requestId: "health-reset",
        })),
    );
});

Deno.test("cooldown-reset reports an unavailable capability through both aliases", async () => {
    const app = createServerApp({ adminAuthToken: token });
    for (const prefix of ["/admin", "/api/admin"]) {
        const response = await app.request(`${prefix}/source-health/reset`, {
            method: "POST",
            headers,
            body: JSON.stringify({ sourceId }),
        });
        assertEquals(response.status, 501);
        assertEquals(
            (await response.json()).error.code,
            "management_unavailable",
        );
    }
});

async function setup() {
    const resources = new AsyncDisposableStack();
    const kv = await Deno.openKv(":memory:");
    resources.defer(() => kv.close());
    const store = new DenoKvConfigStore(kv);
    const composition = await loadBuiltinComposition({
        configStore: store,
        env: () => undefined,
    });
    resources.defer(() => composition.close());
    const log = new SystemLog();
    const app = createServerApp({
        adminAuthToken: token,
        adminCatalog: composition.catalog,
        adminManagement: composition.management,
        systemLog: log,
    });
    const call = (method: string, path: string, body?: unknown) =>
        app.request(path, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const create = async (id: string, baseUrl: string, priority: number) => {
        const response = await call("POST", "/admin/sources", {
            id,
            name: id === sourceId ? "主渠道" : "备份渠道",
            sourcePluginId: pluginId,
            priority,
            config: { baseUrl, apiKey: credentials },
        });
        assertEquals(response.status, 201);
        await response.body?.cancel();
    };
    const list = async (prefix = "/admin"): Promise<SourceDto[]> => {
        const response = await call("GET", `${prefix}/sources`);
        assertEquals(response.status, 200);
        const body = await response.text();
        assert(!body.includes(credentials));
        assert(!body.includes(upstreamDetail));
        return JSON.parse(body).sources;
    };
    return { resources, store, composition, log, call, create, list };
}

Deno.test("real source failures expose safe cooldown metadata and reset restores routing without rewriting configuration", async () => {
    const fixture = await setup();
    await using _resources = fixture.resources;
    const upstreamCalls: string[] = [];
    const upstream = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        onListen() {},
    }, async (request) => {
        upstreamCalls.push(new URL(request.url).pathname);
        await request.body?.cancel();
        return Response.json({
            error: { message: `${upstreamDetail}: ${credentials}` },
        }, { status: 401 });
    });
    fixture.resources.defer(() => upstream.shutdown());
    const baseUrl = `http://127.0.0.1:${upstream.addr.port}/v1`;
    await fixture.create(sourceId, baseUrl, -10);
    await fixture.create(backupId, baseUrl, 10);
    const sourceStore = fixture.store.namespace("heimdall", "source-config");
    const storedBefore = await sourceStore.get([sourceId]);
    assertExists(storedBefore);
    const input: OperationRequest = {
        version: 1,
        requestId: "real-health-failure",
        operation: "generation.create",
        payload: { model: "model-a", messages: [], stream: false },
        traits: { model: "model-a", streaming: false },
    };
    assertEquals(fixture.composition.sources.select(input).id, sourceId);
    fixture.composition.sources.recordProbe(sourceId, {
        ok: true,
        message: "prior models probe succeeded",
        models: ["remembered-model"],
    });
    const probe = fixture.composition.sources.probeOf(sourceId);
    const logBefore = fixture.log.size;
    for (const prefix of ["/admin", "/api/admin"]) {
        const frames: StreamFrame[] = [];
        for await (
            const frame of fixture.composition.sources.run(input, {
                requestId: input.requestId,
                signal: new AbortController().signal,
                metadata: {},
            })
        ) frames.push(frame);
        const terminal = frames.at(-1)?.event;
        assertEquals(terminal?.kind, "run.error");
        assertEquals(
            terminal?.kind === "run.error" ? terminal.error.status : undefined,
            401,
        );
        const cooled = (await fixture.list(prefix)).find((item) =>
            item.id === sourceId
        )!;
        assertEquals(cooled.health, "cooldown");
        assertEquals(cooled.cooldown?.reason, "authentication");
        assertEquals(Object.keys(cooled.cooldown!).sort(), [
            "reason",
            "startedAt",
            "until",
        ]);
        assertEquals(
            Date.parse(cooled.cooldown!.until) -
                Date.parse(cooled.cooldown!.startedAt),
            300_000,
        );
        assertEquals(fixture.composition.sources.select(input).id, backupId);

        const reset = await fixture.call(
            "POST",
            `${prefix}/source-health/reset`,
            { sourceId },
        );
        assertEquals(reset.status, 200);
        assertEquals(await reset.json(), {
            source: { sourceId, cleared: true, health: "ready" },
        });
        assertEquals(fixture.composition.sources.select(input).id, sourceId);
        assertEquals(fixture.composition.sources.probeOf(sourceId), probe);
        assertEquals(fixture.composition.sources.discoveredModels(sourceId), [
            "remembered-model",
        ]);
        const ready = (await fixture.list(prefix)).find((item) =>
            item.id === sourceId
        )!;
        assertEquals(ready.cooldown, undefined);
        assertEquals([
            ready.enabled,
            ready.instanceEnabled,
            ready.pluginEnabled,
        ], [true, true, true]);
        assertEquals(ready.versionstamp, storedBefore.versionstamp);
        assertEquals(await sourceStore.get([sourceId]), storedBefore);

        const repeated = await fixture.call(
            "POST",
            `${prefix}/source-health/reset`,
            { sourceId },
        );
        assertEquals(repeated.status, 200);
        assertEquals(await repeated.json(), {
            source: { sourceId, cleared: false, health: "ready" },
        });
    }
    assertEquals(upstreamCalls, [
        "/v1/chat/completions",
        "/v1/chat/completions",
    ]);
    const events = fixture.log.list().entries.slice(logBefore);
    assertEquals(events.length, 2);
    assert(
        events.every((entry) =>
            entry.message.includes("手动解除渠道冷却 主渠道")
        ),
    );
    assert(events.every((entry) => entry.detail?.includes("未验证上游")));
    const restarted = await loadBuiltinComposition({
        configStore: fixture.store,
        env: () => undefined,
    });
    fixture.resources.defer(() => restarted.close());
    assertEquals(restarted.sources.healthSnapshot(sourceId), {
        health: "ready",
    });
    assertEquals(restarted.sources.probeOf(sourceId), undefined);
    assertEquals(await sourceStore.get([sourceId]), storedBefore);
});

Deno.test("resetting missing or disabled sources returns 404 and never re-enables persisted switches", async () => {
    const fixture = await setup();
    await using _resources = fixture.resources;
    await fixture.create(sourceId, "https://source.example/v1", 0);
    const sourceStore = fixture.store.namespace("heimdall", "source-config");
    for (const prefix of ["/admin", "/api/admin"]) {
        const response = await fixture.call(
            "POST",
            `${prefix}/source-health/reset`,
            { sourceId: "missing" },
        );
        assertEquals(response.status, 404);
        assertEquals((await response.json()).error.code, "source_not_found");
    }
    for (const disabledBy of ["instance", "plugin"] as const) {
        if (disabledBy === "instance") {
            const response = await fixture.call(
                "PATCH",
                `/admin/sources?id=${sourceId}`,
                { enabled: false },
            );
            assertEquals(response.status, 200);
            await response.body?.cancel();
        } else {
            const response = await fixture.call(
                "PATCH",
                `/admin/sources?id=${sourceId}`,
                { enabled: true },
            );
            assertEquals(response.status, 200);
            await response.body?.cancel();
            await fixture.composition.management.setPluginEnabled?.(
                {
                    request: new Request("http://localhost/admin/plugin"),
                    requestId: "health-disable-plugin",
                },
                pluginId,
                false,
            );
        }
        const storedBefore = await sourceStore.get([sourceId]);
        const catalogBefore = await fixture.list();
        const logBefore = fixture.log.size;
        for (const prefix of ["/admin", "/api/admin"]) {
            const response = await fixture.call(
                "POST",
                `${prefix}/source-health/reset`,
                { sourceId },
            );
            assertEquals(response.status, 404);
            assertEquals(
                (await response.json()).error.code,
                "source_not_found",
            );
        }
        assertEquals(fixture.composition.sources.get(sourceId), undefined);
        assertEquals(await sourceStore.get([sourceId]), storedBefore);
        assertEquals(await fixture.list(), catalogBefore);
        assertEquals(fixture.log.size, logBefore);
        const disabled = catalogBefore.find((item) => item.id === sourceId)!;
        assertEquals(disabled.enabled, false);
        assertEquals(disabled.instanceEnabled, disabledBy !== "instance");
        assertEquals(disabled.pluginEnabled, disabledBy !== "plugin");
    }
});
