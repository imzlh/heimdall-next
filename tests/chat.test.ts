import { assertEquals } from "@std/assert";
import type { InferenceSource, OperationRequest } from "@heimdall/contracts";
import type { StreamFrame } from "@heimdall/hip";
import { createServer } from "../main.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";
import { createClockToolPlugin } from "../plugins/tool-clock/mod.ts";

function source(): InferenceSource {
    return {
        id: "chat-source",
        capabilities: [{
            operation: "generation.create",
            models: ["chat-model"],
            streaming: false,
        }],
        execute(input) {
            return (async function* (): AsyncIterable<StreamFrame> {
                yield frame(input, 1, { kind: "run.started", request: input });
                yield frame(input, 2, {
                    kind: "part.delta",
                    messageId: "m",
                    partId: "p",
                    delta: "hello from chat",
                });
                yield frame(input, 3, { kind: "run.completed" });
            })();
        },
    };
}

function frame(
    input: OperationRequest,
    seq: number,
    event: StreamFrame["event"],
): StreamFrame {
    return {
        version: 1,
        streamId: "chat-stream",
        requestId: input.requestId,
        seq,
        eventId: `chat-${seq}`,
        timestamp: "2026-09-22T00:00:00.000Z",
        event,
    };
}

Deno.test("chat stores a user turn and the kernel reply", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-chat-" });
    const store = openSqliteChatStore(`${directory}/chat.sqlite`);
    try {
        const app = createServer({
            sources: [source()],
            chat: { store },
        });
        const created = await app.request(
            "http://localhost/api/chat/conversations",
            { method: "POST" },
        );
        assertEquals(created.status, 201);
        const conversationId = (await created.json()).conversation.id as string;

        const missing = await app.request("http://localhost/api/chat/message", {
            method: "POST",
            body: JSON.stringify({
                conversationId: "missing",
                model: "chat-model",
                text: "hi",
            }),
        });
        assertEquals(missing.status, 404);

        const sent = await app.request("http://localhost/api/chat/message", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId,
                model: "chat-model",
                text: "hi there",
            }),
        });
        assertEquals(sent.status, 200);
        const body = await sent.json();
        assertEquals(
            body.messages.map((
                item: { role: string; text: string },
            ) => [item.role, item.text]),
            [
                ["user", "hi there"],
                ["assistant", "hello from chat"],
            ],
        );
        assertEquals(body.conversation.title, "hi there");

        const loaded = await app.request(
            `http://localhost/api/chat/conversation?id=${conversationId}`,
        );
        assertEquals((await loaded.json()).messages.length, 2);
    } finally {
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("chat websocket streams deltas and stop aborts the run", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-chat-ws-" });
    const store = openSqliteChatStore(`${directory}/chat.sqlite`);
    const server = Deno.serve(
        {
            port: 0,
            hostname: "127.0.0.1",
            onListen() {},
        },
        createServer({
            sources: [streamingSource(), stoppingSource()],
            chat: { store },
        }).fetch,
    );
    try {
        const port = (server.addr as Deno.NetAddr).port;
        const created = await fetch(
            `http://127.0.0.1:${port}/api/chat/conversations`,
            {
                method: "POST",
            },
        );
        const conversationId = (await created.json()).conversation.id as string;
        const streamed = await openChatSocket(
            `ws://127.0.0.1:${port}/api/chat/socket`,
        );
        streamed.socket.send(JSON.stringify({
            type: "send",
            conversationId,
            model: "stream-model",
            text: "stream please",
        }));
        assertEquals((await streamed.next()).type, "user");
        assertEquals(await streamed.next(), { type: "delta", text: "hello " });
        assertEquals(await streamed.next(), { type: "delta", text: "socket" });
        assertEquals((await streamed.next()).type, "done");
        streamed.socket.close();

        const stopped = store.createConversation(
            "新对话",
            "2026-09-22T00:00:00.000Z",
        );
        const stopping = await openChatSocket(
            `ws://127.0.0.1:${port}/api/chat/socket`,
        );
        stopping.socket.send(JSON.stringify({
            type: "send",
            conversationId: stopped.id,
            model: "stop-model",
            text: "stop this",
        }));
        assertEquals((await stopping.next()).type, "user");
        assertEquals(await stopping.next(), { type: "delta", text: "partial" });
        stopping.socket.send(JSON.stringify({ type: "stop" }));
        assertEquals(await stopping.next(), { type: "stopped" });
        stopping.socket.close();
        const saved = store.listMessages(stopped.id);
        assertEquals(saved.map((item) => item.text), ["stop this", "partial"]);
    } finally {
        await server.shutdown();
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

function streamingSource(): InferenceSource {
    return {
        id: "stream-source",
        capabilities: [{
            operation: "generation.create",
            models: ["stream-model"],
            streaming: true,
        }],
        execute(input) {
            return (async function* (): AsyncIterable<StreamFrame> {
                yield frame(input, 1, { kind: "run.started", request: input });
                yield frame(input, 2, {
                    kind: "part.delta",
                    messageId: "m",
                    partId: "p",
                    delta: "hello ",
                });
                yield frame(input, 3, {
                    kind: "part.delta",
                    messageId: "m",
                    partId: "p",
                    delta: "socket",
                });
                yield frame(input, 4, { kind: "run.completed" });
            })();
        },
    };
}

function stoppingSource(): InferenceSource {
    return {
        id: "stop-source",
        capabilities: [{
            operation: "generation.create",
            models: ["stop-model"],
            streaming: true,
        }],
        execute(input, context) {
            return (async function* (): AsyncIterable<StreamFrame> {
                yield frame(input, 1, { kind: "run.started", request: input });
                yield frame(input, 2, {
                    kind: "part.delta",
                    messageId: "m",
                    partId: "p",
                    delta: "partial",
                });
                await new Promise<void>((resolve) => {
                    if (context.signal.aborted) resolve();
                    else {
                        context.signal.addEventListener(
                            "abort",
                            () => resolve(),
                            {
                                once: true,
                            },
                        );
                    }
                });
                yield frame(input, 3, {
                    kind: "run.cancelled",
                    reason: "stopped",
                });
            })();
        },
    };
}

function openChatSocket(url: string): Promise<{
    socket: WebSocket;
    next: () => Promise<{ type: string; text?: string }>;
}> {
    const socket = new WebSocket(url);
    const pending: { type: string; text?: string }[] = [];
    let notify: (() => void) | undefined;
    socket.addEventListener("message", (event) => {
        pending.push(JSON.parse(String(event.data)));
        notify?.();
        notify = undefined;
    });
    return new Promise((resolve, reject) => {
        socket.addEventListener("open", () => {
            resolve({
                socket,
                next: () => {
                    const ready = pending.shift();
                    if (ready !== undefined) return Promise.resolve(ready);
                    return new Promise((done) => {
                        notify = () => done(pending.shift()!);
                    });
                },
            });
        });
        socket.addEventListener(
            "error",
            () => reject(new Error("socket failed")),
        );
    });
}

Deno.test("chat answers current_time locally and keeps image attachments", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-tools-",
    });
    const store = openSqliteChatStore(`${directory}/chat.sqlite`);
    let runs = 0;
    const seen: string[] = [];
    try {
        const app = createServer({
            sources: [{
                id: "tool-source",
                capabilities: [{
                    operation: "generation.create",
                    models: ["chat-model"],
                    streaming: false,
                }],
                execute(input) {
                    runs += 1;
                    const messages = (input.payload as unknown as {
                        messages: { parts: { type: string }[] }[];
                    }).messages;
                    seen.push(
                        ...messages.flatMap((item) =>
                            item.parts.map((part) => part.type)
                        ),
                    );
                    return (async function* (): AsyncIterable<StreamFrame> {
                        yield frame(input, 1, {
                            kind: "run.started",
                            request: input,
                        });
                        if (runs === 1 && !seen.includes("image")) {
                            yield frame(input, 2, {
                                kind: "tool.call",
                                messageId: "m",
                                callId: "call-1",
                                name: "current_time",
                                argumentsText: "{}",
                            });
                        } else {
                            yield frame(input, 2, {
                                kind: "part.delta",
                                messageId: "m",
                                partId: "p",
                                delta: seen.includes("image")
                                    ? "saw image"
                                    : "used the clock",
                            });
                        }
                        yield frame(input, 3, { kind: "run.completed" });
                    })();
                },
            }],
            chat: { store, tools: [createClockToolPlugin()] },
        });
        const created = await app.request(
            "http://localhost/api/chat/conversations",
            {
                method: "POST",
            },
        );
        const conversationId = (await created.json()).conversation.id as string;
        const clock = await app.request("http://localhost/api/chat/message", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId,
                model: "chat-model",
                text: "what time is it",
            }),
        });
        assertEquals(clock.status, 200);
        const clockBody = await clock.json();
        assertEquals(clockBody.toolCalls, []);
        assertEquals(
            clockBody.messages.map((item: { role: string }) => item.role),
            ["user", "assistant", "tool", "assistant"],
        );
        assertEquals(clockBody.messages.at(-1).text, "used the clock");

        const imageConversation = store.createConversation(
            "新对话",
            "2026-09-22T00:00:00.000Z",
        );
        const image = await app.request("http://localhost/api/chat/message", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: imageConversation.id,
                model: "chat-model",
                text: "look",
                attachments: [{
                    mediaType: "image/png",
                    dataBase64: "aGVsbG8=",
                }],
            }),
        });
        assertEquals(image.status, 200);
        assertEquals((await image.json()).messages[1].text, "saw image");
        assertEquals(seen.includes("image"), true);
        const stored = store.listMessages(imageConversation.id)[0];
        assertEquals(stored?.attachments?.[0]?.mediaType, "image/png");
    } finally {
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("chat regenerate selects a new reply while preserving the previous variant", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-regen-",
    });
    const store = openSqliteChatStore(`${directory}/chat.sqlite`);
    let runs = 0;
    const server = Deno.serve(
        { port: 0, hostname: "127.0.0.1", onListen() {} },
        createServer({
            sources: [{
                id: "regen-source",
                capabilities: [{
                    operation: "generation.create",
                    models: ["chat-model"],
                    streaming: true,
                }],
                execute(input) {
                    runs += 1;
                    const text = `reply-${runs}`;
                    return (async function* (): AsyncIterable<StreamFrame> {
                        yield frame(input, 1, {
                            kind: "run.started",
                            request: input,
                        });
                        yield frame(input, 2, {
                            kind: "part.delta",
                            messageId: "m",
                            partId: "p",
                            delta: text,
                        });
                        yield frame(input, 3, { kind: "run.completed" });
                    })();
                },
            }],
            chat: { store },
        }).fetch,
    );
    try {
        const port = (server.addr as Deno.NetAddr).port;
        const base = `http://127.0.0.1:${port}`;
        const created = await fetch(`${base}/api/chat/conversations`, {
            method: "POST",
        });
        const conversationId = (await created.json()).conversation.id as string;
        const sent = await fetch(`${base}/api/chat/message`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId,
                model: "chat-model",
                text: "ask",
                attachments: [{
                    mediaType: "image/png",
                    dataBase64: "aGVsbG8=",
                }],
            }),
        });
        assertEquals(sent.status, 200);

        const again = await fetch(`${base}/api/chat/regenerate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId, model: "chat-model" }),
        });
        assertEquals(again.status, 200);
        const body = await again.json();
        assertEquals(
            body.messages.map((item: { text: string }) => item.text),
            ["ask", "reply-2"],
        );
        assertEquals(
            store.listMessages(conversationId).map((item) => item.text),
            ["ask", "reply-2"],
        );
        assertEquals(
            store.listMessages(conversationId)[0]?.attachments?.[0]?.mediaType,
            "image/png",
        );

        const empty = store.createConversation(
            "新对话",
            "2026-09-22T00:00:00.000Z",
        );
        const rejected = await fetch(`${base}/api/chat/regenerate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: empty.id,
                model: "chat-model",
            }),
        });
        assertEquals(rejected.status, 400);
        const missing = await fetch(`${base}/api/chat/regenerate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: "missing",
                model: "chat-model",
            }),
        });
        assertEquals(missing.status, 404);

        const socket = await openChatSocket(
            `ws://127.0.0.1:${port}/api/chat/socket`,
        );
        socket.socket.send(JSON.stringify({
            type: "regenerate",
            conversationId,
            model: "chat-model",
        }));
        assertEquals(await socket.next(), { type: "delta", text: "reply-3" });
        assertEquals((await socket.next()).type, "done");
        socket.socket.close();
        assertEquals(
            store.listMessages(conversationId).map((item) => item.text),
            ["ask", "reply-3"],
        );
    } finally {
        await server.shutdown();
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("chat regenerate keeps the previous reply when generation fails", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-regen-fail-",
    });
    const store = openSqliteChatStore(`${directory}/chat.sqlite`);
    let runs = 0;
    try {
        const app = createServer({
            sources: [{
                id: "fail-source",
                capabilities: [{
                    operation: "generation.create",
                    models: ["chat-model"],
                    streaming: false,
                }],
                execute(input) {
                    runs += 1;
                    const failed = runs > 1;
                    return (async function* (): AsyncIterable<StreamFrame> {
                        yield frame(input, 1, {
                            kind: "run.started",
                            request: input,
                        });
                        if (failed) {
                            yield frame(input, 2, {
                                kind: "run.error",
                                error: {
                                    code: "upstream_error",
                                    message: "upstream failed",
                                },
                            });
                            return;
                        }
                        yield frame(input, 2, {
                            kind: "part.delta",
                            messageId: "m",
                            partId: "p",
                            delta: "kept",
                        });
                        yield frame(input, 3, { kind: "run.completed" });
                    })();
                },
            }],
            chat: { store },
        });
        const created = await app.request(
            "http://localhost/api/chat/conversations",
            { method: "POST" },
        );
        const conversationId = (await created.json()).conversation.id as string;
        const sent = await app.request("http://localhost/api/chat/message", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId,
                model: "chat-model",
                text: "ask",
            }),
        });
        assertEquals(sent.status, 200);
        const again = await app.request(
            "http://localhost/api/chat/regenerate",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ conversationId, model: "chat-model" }),
            },
        );
        assertEquals(again.status, 502);
        assertEquals(
            store.listMessages(conversationId).map((item) => item.text),
            ["ask", "kept"],
        );
    } finally {
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("chat conversation settings inject a system prompt and reasoning effort", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-settings-",
    });
    const store = openSqliteChatStore(`${directory}/chat.sqlite`);
    const captured: OperationRequest[] = [];
    try {
        const app = createServer({
            sources: [{
                id: "chat-source",
                capabilities: [{
                    operation: "generation.create",
                    models: ["chat-model"],
                    streaming: false,
                }],
                execute(input) {
                    captured.push(input);
                    return (async function* (): AsyncIterable<StreamFrame> {
                        yield frame(input, 1, {
                            kind: "run.started",
                            request: input,
                        });
                        yield frame(input, 2, {
                            kind: "part.delta",
                            messageId: "m",
                            partId: "p",
                            delta: "done",
                        });
                        yield frame(input, 3, { kind: "run.completed" });
                    })();
                },
            }],
            chat: { store },
        });
        const created = await app.request(
            "http://localhost/api/chat/conversations",
            { method: "POST" },
        );
        const conversationId = (await created.json()).conversation.id as string;

        const invalid = await app.request(
            `http://localhost/api/chat/conversation?id=${conversationId}`,
            {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ reasoningEffort: "maximum" }),
            },
        );
        assertEquals(invalid.status, 400);

        const empty = await app.request(
            `http://localhost/api/chat/conversation?id=${conversationId}`,
            {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({}),
            },
        );
        assertEquals(empty.status, 400);

        const patched = await app.request(
            `http://localhost/api/chat/conversation?id=${conversationId}`,
            {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    systemPrompt: "Always answer in Chinese.",
                    reasoningEffort: "high",
                }),
            },
        );
        assertEquals(patched.status, 200);
        const stored = (await patched.json()).conversation;
        assertEquals(stored.systemPrompt, "Always answer in Chinese.");
        assertEquals(stored.reasoningEffort, "high");

        const sent = await app.request("http://localhost/api/chat/message", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId,
                model: "chat-model",
                text: "hello",
            }),
        });
        assertEquals(sent.status, 200);
        assertEquals(captured.length, 1);
        const payload = captured[0]!.payload as unknown as {
            messages: readonly {
                role: string;
                parts: readonly { type: string; text?: string }[];
            }[];
            extensions?: { raw?: { reasoning_effort?: string } };
        };
        const messages = payload.messages;
        assertEquals(messages[0]!.role, "system");
        assertEquals(messages[0]!.parts[0]!.text, "Always answer in Chinese.");
        assertEquals(messages[1]!.role, "user");
        assertEquals(payload.extensions?.raw?.reasoning_effort, "high");

        const cleared = await app.request(
            `http://localhost/api/chat/conversation?id=${conversationId}`,
            {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    systemPrompt: "",
                    reasoningEffort: null,
                }),
            },
        );
        assertEquals(cleared.status, 200);
        const after = (await cleared.json()).conversation;
        assertEquals(after.systemPrompt, undefined);
        assertEquals(after.reasoningEffort, undefined);
    } finally {
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});
