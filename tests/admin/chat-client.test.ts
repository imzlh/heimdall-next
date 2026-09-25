import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import {
    type ChatAttachment,
    type ChatCommand,
    type ChatConversation,
    type ChatMessage,
    type ChatRequestOptions,
    chatSocketProtocols,
    chatSocketUrl,
    type ChatToolCall,
    createConversation,
    deleteChatConversation,
    listChatConversations,
    loadChatConversation,
    openChatStream,
    renameChatConversation,
} from "@heimdall/core/web/client/api/chat.ts";
import {
    AdminApiError,
    clearAdminToken,
    configureAdminTransport,
    setAdminToken,
} from "@heimdall/core/web/client/api/admin.ts";

const conversation: ChatConversation = {
    id: "conversation-1",
    title: "Weather",
    createdAt: "2026-09-23T08:00:00.000Z",
    updatedAt: "2026-09-23T08:01:00.000Z",
};

const attachment: ChatAttachment = {
    mediaType: "image/png",
    dataBase64: "aW1hZ2U=",
};

const userMessage: ChatMessage = {
    id: "message-1",
    conversationId: conversation.id,
    role: "user",
    text: "What is in this picture?",
    createdAt: conversation.createdAt,
    attachments: [attachment],
};

Deno.test("chat management uses authenticated JSON requests and validates deletion acknowledgement", async () => {
    const originalFetch = globalThis.fetch;
    const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
    const changed = { ...conversation, title: "renamed" };
    globalThis.fetch = (input, init) => {
        calls.push({ input, init });
        return Promise.resolve(
            Response.json(
                init?.method === "PATCH"
                    ? { conversation: changed }
                    : { deleted: true, id: conversation.id },
            ),
        );
    };
    setAdminToken("chat-admin-token");
    try {
        assertEquals(
            await renameChatConversation(conversation.id, "renamed"),
            changed,
        );
        await deleteChatConversation(conversation.id);
        const session = { endpoint: "/admin/chat/api", session: true };
        assertEquals(
            await renameChatConversation(conversation.id, "renamed", session),
            changed,
        );
        await deleteChatConversation(conversation.id, session);
        assertEquals(calls.map(({ init }) => init?.method), [
            "PATCH",
            "DELETE",
            "PATCH",
            "DELETE",
        ]);
        for (const [index, call] of calls.entries()) {
            const headers = new Headers(call.init?.headers);
            assertEquals(
                headers.get("authorization"),
                index < 2 ? "Bearer chat-admin-token" : null,
            );
            if (index >= 2) assertEquals(call.init?.credentials, "same-origin");
            if (call.init?.method === "PATCH") {
                assertEquals(headers.get("content-type"), "application/json");
                assertEquals(JSON.parse(String(call.init.body)), {
                    title: "renamed",
                });
            }
            const url = new URL(String(call.input), "https://heimdall.example");
            assertEquals([...url.searchParams], [["id", conversation.id]]);
        }
        globalThis.fetch = () =>
            Promise.resolve(Response.json({ deleted: true, id: "another-id" }));
        await assertRejects(
            () => deleteChatConversation(conversation.id, session),
            AdminApiError,
        );
        globalThis.fetch = () =>
            Promise.resolve(
                Response.json({
                    conversation: { ...changed, id: "another-id" },
                }),
            );
        await assertRejects(
            () => renameChatConversation(conversation.id, "renamed", session),
            AdminApiError,
        );
    } finally {
        globalThis.fetch = originalFetch;
        clearAdminToken();
    }
});

