import {
    assert,
    assertEquals,
    assertExists,
    assertRejects,
    assertStrictEquals,
    assertThrows,
} from "@std/assert";
import type { CreateSourceInput, SourceDto } from "@heimdall/admin-contracts";
import { parseSourceModelMap } from "@heimdall/admin-contracts/source-model-map.ts";
import type {
    InferenceSource,
    OperationRequest,
    SourceContext,
    StreamFrame,
} from "@heimdall/contracts";
import { SourceRegistry } from "@heimdall/kernel";
import { StorageConflictError } from "@heimdall/storage";
import {
    applySourceSettings,
    type StoredSourceConfig,
} from "@heimdall/core/composition/source-records.ts";
import { loadBuiltinComposition } from "@heimdall/core/composition/builtins.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";
import { createServer } from "../main.ts";
import { createAnthropicSource } from "../plugins/anthropic-source/mod.ts";
import { createChatHubSource } from "../plugins/chathub-source/mod.ts";
import { encodeRecord } from "../plugins/chathub-source/protocol/codec.ts";
import type { WebSocketLike } from "../plugins/chathub-source/protocol/types.ts";

const context = {
    request: new Request("http://localhost/admin/sources"),
    requestId: "mapping-admin",
};
const pluginId = "heimdall.source.openai-compatible";
const sourceId = "e3ea7f49-9726-41a4-97c2-c6f00f51bb75";

Deno.test("host model mappings reject ambiguous names, invalid values and executable objects", () => {
    for (
        const invalid of [
            null,
            [],
            { "": "model" },
            { alias: " " },
            { "a b": "target" },
            { alias: "a\u0000b" },
            { alias: 1 },
            { alias: "a".repeat(257) },
            { " alias ": "one", alias: "two" },
            JSON.parse('{"__proto__":"pollution"}'),
            Object.fromEntries(
                Array.from({ length: 257 }, (_, i) => [`a${i}`, "target"]),
            ),
        ]
    ) {
        assertThrows(() => parseSourceModelMap(invalid), TypeError);
    }
    let read = false;
    assertThrows(() =>
        parseSourceModelMap({
            get alias() {
                read = true;
                return "target";
            },
        }), TypeError);
    assertEquals(read, false);
    assertEquals(
        parseSourceModelMap({ " public/model ": " vendor/model:2026 " }),
        { "public/model": "vendor/model:2026" },
    );
});

