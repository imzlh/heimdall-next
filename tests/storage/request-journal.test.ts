import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type { GenerationRequest, InferenceSource } from "@heimdall/contracts";
import type { OperationRequest, StreamEvent, StreamFrame } from "@heimdall/hip";
import { KernelRuntime, SourceRegistry } from "@heimdall/kernel";
import { StorageConflictError, StorageNotFoundError } from "@heimdall/storage";
import { createServer } from "../../main.ts";
import { createRequestLifecycle } from "@heimdall/core/composition/request-lifecycle.ts";
import { openSqliteRequestStore } from "@heimdall/core/storage/sqlite-requests.ts";

function requestFor(requestId: string): OperationRequest<GenerationRequest> {
    return {
        version: 1,
        requestId,
        operation: "generation.create",
        payload: {
            messages: [],
            model: "model-a",
            stream: true,
        },
        traits: { model: "model-a", streaming: true },
        metadata: {
            apiKey: "sk-test-secret",
            protocolPluginId: "openai-protocol",
            upstreamPluginId: "openai-compatible",
            note: "keep",
        },
    };
}

function frame(
    requestId: string,
    seq: number,
    event: StreamEvent,
): StreamFrame {
    const value: StreamFrame = {
        version: 1,
        streamId: "run:" + requestId,
        requestId,
        seq,
        eventId: `${requestId}:${seq}`,
        timestamp: "2026-09-22T00:00:0" + String(seq) + ".000Z",
        event,
    };
    if (seq !== 1) return value;
    return {
        ...value,
        extensions: { apiKey: "sk-frame", dataBase64: "aaaa", note: "visible" },
    };
}

Deno.test("SQLite request journal records frames, usage, and list cursors", () => {
    const directory = Deno.makeTempDirSync({ prefix: "heimdall-requests-" });
    const store = openSqliteRequestStore(`${directory}/requests.sqlite`);
    try {
        store.createRequest({
            requestId: "req-b",
            receivedAt: "2026-09-22T00:00:02.000Z",
            operation: "generation.create",
            request: { ok: true },
        });
        store.createRequest({
            requestId: "req-a",
            receivedAt: "2026-09-22T00:00:01.000Z",
            operation: "generation.create",
            request: { ok: true },
        });
        assertThrows(
            () =>
                store.createRequest({
                    requestId: "req-a",
                    receivedAt: "2026-09-22T00:00:01.000Z",
                    request: { ok: true },
                }),
            StorageConflictError,
        );
        assertEquals(
            store.appendFrame({
                version: 1,
                streamId: "run:req-a",
                requestId: "req-a",
                seq: 1,
                eventId: "req-a:1",
                timestamp: "2026-09-22T00:00:01.000Z",
                event: { kind: "run.started" },
            }),
            true,
        );
        assertEquals(
            store.appendFrame({
                version: 1,
                streamId: "run:req-a",
                requestId: "req-a",
                seq: 1,
                eventId: "req-a:1",
                timestamp: "2026-09-22T00:00:01.000Z",
                event: { kind: "run.started" },
            }),
            false,
        );
        assertThrows(
            () =>
                store.appendFrame({
                    version: 1,
                    streamId: "run:missing",
                    requestId: "missing",
                    seq: 1,
                    eventId: "missing:1",
                    timestamp: "2026-09-22T00:00:01.000Z",
                    event: { kind: "run.started" },
                }),
            StorageNotFoundError,
        );
        store.putUsage({
            requestId: "req-a",
            inputTokens: 3,
            outputTokens: 5,
            totalTokens: 8,
            updatedAt: "2026-09-22T00:00:03.000Z",
        });
        store.putUsage({
            requestId: "req-a",
            inputTokens: 4,
            outputTokens: 6,
            totalTokens: 10,
            updatedAt: "2026-09-22T00:00:04.000Z",
        });
        store.updateRequest("req-a", {
            status: "completed",
            completedAt: "2026-09-22T00:00:05.000Z",
        });
        assertEquals(store.getRequest("req-a")?.status, "completed");
        assertEquals(store.getUsage("req-a")?.totalTokens, 10);
        assertEquals(
            store.listRequests({
                before: "2026-09-22T00:00:02.000Z",
            }).map((record) => record.requestId),
            ["req-a"],
        );
        assertEquals(store.usageTotals().totalTokens, 10);
        assertEquals(
            store.usageTotals("2026-09-22T00:00:05.000Z").requestCount,
            0,
        );
        assertEquals(store.listFrames("req-a").length, 1);
    } finally {
        store.close();
        Deno.removeSync(directory, { recursive: true });
    }
});

