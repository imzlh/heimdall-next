import { assert, assertEquals } from "@std/assert";
import type { InferenceSource, OperationRequest } from "@heimdall/contracts";
import type { StreamEvent, StreamFrame } from "@heimdall/hip";
import { createServer } from "../main.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";
import { createOpenAICompatibleSource } from "../plugins/openai-source/mod.ts";
import { createClockToolPlugin } from "../plugins/tool-clock/mod.ts";

function frame(
    input: OperationRequest,
    seq: number,
    event: StreamEvent,
): StreamFrame {
    return {
        version: 1,
        requestId: input.requestId,
        streamId: `stream:${input.requestId}`,
        seq,
        eventId: `${input.requestId}:${seq}`,
        timestamp: "2026-09-23T00:00:00.000Z",
        event,
    };
}

function mixedSource(): InferenceSource {
    return {
        id: "mixed-parts",
        capabilities: [{ operation: "generation.create", streaming: true }],
        execute(input) {
            return (async function* () {
                const events: StreamEvent[] = [
                    { kind: "run.started", request: input },
                    {
                        kind: "part.started",
                        messageId: "m",
                        part: {
                            id: "r",
                            type: "reasoning",
                            text: "private initial",
                            visibility: "private",
                        },
                    },
                    {
                        kind: "part.delta",
                        messageId: "m",
                        partId: "r",
                        delta: "private delta",
                    },
                    {
                        kind: "part.started",
                        messageId: "m",
                        part: {
                            id: "t",
                            type: "tool_call",
                            callId: "call-1",
                            name: "client_tool",
                            argumentsText: '{"query":',
                        },
                    },
                    {
                        kind: "part.delta",
                        messageId: "m",
                        partId: "t",
                        delta: '"hidden"}',
                    },
                    { kind: "part.completed", messageId: "m", partId: "t" },
                    {
                        kind: "part.started",
                        messageId: "m",
                        part: { id: "p", type: "text", text: "Hello" },
                    },
                    {
                        kind: "part.delta",
                        messageId: "m",
                        partId: "p",
                        delta: " world",
                    },
                    {
                        kind: "part.started",
                        messageId: "m",
                        part: { id: "f", type: "refusal", text: " No" },
                    },
                    {
                        kind: "part.delta",
                        messageId: "m",
                        partId: "f",
                        delta: ".",
                    },
                    { kind: "run.completed" },
                ];
                for (const [index, event] of events.entries()) {
                    yield frame(input, index + 1, event);
                }
            })();
        },
    };
}

Deno.test("chat HTTP and WebSocket expose only visible text and preserve tool calls", async () => {
    const store = openSqliteChatStore(":memory:");
    const app = createServer({ sources: [mixedSource()], chat: { store } });
    const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        app.fetch,
    );
    let socket: ChatSocket | undefined;
    try {
        const conversation = store.createConversation(
            "test",
            new Date().toISOString(),
        );
        const response = await app.request(
            "http://localhost/api/chat/message",
            {
                method: "POST",
                body: JSON.stringify({
                    conversationId: conversation.id,
                    model: "m",
                    text: "ask",
                }),
            },
        );
        assertEquals(response.status, 200);
        const body = await response.json();
        assertEquals(
            body.messages.filter((item: { role: string; callId?: string }) =>
                item.role === "assistant" && item.callId === undefined
            ).map((item: { text: string }) => item.text),
            ["Hello world No."],
        );
        assertEquals(body.toolCalls, [{
            callId: "call-1",
            name: "client_tool",
            argumentsText: '{"query":"hidden"}',
        }]);
        assert(
            !JSON.stringify(store.listMessages(conversation.id)).includes(
                "private",
            ),
        );

        const port = (server.addr as Deno.NetAddr).port;
        socket = await openSocket(`ws://127.0.0.1:${port}/api/chat/socket`);
        socket.socket.send(
            JSON.stringify({
                type: "send",
                conversationId: conversation.id,
                model: "m",
                text: "again",
            }),
        );
        assertEquals((await socket.next()).type, "user");
        const deltas: string[] = [];
        while (true) {
            const event = await socket.next();
            if (event.type === "done") break;
            if (event.type === "delta") deltas.push(event.text as string);
            else assertEquals(event.type, "tool");
        }
        assertEquals(deltas, ["Hello", " world", " No", "."]);
    } finally {
        await socket?.close();
        await server.shutdown();
        store.close();
    }
});