Deno.test("host mappings preserve source receivers, public request identity and one-hop routing", async () => {
    const requests: OperationRequest[] = [];
    const contexts: SourceContext[] = [];
    class Source implements InferenceSource {
        id = "fixture";
        #hot = 4;
        capabilities = [{
            operation: "generation.create",
            models: ["target", "other"],
            streaming: true,
        }];
        uiSnapshot() {
            return { hot: this.#hot };
        }
        probe() {
            return Promise.resolve({
                ok: true,
                message: "ok",
                models: ["target", "other"],
            });
        }
        async *execute(
            input: OperationRequest,
            ctx: SourceContext,
        ): AsyncIterable<StreamFrame> {
            this.#hot++;
            requests.push(input);
            contexts.push(ctx);
            yield {
                version: 1,
                requestId: input.requestId,
                streamId: "s",
                seq: 1,
                eventId: "e1",
                timestamp: new Date().toISOString(),
                event: { kind: "run.started", request: input },
            };
            yield {
                version: 1,
                requestId: input.requestId,
                streamId: "s",
                seq: 2,
                eventId: "e2",
                timestamp: new Date().toISOString(),
                event: { kind: "run.completed" },
            };
        }
    }
    const provider = new Source();
    const configured = applySourceSettings(provider, {
        priority: 5,
        modelMap: { alias: "target", target: "other" },
    });
    const registry = new SourceRegistry();
    registry.register(configured);
    assertEquals(registry.listModels().map((m) => m.id), ["alias", "target"]);
    const request: OperationRequest = {
        version: 1,
        requestId: "r",
        operation: "generation.create",
        payload: { model: "alias", messages: [] },
        traits: { model: "alias", streaming: true },
        metadata: { trace: "public" },
    };
    const ctx: SourceContext = {
        requestId: "r",
        signal: new AbortController().signal,
        metadata: { trace: "public" },
        conversationId: "conversation",
    };
    const frames = [];
    for await (const frame of registry.run(request, ctx)) frames.push(frame);
    assertEquals(requests[0]?.traits.model, "target");
    assertStrictEquals(requests[0]?.payload, request.payload);
    assertStrictEquals(requests[0]?.metadata, request.metadata);
    assertStrictEquals(contexts[0], ctx);
    assertEquals(frames[0]?.event, { kind: "run.started", request });
    assertEquals(configured.uiSnapshot?.(), { hot: 5 });
    assertEquals((await configured.probe!(ctx.signal)).models, [
        "alias",
        "target",
    ]);
    const updated = applySourceSettings(configured, {
        priority: -2,
        modelMap: { fresh: "other" },
    });
    assertEquals(updated.uiSnapshot?.(), { hot: 5 });
    assertEquals(updated.capabilities[0]?.models, ["fresh", "target"]);
    assertEquals(updated.capabilities[0]?.priority, -2);
    const cleared = applySourceSettings(updated, { modelMap: {}, priority: 1 });
    assertEquals(cleared.capabilities[0]?.models, ["target", "other"]);
});

Deno.test("source mapping metadata drives HTTP execution, public catalog, probes, CAS, edits and restart", async () => {
    await using resources = new AsyncDisposableStack();
    const wireModels: string[] = [];
    const upstream = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        onListen() {},
    }, async (request) => {
        if (request.method === "GET") {
            return Response.json({
                data: [{ id: "upstream-a" }, { id: "unmapped" }],
            });
        }
        const body = await request.json();
        wireModels.push(body.model);
        if (new URL(request.url).pathname.endsWith("/embeddings")) {
            return Response.json({
                object: "list",
                model: body.model,
                data: [{ embedding: [1], index: 0 }],
            });
        }
        if (
            new URL(request.url).pathname.endsWith("/completions") &&
            !new URL(request.url).pathname.endsWith("/chat/completions")
        ) {
            if (body.stream) {
                return new Response(
                    `data: ${
                        JSON.stringify({
                            id: "cmpl",
                            model: body.model,
                            choices: [{
                                index: 0,
                                text: "ok",
                                finish_reason: "stop",
                            }],
                        })
                    }\n\ndata: [DONE]\n\n`,
                    { headers: { "content-type": "text/event-stream" } },
                );
            }
            return Response.json({
                id: "cmpl",
                model: body.model,
                choices: [{ index: 0, text: "ok", finish_reason: "stop" }],
            });
        }
        return Response.json({
            id: "chat",
            model: body.model,
            choices: [{
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
            }],
        });
    });
    resources.defer(() => upstream.shutdown());
    const kv = await Deno.openKv(":memory:");
    resources.defer(() => kv.close());
    const store = new DenoKvConfigStore(kv);
    const options = {
        configStore: store,
        pluginRoot: new URL("../plugins/", import.meta.url),
        env: () => undefined,
    };
    const first = await loadBuiltinComposition(options);
    resources.defer(() => first.close());
    const begun: OperationRequest[] = [];
    const events: StreamFrame[] = [];
    const app = createServer({
        protocols: first.protocols,
        sourceRegistry: first.sources,
        adminCatalog: first.catalog,
        adminManagement: first.management,
        lifecycle: {
            begin(request) {
                begun.push(request);
            },
            append(frame) {
                events.push(frame);
            },
            complete() {},
        },
    });
    const input: CreateSourceInput = {
        id: sourceId,
        name: "映射渠道",
        priority: 7,
        proxy: { mode: "direct" },
        modelMap: { public: "upstream-a" },
        sourcePluginId: pluginId,
        config: {
            baseUrl: `http://127.0.0.1:${upstream.addr.port}/v1`,
            apiKey: "private-key",
        },
    };
    const created = await app.request("/admin/sources", {
        method: "POST",
        body: JSON.stringify(input),
    });
    assertEquals(created.status, 201);
    const initial = await created.json();
    assertEquals(initial.source.modelMap, input.modelMap);
    const scope = store.namespace("heimdall", "source-config");
    const saved = await scope.get<StoredSourceConfig>([sourceId]);
    assertExists(saved);
    assertEquals(saved.value.modelMap, input.modelMap);
    assert(!Object.hasOwn(saved.value.config as object, "modelMap"));
    const execute = async (path: string, payload: object) => {
        const response = await app.request(`/v1/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "public", ...payload }),
        });
        assertEquals(response.status, 200);
        const text = await response.text();
        assert(text.includes('"model":"public"'));
        assert(!text.includes("upstream-a"));
        return text;
    };
    await execute("chat/completions", {
        messages: [{ role: "user", content: "hello" }],
    });
    await execute("embeddings", { input: "hello" });
    await execute("completions", { prompt: "hello" });
    await execute("completions", { prompt: "hello", stream: true });
    assertEquals(wireModels, [
        "upstream-a",
        "upstream-a",
        "upstream-a",
        "upstream-a",
    ]);
    assert(begun.every((request) => request.traits.model === "public"));
    assert(!JSON.stringify(events).includes("upstream-a"));
    const draft = await first.management.probeSourceDraft!(context, input);
    assertEquals(draft.models, ["public", "unmapped"]);
    await first.management.probeSource!(context, sourceId);
    assertEquals(first.sources.listModels().map((m) => m.id), [
        "public",
        "unmapped",
    ]);
    const models = await (await app.request("/v1/models")).json();
    assertEquals(models.data.map((m: { id: string }) => m.id), [
        "public",
        "unmapped",
    ]);
    first.sources.recordProbe(sourceId, {
        ok: false,
        message: "temporarily unavailable",
    });
    const beforeMappingHealth = first.sources.healthSnapshot(sourceId);
    const beforeMappingProbe = first.sources.probeOf(sourceId);
    await first.management.updateSource!(context, sourceId, {
        modelMap: { public: "upstream-b" },
    }, saved.versionstamp);
    assertEquals(first.sources.healthSnapshot(sourceId), beforeMappingHealth);
    assertEquals(first.sources.probeOf(sourceId), beforeMappingProbe);
    assertEquals(first.sources.listModels().map((model) => model.id), [
        "public",
        "unmapped",
        "upstream-a",
    ]);
    await assertRejects(
        async () =>
            await first.management.updateSource!(context, sourceId, {
                modelMap: { wrong: "upstream-a" },
            }, saved.versionstamp),
        StorageConflictError,
    );
    await execute("embeddings", { input: "hello" });
    assertEquals(wireModels.at(-1), "upstream-b");
    const configuration = await first.management.getSourceConfig!(
        context,
        sourceId,
    );
    assertExists(configuration);
    await first.management.saveSourceConfig!(context, sourceId, {
        baseUrl: (input.config as { baseUrl: string }).baseUrl,
    }, configuration.versionstamp);
    const second = await loadBuiltinComposition(options);
    resources.defer(() => second.close());
    const catalog = second.catalog.sources;
    const listed = typeof catalog === "function"
        ? await catalog(context)
        : catalog ?? [];
    const restored: SourceDto | undefined = listed.find((item) =>
        item.id === sourceId
    );
    assertEquals([restored?.modelMap, restored?.priority, restored?.proxy], [
        { public: "upstream-b" },
        7,
        { mode: "direct" },
    ]);
    assertEquals(
        second.sources.select({
            version: 1,
            requestId: "restore",
            operation: "generation.create",
            payload: { messages: [] },
            traits: { model: "public" },
        }).id,
        sourceId,
    );
    await second.management.setPluginEnabled!(context, pluginId, false);
    await second.management.setPluginEnabled!(context, pluginId, true);
    assertEquals(second.sources.listModels().map((m) => m.id), ["public"]);
    await second.management.updateSource!(context, sourceId, { modelMap: {} });
    assertEquals(second.sources.listModels(), []);
});

Deno.test("legacy provider mappings migrate atomically into host metadata before preset or source validation", async () => {
    await using resources = new AsyncDisposableStack();
    const kv = await Deno.openKv(":memory:");
    resources.defer(() => kv.close());
    const store = new DenoKvConfigStore(kv);
    const scope = store.namespace("heimdall", "source-config");
    await scope.set(["legacy"], {
        sourcePluginId: pluginId,
        config: {
            id: "legacy",
            baseUrl: "https://example.test/v1",
            modelMap: { alias: "upstream" },
        },
        name: "旧渠道",
        priority: 9,
        proxy: { mode: "direct" },
        instanceStateVersion: 1,
    });
    const composition = await loadBuiltinComposition({
        configStore: store,
        env: () => undefined,
    });
    resources.defer(() => composition.close());
    const record = await scope.get<StoredSourceConfig>(["legacy"]);
    assertExists(record);
    assertEquals(record.value.modelMap, { alias: "upstream" });
    assert(!Object.hasOwn(record.value.config as object, "modelMap"));
    assertEquals(composition.sources.listModels().map((m) => m.id), ["alias"]);
    await composition.management.createSource!(context, {
        id: sourceId,
        name: "旧预设",
        priority: 1,
        sourcePluginId: pluginId,
        presetId: "heimdall.preset.newapi",
        config: {
            baseUrl: "https://example.test/v1",
            modelMap: { old: "upstream" },
        },
    });
    assertEquals(
        (await scope.get<StoredSourceConfig>([sourceId]))?.value.modelMap,
        { old: "upstream" },
    );
});

Deno.test("model mapping validation runs on both management routes before any mutation", async () => {
    let calls = 0;
    const app = createServer({
        adminManagement: {
            createSource() {
                calls++;
                return { data: {} };
            },
            updateSource() {
                calls++;
                return { data: {} };
            },
        },
    });
    for (
        const modelMap of [
            null,
            [],
            { public: "" },
            { " public ": "one", public: "two" },
            { public: "target\nname" },
            JSON.parse('{"constructor":"upstream"}'),
        ]
    ) {
        for (const prefix of ["/admin", "/api/admin"]) {
            for (const method of ["POST", "PATCH"]) {
                const body = method === "PATCH" ? { modelMap } : {
                    id: sourceId,
                    name: "test",
                    priority: 0,
                    sourcePluginId: pluginId,
                    config: {},
                    modelMap,
                };
                const response = await app.request(
                    `${prefix}/sources?id=${sourceId}`,
                    { method, body: JSON.stringify(body) },
                );
                assertEquals(response.status, 400);
                assertEquals(
                    (await response.json()).error.code,
                    "invalid_source_model_map",
                );
            }
        }
    }
    assertEquals(calls, 0);
});

Deno.test("Anthropic and ChatHub execute host model aliases without changing public HIP requests", async () => {
    let anthropicModel: unknown;
    class Socket extends EventTarget implements WebSocketLike {
        readyState = 0;
        #sends = 0;
        constructor() {
            super();
            queueMicrotask(() => {
                this.readyState = 1;
                this.dispatchEvent(new Event("open"));
            });
        }
        send() {
            const data = ++this.#sends === 1 ? encodeRecord({}) : encodeRecord({
                type: 2,
                item: { messages: [{ author: "bot", text: "answer" }] },
            }) + encodeRecord({ type: 3 });
            queueMicrotask(() =>
                this.dispatchEvent(new MessageEvent("message", { data }))
            );
        }
        close() {
            this.readyState = 3;
        }
    }
    const anthropic = createAnthropicSource({
        baseUrl: "https://anthropic.test",
        apiKey: "key",
    }, {
        fetch: (_url, init) => {
            anthropicModel = JSON.parse(String(init?.body)).model;
            return Promise.resolve(
                Response.json({
                    id: "a",
                    role: "assistant",
                    content: [{ type: "text", text: "answer" }],
                    stop_reason: "end_turn",
                    usage: { input_tokens: 1, output_tokens: 1 },
                }),
            );
        },
    });
    const chathub = createChatHubSource({
        id: "chathub",
        oid: "oid",
        tid: "tid",
        accessToken: "token",
        endpoint: "wss://chathub.invalid/Chathub",
        models: ["provider-model"],
    }, { webSocketFactory: () => new Socket() });
    for (const provider of [anthropic, chathub]) {
        const wrapped = applySourceSettings(provider, {
            modelMap: { public: "provider-model" },
        });
        const request: OperationRequest = {
            version: 1,
            requestId: provider.id,
            operation: "generation.create",
            traits: { model: "public" },
            payload: {
                model: "public",
                messages: [{
                    id: "m",
                    role: "user",
                    parts: [{ id: "p", type: "text", text: "hello" }],
                }],
            },
        };
        const events = [];
        for await (
            const frame of wrapped.execute(request, {
                requestId: request.requestId,
                signal: new AbortController().signal,
                metadata: {},
            })
        ) events.push(frame.event);
        assertEquals(events.at(-1)?.kind, "run.completed");
        assertEquals(events[0], { kind: "run.started", request });
    }
    assertEquals(anthropicModel, "provider-model");
});

Deno.test("failover maps the same public model independently for each source", async () => {
    const models: string[] = [];
    const registry = new SourceRegistry({ sameSourceAttempts: 1 });
    for (const [index, target] of ["vendor-a", "vendor-b"].entries()) {
        const provider: InferenceSource = {
            id: target,
            capabilities: [{
                operation: "generation.create",
                models: [target],
                streaming: true,
            }],
            async *execute(input) {
                models.push(input.traits.model!);
                const base = {
                    version: 1 as const,
                    streamId: target,
                    requestId: input.requestId,
                    timestamp: new Date().toISOString(),
                };
                yield {
                    ...base,
                    seq: 1,
                    eventId: `${target}:1`,
                    event: { kind: "run.started", request: input },
                };
                yield {
                    ...base,
                    seq: 2,
                    eventId: `${target}:2`,
                    event: index === 0
                        ? {
                            kind: "run.error",
                            error: {
                                code: "unavailable",
                                message: "retry",
                                status: 503,
                                retryable: true,
                            },
                        }
                        : { kind: "run.completed" },
                };
            },
        };
        registry.register(
            applySourceSettings(provider, {
                priority: index,
                modelMap: { public: target },
            }),
        );
    }
    const request: OperationRequest = {
        version: 1,
        requestId: "failover",
        operation: "generation.create",
        traits: { model: "public" },
        payload: { messages: [] },
    };
    const events = [];
    for await (
        const frame of registry.run(request, {
            requestId: request.requestId,
            signal: new AbortController().signal,
            metadata: {},
        })
    ) events.push(frame.event);
    assertEquals(models, ["vendor-a", "vendor-b"]);
    assertEquals(events, [{ kind: "run.started", request }, {
        kind: "run.completed",
    }]);
});