Deno.test("request lifecycle redacts secrets before the kernel stores frames", async () => {
    const directory = Deno.makeTempDirSync({ prefix: "heimdall-lifecycle-" });
    const store = openSqliteRequestStore(`${directory}/requests.sqlite`);
    try {
        const registry = new SourceRegistry();
        const source: InferenceSource = {
            id: "source.test",
            capabilities: [{
                operation: "generation.create",
                models: ["model-a"],
                streaming: true,
            }],
            execute(request) {
                return (async function* () {
                    yield frame(request.requestId, 1, {
                        kind: "run.started",
                        request,
                    });
                    yield frame(request.requestId, 2, {
                        kind: "usage",
                        usage: {
                            inputTokens: 2,
                            outputTokens: 3,
                            totalTokens: 5,
                        },
                    });
                    yield frame(request.requestId, 3, {
                        kind: "run.completed",
                        finishReason: "stop",
                    });
                })();
            },
        };
        registry.register(source);
        const runtime = new KernelRuntime({
            sources: registry,
            lifecycle: createRequestLifecycle(store, {
                now: () => new Date("2026-09-22T01:00:00.000Z"),
            }),
        });
        const request = requestFor("req-1");
        const lifecycle = runtime.createLifecycle(
            request,
            new AbortController().signal,
            {
                streamId: "run:req-1",
                startedAt: "2026-09-22T00:00:00.000Z",
            },
        );
        const execution = await runtime.run(request, lifecycle);
        const seen = [];
        for await (const item of execution.frames) seen.push(item.seq);
        assertEquals(seen, [1, 2, 3]);

        const stored = store.getRequest("req-1");
        assertEquals(stored?.status, "completed");
        assertEquals(stored?.model, "model-a");
        assertEquals(stored?.protocolPluginId, "openai-protocol");
        assertEquals(stored?.upstreamPluginId, "openai-compatible");
        const body = JSON.stringify(stored);
        assertEquals(body.includes("sk-test-secret"), false);
        assertEquals(body.includes("keep"), true);
        const frames = store.listFrames("req-1");
        assertEquals(frames.length, 3);
        const frameBody = JSON.stringify(frames);
        assertEquals(frameBody.includes("sk-test-secret"), false);
        assertEquals(frameBody.includes("sk-frame"), false);
        assertEquals(frameBody.includes("aaaa"), false);
        assertEquals(frameBody.includes("visible"), true);
        assertEquals(store.getUsage("req-1")?.totalTokens, 5);
    } finally {
        store.close();
        Deno.removeSync(directory, { recursive: true });
    }
});

