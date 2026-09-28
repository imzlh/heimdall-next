import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type {
    GenerationRequest,
    InferenceSource,
    MiddlewarePlugin,
    OperationRequest,
    RequestContext,
    StreamEvent,
    StreamFrame,
    ToolExecutionContext,
} from "@heimdall/contracts";
import { MiddlewareRegistry } from "@heimdall/kernel";
import { createServer } from "../main.ts";
import { createRequestLifecycle } from "@heimdall/core/composition/request-lifecycle.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";
import { openSqliteRequestStore } from "@heimdall/core/storage/sqlite-requests.ts";
import { createClockToolPlugin } from "../plugins/tool-clock/mod.ts";

const timestamp = "2026-09-27T00:00:00.000Z";

function frame(
    request: OperationRequest,
    seq: number,
    event: StreamEvent,
): StreamFrame {
    return {
        version: 1,
        requestId: request.requestId,
        streamId: `stream:${request.requestId}`,
        seq,
        eventId: `${request.requestId}:${seq}`,
        timestamp,
        event,
    };
}

function textEvent(text: string): StreamEvent {
    return { kind: "part.delta", messageId: "m", partId: "p", delta: text };
}

function rewritingMiddleware(
    requests: RequestContext[],
    responses: RequestContext[],
): MiddlewarePlugin {
    return {
        manifest: {
            id: "test.chat.middleware",
            version: "1.0.0",
            apiVersion: "1",
            name: "Chat middleware fixture",
            kind: "middleware",
            trust: "trusted",
        },
        transformRequest(input, context) {
            assertEquals(context.request.requestId, input.requestId);
            assertEquals(context.request.signal.aborted, false);
            requests.push(context.request);
            return {
                ...input,
                traits: { ...input.traits, model: "routed-model" },
                payload: {
                    ...input.payload as GenerationRequest,
                    model: "routed-model",
                },
            };
        },
        transformFrames(input, context, frames) {
            assertEquals(context.request.requestId, input.requestId);
            responses.push(context.request);
            return (async function* () {
                for await (const item of frames) {
                    yield item.event.kind === "part.delta" &&
                            typeof item.event.delta === "string"
                        ? {
                            ...item,
                            event: {
                                ...item.event,
                                delta: item.event.delta.toUpperCase(),
                            },
                        }
                        : item;
                }
            })();
        },
    };
}