Deno.test("chat executes OpenAI tool-call parts before returning the final answer", async () => {
    const store = openSqliteChatStore(":memory:");
    let calls = 0;
    const source = createOpenAICompatibleSource({
        baseUrl: "https://provider.example/v1",
    }, {
        fetch: (_input, init) => {
            calls++;
            const request = JSON.parse(String(init?.body));
            if (calls === 2) {
                assert(
                    request.messages.some((item: { role: string }) =>
                        item.role === "tool"
                    ),
                );
            }
            return Promise.resolve(
                Response.json({
                    choices: [{
                        message: calls === 1
                            ? {
                                role: "assistant",
                                content: null,
                                reasoning_content: "private thought",
                                tool_calls: [{
                                    id: "clock-1",
                                    type: "function",
                                    function: {
                                        name: "current_time",
                                        arguments: "{}",
                                    },
                                }],
                            }
                            : {
                                role: "assistant",
                                content: "The clock was checked.",
                            },
                        finish_reason: calls === 1 ? "tool_calls" : "stop",
                    }],
                }),
            );
        },
    });
    try {
        const app = createServer({
            sources: [source],
            chat: { store, tools: [createClockToolPlugin()] },
        });
        const conversation = store.createConversation(
            "test",
            new Date().toISOString(),
        );
        const response = await app.request(
            "http://localhost/api/chat/message",
            {
                method: "POST",
                body: JSON.stringify({
                    conversationId: conversation.id,
                    model: "m",
                    text: "what time",
                }),
            },
        );
        assertEquals(response.status, 200);
        assertEquals(calls, 2);
        const body = await response.json();
        assertEquals(body.messages.at(-1).text, "The clock was checked.");
        assertEquals(body.toolCalls, []);
        assert(!JSON.stringify(body).includes("private thought"));
    } finally {
        store.close();
    }
});

Deno.test("chat shares the conversation run lock between HTTP and WebSocket", async () => {
    const store = openSqliteChatStore(":memory:");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const app = createServer({
        sources: [{
            id: "blocking",
            capabilities: [{ operation: "generation.create", streaming: true }],
            execute(input) {
                calls++;
                return (async function* () {
                    yield frame(input, 1, {
                        kind: "run.started",
                        request: input,
                    });
                    if (calls === 1) {
                        entered.resolve();
                        await release.promise;
                    }
                    yield frame(input, 2, {
                        kind: "part.delta",
                        messageId: "m",
                        partId: "p",
                        delta: "reply",
                    });
                    yield frame(input, 3, { kind: "run.completed" });
                })();
            },
        }],
        chat: { store },
    });
    const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        app.fetch,
    );
    let socket: ChatSocket | undefined;
    let pending: Promise<Response> | undefined;
    try {
        const conversation = store.createConversation(
            "test",
            new Date().toISOString(),
        );
        const payload = {
            conversationId: conversation.id,
            model: "m",
            text: "original",
        };
        pending = Promise.resolve(
            app.request("http://localhost/api/chat/message", {
                method: "POST",
                body: JSON.stringify(payload),
            }),
        );
        await entered.promise;
        await assertConversationMutationBusy(app, conversation.id);
        for (const route of ["message", "regenerate"]) {
            const rejected = await app.request(
                `http://localhost/api/chat/${route}`,
                { method: "POST", body: JSON.stringify(payload) },
            );
            assertEquals(rejected.status, 409);
            assertEquals((await rejected.json()).error.code, "run_in_progress");
        }
        socket = await openSocket(
            `ws://127.0.0.1:${
                (server.addr as Deno.NetAddr).port
            }/api/chat/socket`,
        );
        socket.socket.send(JSON.stringify({ ...payload, type: "regenerate" }));
        const rejected = await socket.next();
        assertEquals(rejected.type, "error");
        assertEquals(rejected.status, 409);
        assertEquals(
            store.listMessages(conversation.id).map((item) => item.text),
            ["original"],
        );
        assertEquals(calls, 1);
        release.resolve();
        assertEquals((await pending).status, 200);
        const again = await app.request(
            "http://localhost/api/chat/regenerate",
            { method: "POST", body: JSON.stringify(payload) },
        );
        assertEquals(again.status, 200);
        assertEquals(calls, 2);
        assertEquals(
            store.listMessages(conversation.id).map((item) => item.text),
            ["original", "reply"],
        );
    } finally {
        release.resolve();
        await pending;
        await socket?.close();
        await server.shutdown();
        store.close();
    }
});