Deno.test("chat management conflict retains the error status for both transports", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
        Promise.resolve(
            Response.json({
                error: { code: "run_in_progress", message: "请先停止生成" },
            }, { status: 409 }),
        );
    try {
        for (
            const options of [{}, {
                endpoint: "/admin/chat/api",
                session: true,
            }]
        ) {
            const error = await assertRejects(
                () => deleteChatConversation(conversation.id, options),
                AdminApiError,
            );
            assertEquals(error.status, 409);
            assertEquals(error.code, "run_in_progress");
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});

Deno.test("chat HTTP client authenticates requests and preserves message metadata", async () => {
    const originalFetch = globalThis.fetch;
    const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
    const messages: ChatMessage[] = [
        userMessage,
        {
            id: "message-2",
            conversationId: conversation.id,
            role: "assistant",
            text: '{"city":"Shanghai"}',
            createdAt: conversation.updatedAt,
            callId: "call-1",
            name: "weather",
        },
        {
            id: "message-3",
            conversationId: conversation.id,
            role: "tool",
            text: "Sunny",
            createdAt: conversation.updatedAt,
            callId: "call-1",
            name: "weather",
        },
    ];
    globalThis.fetch = (input, init) => {
        calls.push({ input, init });
        if (String(input).startsWith("/api/chat/conversation?")) {
            return Promise.resolve(Response.json({ conversation, messages }));
        }
        if (init?.method === "POST") {
            return Promise.resolve(Response.json({ conversation }, {
                status: 201,
            }));
        }
        return Promise.resolve(Response.json({
            conversations: [conversation],
        }));
    };
    setAdminToken("chat-admin-token");
    try {
        assertEquals(await listChatConversations(), [conversation]);
        assertEquals(await loadChatConversation("room /?&"), {
            conversation,
            messages,
        });
        assertEquals(await createConversation(), conversation);
        assertEquals(calls.length, 3);
        assertEquals(String(calls[0]!.input), "/api/chat/conversations");
        const loadedUrl = new URL(
            String(calls[1]!.input),
            "https://heimdall.example",
        );
        assertEquals(loadedUrl.pathname, "/api/chat/conversation");
        assertEquals([...loadedUrl.searchParams], [["id", "room /?&"]]);
        assertEquals(String(calls[2]!.input), "/api/chat/conversations");
        assertEquals(calls.map(({ init }) => init?.method ?? "GET"), [
            "GET",
            "GET",
            "POST",
        ]);
        for (const call of calls) {
            assertEquals(
                new Headers(call.init?.headers).get("authorization"),
                "Bearer chat-admin-token",
            );
        }
    } finally {
        globalThis.fetch = originalFetch;
        clearAdminToken();
    }
});

Deno.test("session chat HTTP requests use cookies, exclude bearer tokens, and bypass the admin bridge", async () => {
    const originalFetch = globalThis.fetch;
    const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
    let bridgeCalls = 0;
    const controller = new AbortController();
    const options: ChatRequestOptions = {
        endpoint: "/admin/chat/api",
        session: true,
        signal: controller.signal,
    };
    globalThis.fetch = (input, init) => {
        calls.push({ input, init });
        if (String(input).startsWith("/admin/chat/api/conversation?")) {
            return Promise.resolve(Response.json({
                conversation,
                messages: [userMessage],
            }));
        }
        if (init?.method === "POST") {
            return Promise.resolve(Response.json({ conversation }, {
                status: 201,
            }));
        }
        return Promise.resolve(
            Response.json({ conversations: [conversation] }),
        );
    };
    configureAdminTransport(() => {
        bridgeCalls++;
        return Promise.reject(new Error("session chat used the admin bridge"));
    });
    setAdminToken("stored-admin-token");
    try {
        assertEquals(await listChatConversations(options), [conversation]);
        assertEquals(await loadChatConversation("room /?&", options), {
            conversation,
            messages: [userMessage],
        });
        assertEquals(await createConversation(options), conversation);
        assertEquals(bridgeCalls, 0);
        assertEquals(calls.length, 3);
        assertEquals(String(calls[0]!.input), "/admin/chat/api/conversations");
        const loadedUrl = new URL(
            String(calls[1]!.input),
            "https://heimdall.example",
        );
        assertEquals(loadedUrl.pathname, "/admin/chat/api/conversation");
        assertEquals([...loadedUrl.searchParams], [["id", "room /?&"]]);
        assertEquals(String(calls[2]!.input), "/admin/chat/api/conversations");
        assertEquals(calls.map(({ init }) => init?.method ?? "GET"), [
            "GET",
            "GET",
            "POST",
        ]);
        for (const call of calls) {
            const headers = new Headers(call.init?.headers);
            assertEquals(headers.get("authorization"), null);
            assertEquals(headers.get("accept"), "application/json");
            assertEquals(call.init?.credentials, "same-origin");
            assertStrictEquals(call.init?.signal, controller.signal);
        }
    } finally {
        globalThis.fetch = originalFetch;
        configureAdminTransport();
        clearAdminToken();
    }
});

Deno.test("custom chat endpoints retain the legacy bearer transport and abort signal", async () => {
    const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
    const controller = new AbortController();
    configureAdminTransport((input, init) => {
        calls.push({ input, init });
        return Promise.resolve(
            Response.json({ conversations: [conversation] }),
        );
    });
    setAdminToken("legacy-admin-token");
    try {
        assertEquals(
            await listChatConversations({
                endpoint: "/custom/chat",
                signal: controller.signal,
            }),
            [conversation],
        );
        assertEquals(calls.length, 1);
        assertEquals(String(calls[0]!.input), "/custom/chat/conversations");
        assertEquals(
            new Headers(calls[0]!.init?.headers).get("authorization"),
            "Bearer legacy-admin-token",
        );
        assertStrictEquals(calls[0]!.init?.signal, controller.signal);
    } finally {
        configureAdminTransport();
        clearAdminToken();
    }
});

Deno.test("session chat HTTP errors preserve status and safe API diagnostics", async () => {
    const originalFetch = globalThis.fetch;
    const payload = {
        error: { code: "unauthorized", message: "session has expired" },
    };
    globalThis.fetch = () =>
        Promise.resolve(Response.json(payload, {
            status: 401,
            headers: { "x-heimdall-request-id": "session-chat-401" },
        }));
    try {
        const error = await assertRejects(
            () =>
                listChatConversations({
                    endpoint: "/admin/chat/api",
                    session: true,
                }),
            AdminApiError,
            "session has expired",
        );
        assertEquals(error.status, 401);
        assertEquals(error.code, "unauthorized");
        assertEquals(error.requestId, "session-chat-401");
        assertEquals(error.details, payload);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

Deno.test("chat socket encodes UTF-8 tokens in protocols and drops page queries", () => {
    assertEquals(chatSocketProtocols(""), ["heimdall-chat"]);
    assertEquals(chatSocketProtocols("你好🔑"), [
        "heimdall-chat",
        "heimdall-auth.5L2g5aW98J-UkQ",
    ]);
    assertEquals(
        chatSocketUrl(
            "https://heimdall.example:8443/admin/chat?token=secret#chat",
        ),
        "wss://heimdall.example:8443/api/chat/socket",
    );
    assertEquals(
        chatSocketUrl("http://localhost:8000/admin/?view=chat#history"),
        "ws://localhost:8000/api/chat/socket",
    );
});

Deno.test("chat socket accepts session API and socket endpoints without page credentials", () => {
    const baseUrl =
        "https://heimdall.example:8443/admin/chat?token=page-secret#chat";
    assertEquals(
        chatSocketUrl(baseUrl, "/admin/chat/api"),
        "wss://heimdall.example:8443/admin/chat/api/socket",
    );
    assertEquals(
        chatSocketUrl(baseUrl, "/admin/chat/api/socket"),
        "wss://heimdall.example:8443/admin/chat/api/socket",
    );
    assertEquals(
        chatSocketUrl(
            "http://localhost:8000/admin/chat?token=page-secret#chat",
            "/admin/chat/api",
        ),
        "ws://localhost:8000/admin/chat/api/socket",
    );
});

class FakeWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: FakeWebSocket[] = [];

    readonly url: string;
    readonly protocols: string[];
    readonly sent: unknown[] = [];
    readyState = FakeWebSocket.CONNECTING;
    closeCalls = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(url: string | URL, protocols: string | string[] = []) {
        super();
        this.url = String(url);
        this.protocols = typeof protocols === "string"
            ? [protocols]
            : protocols;
        FakeWebSocket.instances.push(this);
    }

    send(data: string): void {
        if (this.readyState !== FakeWebSocket.OPEN) {
            throw new Error("WebSocket is not open");
        }
        this.sent.push(JSON.parse(data));
    }

    close(): void {
        this.closeCalls++;
        this.readyState = FakeWebSocket.CLOSING;
    }

    open(): void {
        this.readyState = FakeWebSocket.OPEN;
        const event = new Event("open");
        this.onopen?.(event);
        this.dispatchEvent(event);
    }

    receive(payload: unknown): void {
        const event = new MessageEvent("message", {
            data: JSON.stringify(payload),
        });
        this.onmessage?.(event);
        this.dispatchEvent(event);
    }

    disconnect(): void {
        this.readyState = FakeWebSocket.CLOSED;
        const event = new CloseEvent("close", { code: 1006, wasClean: false });
        this.onclose?.(event);
        this.dispatchEvent(event);
    }

    fail(): void {
        const event = new Event("error");
        this.onerror?.(event);
        this.dispatchEvent(event);
    }
}

async function withMockSocket(run: () => Promise<void>): Promise<void> {
    const originalWebSocket = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
        await run();
    } finally {
        globalThis.WebSocket = originalWebSocket;
        clearAdminToken();
    }
}

const sendCommand = {
    type: "send" as const,
    conversationId: conversation.id,
    model: "chat-model",
    text: userMessage.text,
};

Deno.test("chat stream sends on open and delivers ordered user, delta, tool and done events", async () => {
    await withMockSocket(async () => {
        setAdminToken("你好🔑");
        const received: unknown[] = [];
        let opened = 0;
        const stream = openChatStream(sendCommand, {
            onOpen: () => opened++,
            onEvent: (event) => received.push(event),
        }, "https://heimdall.example/admin?token=old-secret#chat");
        assertEquals(FakeWebSocket.instances.length, 1);
        const socket = FakeWebSocket.instances[0]!;
        assertEquals(socket.url, "wss://heimdall.example/api/chat/socket");
        assertEquals(socket.protocols, [
            "heimdall-chat",
            "heimdall-auth.5L2g5aW98J-UkQ",
        ]);
        assertEquals(socket.sent, []);
        assertEquals(opened, 0);
        socket.open();
        assertEquals(opened, 1);
        assertEquals(socket.sent, [sendCommand]);
        const toolCall: ChatToolCall = {
            callId: "call-1",
            name: "weather",
            argumentsText: '{"city":"Shanghai"}',
        };
        const events = [
            { type: "user", message: userMessage },
            { type: "delta", text: "A sunny " },
            { type: "delta", text: "city." },
            {
                type: "tool",
                calls: [toolCall],
            },
            { type: "done", conversation },
        ];
        for (const event of events) socket.receive(event);
        assertEquals(await stream.finished, "done");
        assertEquals(received, events);
        assertEquals(socket.closeCalls, 1);
        socket.disconnect();
        assertEquals(await stream.finished, "done");
    });
});

Deno.test("session chat streams exclude stored tokens and forward send attachments", async () => {
    await withMockSocket(async () => {
        setAdminToken("stored-admin-token");
        const command: ChatCommand = {
            ...sendCommand,
            attachments: [attachment],
        };
        const stream = openChatStream(
            command,
            {},
            "https://heimdall.example/admin/chat?token=page-secret#chat",
            { endpoint: "/admin/chat/api", session: true },
        );
        assertEquals(FakeWebSocket.instances.length, 1);
        const socket = FakeWebSocket.instances[0]!;
        assertEquals(
            socket.url,
            "wss://heimdall.example/admin/chat/api/socket",
        );
        assertEquals(socket.protocols, ["heimdall-chat"]);
        assertEquals(socket.sent, []);
        socket.open();
        assertEquals(socket.sent, [command]);
        socket.receive({ type: "done", conversation });
        assertEquals(await stream.finished, "done");
        assertEquals(socket.closeCalls, 1);
    });
});

Deno.test("chat regenerate waits for a stopped acknowledgement after stop", async () => {
    await withMockSocket(async () => {
        const command = {
            type: "regenerate" as const,
            conversationId: conversation.id,
            model: "chat-model",
        };
        const stream = openChatStream(command, {}, "http://localhost:8000");
        const socket = FakeWebSocket.instances[0]!;
        socket.open();
        stream.stop();
        assertEquals(socket.sent, [command, { type: "stop" }]);
        assertEquals(socket.closeCalls, 0);
        socket.receive({ type: "stopped" });
        assertEquals(await stream.finished, "stopped");
        assertEquals(socket.closeCalls, 1);
    });
});

Deno.test("chat stream rejects server errors with their message", async () => {
    await withMockSocket(async () => {
        const stream = openChatStream(
            sendCommand,
            {},
            "https://heimdall.example",
        );
        const rejected = assertRejects(
            () => stream.finished,
            Error,
            "model is unavailable",
        );
        const socket = FakeWebSocket.instances[0]!;
        socket.open();
        socket.receive({ type: "error", message: "model is unavailable" });
        await rejected;
        assertEquals(socket.closeCalls, 1);
    });
});

Deno.test("chat stream rejects an unexpected close after partial output", async () => {
    await withMockSocket(async () => {
        const received: unknown[] = [];
        const stream = openChatStream(sendCommand, {
            onEvent: (event) => received.push(event),
        }, "https://heimdall.example");
        const rejected = assertRejects(() => stream.finished, Error);
        const socket = FakeWebSocket.instances[0]!;
        socket.open();
        socket.receive({ type: "delta", text: "Partial reply" });
        socket.disconnect();
        await rejected;
        assertEquals(received, [{ type: "delta", text: "Partial reply" }]);
    });
});

Deno.test("chat stream rejects connection errors and closes the socket", async () => {
    await withMockSocket(async () => {
        const stream = openChatStream(
            sendCommand,
            {},
            "https://heimdall.example",
        );
        const rejected = assertRejects(() => stream.finished, Error);
        const socket = FakeWebSocket.instances[0]!;
        socket.fail();
        await rejected;
        assertEquals(socket.sent, []);
        assertEquals(socket.closeCalls, 1);
    });
});

Deno.test("closing a chat stream cancels pending work", async () => {
    await withMockSocket(async () => {
        const stream = openChatStream(
            sendCommand,
            {},
            "https://heimdall.example",
        );
        const rejected = assertRejects(() => stream.finished, Error);
        const socket = FakeWebSocket.instances[0]!;
        socket.open();
        stream.close();
        await rejected;
        assertEquals(socket.closeCalls, 1);
    });
});