for (const transport of ["http", "websocket"] as const) {
    Deno.test(`chat ${transport} runs request/frame middleware for tools and titles with matching context and journal ids`, async () => {
        const store = openSqliteChatStore(":memory:");
        const journal = openSqliteRequestStore(":memory:");
        const requests: RequestContext[] = [];
        const responses: RequestContext[] = [];
        const executed: OperationRequest[] = [];
        const toolContexts: ToolExecutionContext["request"][] = [];
        const clock = createClockToolPlugin({ now: () => new Date(timestamp) });
        const middleware = new MiddlewareRegistry();
        middleware.register(rewritingMiddleware(requests, responses));
        const source: InferenceSource = {
            id: "chat-middleware-source",
            capabilities: [{
                operation: "generation.create",
                models: ["routed-model"],
                streaming: true,
            }],
            async *execute(input, context) {
                executed.push(input);
                const payload = input.payload as GenerationRequest;
                assertEquals(payload.model, "routed-model");
                assertEquals(context.signal, requests.at(-1)?.signal);
                assertEquals(context.metadata, requests.at(-1)?.metadata);
                assertEquals(input.metadata, context.metadata);
                assertEquals(payload.metadata, undefined);
                const title = input.requestId.endsWith(":title");
                const toolRound = input.requestId.endsWith(":tool:1");
                if (toolRound) {
                    assert(
                        payload.messages.some((message) =>
                            message.parts.some((part) =>
                                part.type === "tool_result" &&
                                String(part.result).includes(timestamp)
                            )
                        ),
                    );
                }
                if (!title) {
                    assert(
                        payload.tools?.some((tool) =>
                            tool.name === "current_time"
                        ),
                    );
                }
                yield frame(input, 1, { kind: "run.started", request: input });
                yield frame(
                    input,
                    2,
                    title
                        ? textEvent("clock title")
                        : toolRound
                        ? textEvent("clock answer")
                        : {
                            kind: "tool.call",
                            messageId: "m",
                            callId: "clock-call",
                            name: "current_time",
                            argumentsText: "{}",
                        },
                );
                yield frame(input, 3, { kind: "run.completed" });
            },
        };
        const app = createServer({
            sources: [source],
            middleware,
            lifecycle: createRequestLifecycle(journal),
            chat: {
                store,
                tools: [
                    {
                        ...clock,
                        tools: clock.tools.map((tool) => ({
                            ...tool,
                            execute(call, context) {
                                toolContexts.push(context.request);
                                return tool.execute(call, context);
                            },
                        })),
                    },
                ],
                titleModel: () => "title-client-model",
            },
        });
        let server: Deno.HttpServer<Deno.NetAddr> | undefined;
        let socket: TestSocket | undefined;
        try {
            const conversation = store.createConversation("新对话", timestamp);
            const command = {
                type: "send",
                conversationId: conversation.id,
                model: "client-model",
                text: "what time is it",
            };
            let requestId: string;
            let path: string;
            if (transport === "http") {
                // The authenticated admin alias must retain its actual route.
                path = "/admin/chat/api/message";
                const result = await app.request(`http://localhost${path}`, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        origin: "http://localhost",
                        "x-request-id": "chat-http-middleware",
                        "x-chat-test": "request-preserved",
                    },
                    body: JSON.stringify(command),
                });
                assertEquals(result.status, 200);
                const body = await result.json();
                assertEquals(body.messages.at(-1).text, "CLOCK ANSWER");
                assertEquals(body.conversation.title, "CLOCK TITLE");
                requestId = result.headers.get("x-heimdall-request-id")!;
                assertEquals(
                    requests[0]?.request.headers.get("x-chat-test"),
                    "request-preserved",
                );
            } else {
                path = "/api/chat/socket";
                server = Deno.serve(
                    { hostname: "127.0.0.1", port: 0, onListen() {} },
                    app.fetch,
                );
                socket = await openSocket(
                    `ws://127.0.0.1:${server.addr.port}${path}`,
                );
                socket.send(command);
                const events = await socket.until("done");
                assertEquals(
                    events.filter((event) => event.type === "delta").map((
                        event,
                    ) => event.text),
                    ["CLOCK ANSWER"],
                );
                requestId = requests[0]!.requestId;
                assertEquals(
                    store.getConversation(conversation.id)?.title,
                    "CLOCK TITLE",
                );
                assert(requests[0]?.request.headers.has("sec-websocket-key"));
                assertNotEquals(
                    requests[0]?.signal,
                    requests[0]?.request.signal,
                );
            }
            assertEquals(requests.map((context) => context.requestId), [
                requestId,
                `${requestId}:tool:1`,
                `${requestId}:title`,
            ]);
            assertEquals(responses.length, 3);
            assertEquals(
                executed.map((request) => request.requestId),
                requests.map((context) => context.requestId),
            );
            for (const [index, context] of requests.entries()) {
                assertEquals(responses[index], context);
                assertEquals(context.request, requests[0]!.request);
                assertEquals(context.signal, requests[0]!.signal);
                assertEquals(context.route, {
                    method: transport === "http" ? "POST" : "GET",
                    path,
                    operation: "generation.create",
                });
                assertEquals(context.metadata, {
                    transport,
                    conversationId: conversation.id,
                    sessionId: conversation.id,
                    traceId: requestId,
                    purpose: index === 2 ? "chat.title" : "chat",
                    command: "send",
                });
                assertEquals(
                    journal.getRequest(context.requestId)?.metadata,
                    context.metadata,
                );
                assertEquals(
                    journal.getRequest(context.requestId)?.status,
                    "completed",
                );
                assertEquals(
                    journal.getRequest(context.requestId)?.model,
                    "routed-model",
                );
                assertEquals(journal.listFrames(context.requestId).length, 3);
                assert(journal.getUsage(context.requestId));
            }
            assertEquals<unknown>(
                journal.listFrames(`${requestId}:tool:1`)[1]?.event,
                textEvent("CLOCK ANSWER"),
            );
            assertEquals(toolContexts, [{
                requestId,
                metadata: requests[0]!.metadata,
            }]);
            // Plugin context contains no non-serializable transport state or credentials.
            assertEquals(
                JSON.parse(JSON.stringify(toolContexts)),
                toolContexts,
            );
        } finally {
            await socket?.close();
            await server?.shutdown();
            journal.close();
            store.close();
        }
    });

    Deno.test(`chat ${transport} keeps canonical plugin identity for regeneration, continuation and user edits`, async () => {
        const store = openSqliteChatStore(":memory:");
        const requests: RequestContext[] = [];
        const middleware = new MiddlewareRegistry();
        middleware.register(rewritingMiddleware(requests, []));
        const app = createServer({
            middleware,
            sources: [{
                id: "branch-context-source",
                capabilities: [{
                    operation: "generation.create",
                    streaming: true,
                }],
                async *execute(input, context) {
                    assertEquals(context.metadata, requests.at(-1)?.metadata);
                    assertEquals(input.metadata, context.metadata);
                    assertEquals(
                        (input.payload as GenerationRequest).metadata,
                        undefined,
                    );
                    yield frame(input, 1, {
                        kind: "run.started",
                        request: input,
                    });
                    yield frame(input, 2, textEvent("answer"));
                    yield frame(input, 3, { kind: "run.completed" });
                },
            }],
            chat: { store },
        });
        let server: Deno.HttpServer<Deno.NetAddr> | undefined;
        let socket: TestSocket | undefined;
        try {
            const conversation = store.createConversation(
                "existing",
                timestamp,
            );
            if (transport === "websocket") {
                server = Deno.serve(
                    { hostname: "127.0.0.1", port: 0, onListen() {} },
                    app.fetch,
                );
                socket = await openSocket(
                    `ws://127.0.0.1:${server.addr.port}/api/chat/socket`,
                );
            }
            for (
                const type of [
                    "send",
                    "regenerate",
                    "continue",
                    "edit",
                ] as const
            ) {
                const history = store.listMessages(conversation.id);
                const command = {
                    type,
                    conversationId: conversation.id,
                    model: "m",
                    ...(type === "send" || type === "edit"
                        ? { text: "question" }
                        : {}),
                    ...(type === "edit"
                        ? { messageId: history[0]!.id }
                        : type !== "send"
                        ? { messageId: history.at(-1)!.id }
                        : {}),
                };
                if (socket) {
                    socket.send(command);
                    await socket.until("done");
                } else {
                    const response = await app.request(
                        `http://localhost/api/chat/${
                            type === "send" || type === "edit"
                                ? "message"
                                : type
                        }`,
                        {
                            method: type === "edit" ? "PATCH" : "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify(command),
                        },
                    );
                    assertEquals(response.status, 200, await response.text());
                }
                const context = requests.at(-1)!;
                assertEquals(context.metadata, {
                    transport,
                    conversationId: conversation.id,
                    sessionId: conversation.id,
                    traceId: context.requestId,
                    purpose: "chat",
                    command: type,
                });
            }
            assertEquals(requests.length, 4);
            assertEquals(
                new Set(requests.map((request) => request.requestId)).size,
                4,
            );
        } finally {
            await socket?.close();
            await server?.shutdown();
            store.close();
        }
    });
}