Deno.test("request lifecycle records why a run failed on the request record", async () => {
    const directory = Deno.makeTempDirSync({
        prefix: "heimdall-lifecycle-err-",
    });
    const store = openSqliteRequestStore(`${directory}/requests.sqlite`);
    try {
        const registry = new SourceRegistry();
        const source: InferenceSource = {
            id: "source.broken",
            capabilities: [{
                operation: "generation.create",
                models: ["model-a"],
                streaming: true,
            }],
            execute(request) {
                return (async function* () {
                    // Partial output, then the stream ends with no terminal
                    // event — the runtime must surface the reason itself.
                    yield frame(request.requestId, 1, {
                        kind: "run.started",
                        request,
                    });
                })();
            },
        };
        registry.register(source);
        const runtime = new KernelRuntime({
            sources: registry,
            lifecycle: createRequestLifecycle(store, {
                now: () => new Date("2026-09-22T01:00:00.000Z"),
            }),
        });
        const request = requestFor("req-error");
        const lifecycle = runtime.createLifecycle(
            request,
            new AbortController().signal,
            {
                streamId: "run:req-error",
                startedAt: "2026-09-22T00:00:00.000Z",
            },
        );
        const execution = await runtime.run(request, lifecycle);
        const kinds: string[] = [];
        let thrown: unknown;
        try {
            for await (const item of execution.frames) {
                kinds.push(item.event.kind);
            }
        } catch (error) {
            thrown = error;
        }
        // The client both receives a terminal error frame and sees the throw.
        assertEquals(kinds, ["run.started", "run.error"]);
        assertStringIncludes((thrown as Error).message, "terminal event");

        const stored = store.getRequest("req-error");
        assertEquals(stored?.status, "error");
        const recorded = stored?.error as { code?: string; message?: string };
        assertEquals(recorded?.code, "invalid_upstream_response");
        assertStringIncludes(recorded?.message ?? "", "terminal event");
        // The journal keeps the error frame alongside the started frame.
        assertEquals(
            store.listFrames("req-error").map((item) =>
                (item.event as { kind?: string }).kind
            ),
            ["run.started", "run.error"],
        );
    } finally {
        store.close();
        Deno.removeSync(directory, { recursive: true });
    }
});