Deno.test("closing a chat socket cancels generation and releases its conversation", async () => {
    const store = openSqliteChatStore(":memory:");
    const settled = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const serverAbort = new AbortController();
    let cancelled = false;
    let calls = 0;
    const app = createServer({
        sources: [{
            id: "cancellable",
            capabilities: [{ operation: "generation.create", streaming: true }],
            execute(input, context) {
                const first = ++calls === 1;
                return (async function* () {
                    try {
                        yield frame(input, 1, {
                            kind: "run.started",
                            request: input,
                        });
                        yield frame(input, 2, {
                            kind: "part.delta",
                            messageId: "m",
                            partId: "p",
                            delta: "partial",
                        });
                        if (first) {
                            const aborted = Promise.withResolvers<void>();
                            const onAbort = () => aborted.resolve();
                            context.signal.addEventListener("abort", onAbort, {
                                once: true,
                            });
                            if (context.signal.aborted) onAbort();
                            try {
                                // Cleanup can finish the source even if cancellation regresses.
                                await Promise.race([
                                    aborted.promise,
                                    release.promise,
                                ]);
                            } finally {
                                context.signal.removeEventListener(
                                    "abort",
                                    onAbort,
                                );
                            }
                            cancelled = context.signal.aborted;
                            yield frame(input, 3, { kind: "run.cancelled" });
                        } else yield frame(input, 3, { kind: "run.completed" });
                    } finally {
                        // The consumer closes the iterator at its terminal frame;
                        // ordinary code after that yield is not guaranteed to run.
                        if (first) settled.resolve();
                    }
                })();
            },
        }],
        chat: { store },
    });
    const server = Deno.serve(
        {
            hostname: "127.0.0.1",
            port: 0,
            signal: serverAbort.signal,
            onListen() {},
        },
        app.fetch,
    );
    let socket: ChatSocket | undefined;
    try {
        const conversation = store.createConversation(
            "test",
            new Date().toISOString(),
        );
        socket = await openSocket(
            `ws://127.0.0.1:${
                (server.addr as Deno.NetAddr).port
            }/api/chat/socket`,
        );
        socket.socket.send(
            JSON.stringify({
                type: "send",
                conversationId: conversation.id,
                model: "m",
                text: "ask",
            }),
        );
        assertEquals((await socket.next()).type, "user");
        assertEquals((await socket.next()).type, "delta");
        await assertConversationMutationBusy(app, conversation.id);
        await socket.close();
        await within(settled.promise, "cancelled source cleanup");
        assert(cancelled);
        // Source cleanup precedes the host's persistence and lock release.
        // A successful public request is the observable completion boundary.
        const deadline = Date.now() + WAIT_TIMEOUT_MS;
        let again: Response;
        while (true) {
            again = await within(
                Promise.resolve(app.request(
                    "http://localhost/api/chat/regenerate",
                    {
                        method: "POST",
                        body: JSON.stringify({
                            conversationId: conversation.id,
                            model: "m",
                        }),
                    },
                )),
                "regeneration after cancellation",
            );
            if (again.status !== 409) break;
            assertEquals((await again.json()).error.code, "run_in_progress");
            assert(Date.now() < deadline, "conversation lock was not released");
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assertEquals(again.status, 200);
        await again.json();
        assertEquals(calls, 2);
        assertEquals(
            store.listMessages(conversation.id).map((item) => item.text),
            ["ask", "partial"],
        );
    } finally {
        release.resolve();
        try {
            await socket?.close();
        } finally {
            serverAbort.abort();
            try {
                await within(server.finished, "chat server shutdown");
            } finally {
                store.close();
            }
        }
    }
});

const WAIT_TIMEOUT_MS = 5_000;

async function assertConversationMutationBusy(
    app: ReturnType<typeof createServer>,
    conversationId: string,
): Promise<void> {
    for (const path of ["/api/chat", "/admin/chat/api"]) {
        for (const method of ["PATCH", "DELETE"]) {
            const response = await app.request(
                `http://localhost${path}/conversation?id=${conversationId}`,
                {
                    method,
                    headers: { origin: "http://localhost" },
                    body: JSON.stringify({ title: "不应修改生成中的对话" }),
                },
            );
            assertEquals(response.status, 409);
            assertEquals((await response.json()).error.code, "run_in_progress");
        }
    }
}

async function within<T>(promise: Promise<T>, operation: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${operation} timed out`)),
                    WAIT_TIMEOUT_MS,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

interface ChatSocket {
    socket: WebSocket;
    next(): Promise<Record<string, unknown>>;
    close(): Promise<void>;
}

async function openSocket(url: string): Promise<ChatSocket> {
    const socket = new WebSocket(url, ["heimdall-chat"]);
    const messages: Record<string, unknown>[] = [];
    let waiting: ((message: Record<string, unknown>) => void) | undefined;
    const closed = Promise.withResolvers<void>();
    socket.addEventListener("close", () => closed.resolve());
    socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (waiting === undefined) messages.push(message);
        else {
            const resolve = waiting;
            waiting = undefined;
            resolve(message);
        }
    });
    await within(
        new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve(), { once: true });
            socket.addEventListener(
                "error",
                () => reject(new Error("WebSocket connection failed")),
                { once: true },
            );
        }),
        "WebSocket opening",
    ).catch((error) => {
        socket.close();
        throw error;
    });
    assertEquals(socket.protocol, "heimdall-chat");
    return {
        socket,
        next() {
            const message = messages.shift();
            return message === undefined
                ? within(
                    new Promise<Record<string, unknown>>((resolve) => {
                        waiting = resolve;
                    }),
                    "WebSocket message",
                )
                : Promise.resolve(message);
        },
        async close() {
            if (socket.readyState < WebSocket.CLOSING) socket.close();
            await within(closed.promise, "WebSocket closing");
        },
    };
}