Deno.test("socket stop aborts middleware context and a later command gets a fresh signal across live switches", async () => {
    const store = openSqliteChatStore(":memory:");
    const requests: RequestContext[] = [];
    const middleware = new MiddlewareRegistry();
    const plugin = rewritingMiddleware(requests, []);
    middleware.register(plugin);
    let executions = 0;
    const app = createServer({
        middleware,
        sources: [{
            id: "chat-stop-source",
            capabilities: [{ operation: "generation.create", streaming: true }],
            async *execute(input, context) {
                executions++;
                yield frame(input, 1, { kind: "run.started", request: input });
                yield frame(input, 2, textEvent("answer"));
                if (executions === 1) {
                    await new Promise<void>((_resolve, reject) => {
                        if (context.signal.aborted) {
                            reject(context.signal.reason);
                        } else {context.signal.addEventListener(
                                "abort",
                                () => reject(context.signal.reason),
                                { once: true },
                            );}
                    });
                }
                yield frame(input, 3, { kind: "run.completed" });
            },
        }],
        chat: { store },
    });
    const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        app.fetch,
    );
    let socket: TestSocket | undefined;
    try {
        const conversation = store.createConversation("existing", timestamp);
        const command = {
            type: "send",
            conversationId: conversation.id,
            model: "m",
            text: "question",
        };
        socket = await openSocket(
            `ws://127.0.0.1:${server.addr.port}/api/chat/socket`,
        );
        socket.send(command);
        await socket.until("delta");
        socket.send({ type: "stop" });
        await socket.until("stopped");
        assertEquals(requests.length, 1);
        assertEquals(requests[0]?.signal.aborted, true);
        assertEquals(requests[0]?.request.signal.aborted, false);
        middleware.unregister(plugin.manifest.id);
        socket.send(command);
        const disabled = await socket.until("done");
        assertEquals(
            disabled.find((event) => event.type === "delta")?.text,
            "answer",
        );
        assertEquals(requests.length, 1);
        middleware.register(plugin);
        socket.send(command);
        const enabled = await socket.until("done");
        assertEquals(
            enabled.find((event) => event.type === "delta")?.text,
            "ANSWER",
        );
        assertEquals(requests.length, 2);
        assertNotEquals(requests[0]?.requestId, requests[1]?.requestId);
        assertNotEquals(requests[0]?.signal, requests[1]?.signal);
        assertEquals(requests[1]?.signal.aborted, false);
        assertEquals(requests[0]?.request, requests[1]?.request);
    } finally {
        await socket?.close();
        await server.shutdown();
        store.close();
    }
});