Deno.test("request lifecycle estimates token usage when a source reports none", async () => {
    const directory = Deno.makeTempDirSync({ prefix: "heimdall-estimate-" });
    const store = openSqliteRequestStore(`${directory}/requests.sqlite`);
    const userText = "Tell me a joke about cats";
    const replyText = "Hello there, friend!";
    try {
        const registry = new SourceRegistry();
        const source: InferenceSource = {
            id: "source.nousage",
            capabilities: [{
                operation: "generation.create",
                models: ["model-a"],
                streaming: true,
            }],
            execute(request) {
                return (async function* () {
                    yield frame(request.requestId, 1, {
                        kind: "run.started",
                        request,
                    });
                    yield frame(request.requestId, 2, {
                        kind: "message.started",
                        message: {
                            id: "m1",
                            role: "assistant",
                            parts: [],
                            status: "in_progress",
                        },
                    });
                    yield frame(request.requestId, 3, {
                        kind: "part.started",
                        messageId: "m1",
                        part: { id: "p1", type: "text", text: "" },
                    });
                    yield frame(request.requestId, 4, {
                        kind: "part.delta",
                        messageId: "m1",
                        partId: "p1",
                        delta: replyText,
                    });
                    yield frame(request.requestId, 5, {
                        kind: "part.completed",
                        messageId: "m1",
                        partId: "p1",
                    });
                    yield frame(request.requestId, 6, {
                        kind: "message.completed",
                        messageId: "m1",
                        finishReason: "stop",
                    });
                    yield frame(request.requestId, 7, {
                        kind: "run.completed",
                        finishReason: "stop",
                    });
                })();
            },
        };
        registry.register(source);
        const runtime = new KernelRuntime({
            sources: registry,
            lifecycle: createRequestLifecycle(store, {
                now: () => new Date("2026-09-22T01:00:00.000Z"),
            }),
        });
        const request: OperationRequest<GenerationRequest> = {
            version: 1,
            requestId: "req-est",
            operation: "generation.create",
            payload: {
                model: "model-a",
                stream: true,
                messages: [{
                    id: "u1",
                    role: "user",
                    parts: [{ id: "u1t", type: "text", text: userText }],
                }],
            },
            traits: { model: "model-a", streaming: true },
        };
        const lifecycle = runtime.createLifecycle(
            request,
            new AbortController().signal,
            { streamId: "run:req-est", startedAt: "2026-09-22T00:00:00.000Z" },
        );
        const execution = await runtime.run(request, lifecycle);
        for await (const _ of execution.frames) { /* drain the stream */ }

        const usage = store.getUsage("req-est");
        assertEquals(usage?.inputTokens, Math.ceil(userText.length / 3.5));
        assertEquals(usage?.outputTokens, Math.ceil(replyText.length / 3.5));
        assertEquals(
            usage?.totalTokens,
            (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
        );
        assertEquals(
            (usage?.extensions as { estimated?: boolean })?.estimated,
            true,
        );
        // The first streamed delta (seq 4) stamps time-to-first-token; the
        // empty part.started at seq 3 carries no content and is skipped.
        const firstContent = store.listFrames("req-est").find((item) =>
            item.seq === 4
        );
        assertEquals(
            store.getRequest("req-est")?.firstTokenAt,
            firstContent?.timestamp,
        );
    } finally {
        store.close();
        Deno.removeSync(directory, { recursive: true });
    }
});

Deno.test("request lifecycle counts a tool-call turn's arguments as estimated output", async () => {
    const directory = Deno.makeTempDirSync({ prefix: "heimdall-est-tool-" });
    const store = openSqliteRequestStore(`${directory}/requests.sqlite`);
    const userText = "What's the weather in Paris?";
    const toolName = "get_weather";
    const toolArgs = '{"city":"Paris","unit":"celsius"}';
    try {
        const registry = new SourceRegistry();
        const source: InferenceSource = {
            id: "source.tool",
            capabilities: [{
                operation: "generation.create",
                models: ["model-a"],
                streaming: true,
            }],
            execute(request) {
                return (async function* () {
                    yield frame(request.requestId, 1, {
                        kind: "run.started",
                        request,
                    });
                    yield frame(request.requestId, 2, {
                        kind: "message.started",
                        message: {
                            id: "m1",
                            role: "assistant",
                            parts: [],
                            status: "in_progress",
                        },
                    });
                    yield frame(request.requestId, 3, {
                        kind: "part.started",
                        messageId: "m1",
                        part: {
                            id: "p1",
                            type: "tool_call",
                            callId: "call-1",
                            name: toolName,
                            argumentsText: "",
                            status: "in_progress",
                        },
                    });
                    yield frame(request.requestId, 4, {
                        kind: "part.delta",
                        messageId: "m1",
                        partId: "p1",
                        delta: toolArgs,
                    });
                    yield frame(request.requestId, 5, {
                        kind: "part.completed",
                        messageId: "m1",
                        partId: "p1",
                    });
                    yield frame(request.requestId, 6, {
                        kind: "message.completed",
                        messageId: "m1",
                        finishReason: "tool_calls",
                    });
                    yield frame(request.requestId, 7, {
                        kind: "run.completed",
                        finishReason: "tool_calls",
                    });
                })();
            },
        };
        registry.register(source);
        const runtime = new KernelRuntime({
            sources: registry,
            lifecycle: createRequestLifecycle(store, {
                now: () => new Date("2026-09-27T01:00:00.000Z"),
            }),
        });
        const request: OperationRequest<GenerationRequest> = {
            version: 1,
            requestId: "req-tool",
            operation: "generation.create",
            payload: {
                model: "model-a",
                stream: true,
                messages: [{
                    id: "u1",
                    role: "user",
                    parts: [{ id: "u1t", type: "text", text: userText }],
                }],
            },
            traits: { model: "model-a", streaming: true },
        };
        const lifecycle = runtime.createLifecycle(
            request,
            new AbortController().signal,
            { streamId: "run:req-tool", startedAt: "2026-09-27T00:00:00.000Z" },
        );
        const execution = await runtime.run(request, lifecycle);
        for await (const _ of execution.frames) { /* drain the stream */ }

        // The generated tool name and argument JSON are output tokens; a
        // tool-only turn must not report zero output.
        const usage = store.getUsage("req-tool");
        assertEquals(
            usage?.outputTokens,
            Math.ceil((toolName.length + toolArgs.length) / 3.5),
        );
        assertEquals(usage?.inputTokens, Math.ceil(userText.length / 3.5));
        assertEquals(
            (usage?.extensions as { estimated?: boolean })?.estimated,
            true,
        );
        // A tool call's part.started carries the function name, so it is the
        // first content frame (seq 3) and stamps time-to-first-token.
        const firstTool = store.listFrames("req-tool").find((item) =>
            item.seq === 3
        );
        assertEquals(
            store.getRequest("req-tool")?.firstTokenAt,
            firstTool?.timestamp,
        );
    } finally {
        store.close();
        Deno.removeSync(directory, { recursive: true });
    }
});

Deno.test("admin request routes read the journal without mounting it by default", async () => {
    const directory = Deno.makeTempDirSync({
        prefix: "heimdall-journal-http-",
    });
    const store = openSqliteRequestStore(`${directory}/requests.sqlite`);
    try {
        const absent = createServer();
        assertEquals(
            (await absent.request("http://localhost/admin/requests")).status,
            404,
        );

        const receivedAt = new Date().toISOString();
        store.createRequest({
            requestId: "req-http",
            receivedAt,
            operation: "generation.create",
            model: "model-a",
            request: { messages: [] },
        });
        const app = createServer({
            requestJournal: store,
            statsTimeZone: "UTC",
        });
        const list = await app.request("http://localhost/admin/requests");
        assertEquals(list.status, 200);
        const listed = await list.json();
        assertEquals(listed.requests[0].requestId, "req-http");
        assertEquals(listed.requests[0].request, undefined);

        const detail = await app.request(
            "http://localhost/admin/requests?id=req-http",
        );
        assertEquals(detail.status, 200);
        const detailed = await detail.json();
        assertEquals(detailed.request.requestId, "req-http");
        assertEquals(detailed.frames, []);

        const invalid = await app.request(
            "http://localhost/admin/requests?status=nope",
        );
        assertEquals(invalid.status, 400);
        // Days are natural days in the stats zone; a request counts on the
        // day it was received, together with the usage it reported.
        const today = receivedAt.slice(0, 10);
        store.putUsage({
            requestId: "req-http",
            inputTokens: 4,
            outputTokens: 5,
            totalTokens: 9,
            // Late usage still belongs to the request's received day.
            updatedAt: new Date(Date.parse(receivedAt) + 86_400_000)
                .toISOString(),
        });
        const usage = await app.request("http://localhost/admin/usage");
        const usageBody = await usage.json();
        assertEquals(usageBody.usage.totalTokens, 9);
        assertEquals(usageBody.days.length, 7);
        assertEquals(usageBody.days.at(-1), {
            day: today,
            requestCount: 1,
            inputTokens: 4,
            outputTokens: 5,
            totalTokens: 9,
        });
    } finally {
        store.close();
        Deno.removeSync(directory, { recursive: true });
    }
});

Deno.test("markFirstToken records the earliest content timestamp once", () => {
    const directory = Deno.makeTempDirSync({ prefix: "heimdall-ttft-" });
    const store = openSqliteRequestStore(`${directory}/requests.sqlite`);
    try {
        store.createRequest({
            requestId: "req-ttft",
            receivedAt: "2026-09-27T00:00:00.000Z",
            request: { messages: [] },
        });
        assertEquals(store.getRequest("req-ttft")?.firstTokenAt, undefined);

        store.markFirstToken("req-ttft", "2026-09-27T00:00:02.000Z");
        assertEquals(
            store.getRequest("req-ttft")?.firstTokenAt,
            "2026-09-27T00:00:02.000Z",
        );

        // A later stamp never overwrites the first content frame's moment.
        store.markFirstToken("req-ttft", "2026-09-27T00:00:05.000Z");
        assertEquals(
            store.getRequest("req-ttft")?.firstTokenAt,
            "2026-09-27T00:00:02.000Z",
        );

        // The value survives a status update and rides the list projection.
        store.updateRequest("req-ttft", {
            status: "completed",
            completedAt: "2026-09-27T00:00:09.000Z",
        });
        assertEquals(
            store.listRequests()[0]?.firstTokenAt,
            "2026-09-27T00:00:02.000Z",
        );
    } finally {
        store.close();
        Deno.removeSync(directory, { recursive: true });
    }
});
