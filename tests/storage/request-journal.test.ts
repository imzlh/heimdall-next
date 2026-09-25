import { assertEquals, assertThrows } from "@std/assert";
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