interface TestSocket {
    send(command: unknown): void;
    until(type: string): Promise<Record<string, unknown>[]>;
    close(): Promise<void>;
}

async function within<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error("socket timed out")),
                    5_000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function openSocket(url: string): Promise<TestSocket> {
    const socket = new WebSocket(url, ["heimdall-chat"]);
    const queue: Record<string, unknown>[] = [];
    let pending: ((message: Record<string, unknown>) => void) | undefined;
    const closed = Promise.withResolvers<void>();
    socket.addEventListener("close", () => closed.resolve());
    socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (pending) {
            const resolve = pending;
            pending = undefined;
            resolve(message);
        } else queue.push(message);
    });
    try {
        await within(
            new Promise<void>((resolve, reject) => {
                socket.addEventListener("open", () => resolve(), {
                    once: true,
                });
                socket.addEventListener(
                    "error",
                    () => reject(new Error("socket failed")),
                    {
                        once: true,
                    },
                );
            }),
        );
    } catch (error) {
        socket.close();
        throw error;
    }
    return {
        send: (command) => socket.send(JSON.stringify(command)),
        async until(type) {
            const result: Record<string, unknown>[] = [];
            while (true) {
                const message = queue.shift() ?? await within(
                    new Promise<Record<string, unknown>>((resolve) =>
                        pending = resolve
                    ),
                );
                assertNotEquals(message.type, "error", JSON.stringify(message));
                result.push(message);
                if (message.type === type) return result;
            }
        },
        async close() {
            if (socket.readyState < WebSocket.CLOSING) socket.close();
            await within(closed.promise);
        },
    };
}
