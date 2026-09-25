import { assert, assertEquals, assertFalse } from "@std/assert";
import { loadChatSnapshot } from "@heimdall/core/web/server/chat-snapshot.ts";
import type { ChatSnapshotOptions } from "@heimdall/core/web/server/chat-snapshot.ts";

const conversation = {
    id: "one",
    title: "对话",
    createdAt: "2026-09-24T00:00:00Z",
    updatedAt: "2026-09-24T01:00:00Z",
};
const message = {
    id: "message",
    conversationId: "one",
    role: "user",
    text: "内容",
    createdAt: conversation.createdAt,
};

Deno.test("chat snapshots never read private APIs before authentication or when chat is unavailable", async () => {
    let reads = 0;
    for (
        const state of [{ authorized: false, available: true }, {
            authorized: true,
            available: false,
        }]
    ) {
        const snapshot = await loadChatSnapshot({
            ...state,
            dispatch: () => {
                reads++;
                return Promise.resolve(Response.json({}));
            },
        });
        assertEquals(snapshot, {
            conversations: [],
            conversation: null,
            messages: [],
            models: [],
            authenticated: state.authorized,
            available: state.available,
        });
    }
    assertEquals(reads, 0);
});

Deno.test("chat snapshots project only display records, keep tools generic, and exclude host credentials", async () => {
    const requests: Request[] = [];
    const options: ChatSnapshotOptions = {
        authorized: true,
        available: true,
        adminAuthToken: "host-secret",
        origin: "https://chat.example",
        conversationId: "one",
        selectedModel: "model-b",
        dispatch(request) {
            requests.push(request);
            const path = new URL(request.url).pathname;
            if (path === "/api/chat/conversations") {
                return Promise.resolve(
                    Response.json({
                        conversations: [{
                            ...conversation,
                            title: "host-secret <script>",
                            internal: "must-stay-private",
                        }],
                    }),
                );
            }
            if (path === "/admin/models") {
                return Promise.resolve(
                    Response.json({
                        data: [{ id: "model-a", apiKey: "must-stay-private" }, {
                            id: "model-b",
                        }, { id: "model-b" }],
                    }),
                );
            }
            assertEquals(new URL(request.url).searchParams.get("id"), "one");
            return Promise.resolve(Response.json({
                conversation: { ...conversation, token: "must-stay-private" },
                messages: [
                    {
                        ...message,
                        text: "host-secret reply",
                        reasoning: "must-stay-private",
                        attachments: [{
                            mediaType: "image/png",
                            dataBase64: "YQ==",
                            private: "must-stay-private",
                        }],
                    },
                    {
                        ...message,
                        id: "tool-call",
                        role: "assistant",
                        text: "{}",
                        callId: "call",
                        name: "plugin.operation",
                    },
                    {
                        ...message,
                        id: "tool-result",
                        role: "tool",
                        text: "done",
                        callId: "call",
                        name: "plugin.operation",
                    },
                    {
                        ...message,
                        conversationId: "another",
                        text: "must-stay-private",
                    },
                ],
                rawRequest: "must-stay-private",
            }));
        },
    };
    const snapshot = await loadChatSnapshot(options);
    assertEquals(snapshot.models, ["model-a", "model-b"]);
    assertEquals(snapshot.selectedModel, "model-b");
    assertEquals(snapshot.conversations[0]?.title, "[已隐藏] <script>");
    assertEquals(snapshot.messages.length, 3);
    assertEquals(snapshot.messages[0]?.attachments, [{
        mediaType: "image/png",
        dataBase64: "YQ==",
    }]);
    assertEquals(snapshot.messages[2]?.name, "plugin.operation");
    assertFalse(JSON.stringify(snapshot).includes("host-secret"));
    assertFalse(JSON.stringify(snapshot).includes("must-stay-private"));
    assertEquals(requests.length, 3);
    for (const request of requests) {
        assertEquals(request.method, "GET");
        assertEquals(
            request.headers.get("authorization"),
            "Bearer host-secret",
        );
        assertEquals(request.redirect, "manual");
        assertEquals(new URL(request.url).origin, "https://chat.example");
    }
});

Deno.test("chat snapshots preserve readable history when an independent model read fails", async () => {
    const snapshot = await loadChatSnapshot({
        authorized: true,
        available: true,
        conversationId: "one",
        dispatch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/admin/models") {
                throw new Error("private-upstream-reason");
            }
            return Promise.resolve(
                Response.json(
                    path.endsWith("conversations")
                        ? { conversations: [conversation] }
                        : { conversation, messages: [message] },
                ),
            );
        },
    });
    assertEquals(snapshot.messages[0]?.text, "内容");
    assertEquals(snapshot.models, []);
    assertEquals(snapshot.error, "无法读取模型列表。");
    assertFalse(JSON.stringify(snapshot).includes("private-upstream-reason"));
});

Deno.test("chat snapshots return to login when the underlying API rejects authentication", async () => {
    const snapshot = await loadChatSnapshot({
        authorized: true,
        available: true,
        conversationId: "one",
        dispatch(request) {
            return Promise.resolve(
                new URL(request.url).pathname === "/admin/models"
                    ? Response.json({}, { status: 401 })
                    : Response.json({
                        conversations: [conversation],
                        conversation,
                        messages: [message],
                    }),
            );
        },
    });
    assertEquals(snapshot.authenticated, false);
    assertEquals(snapshot.conversations, []);
    assertEquals(snapshot.messages, []);
});

Deno.test("chat snapshots bound long histories and do not reflect oversized response bodies", async () => {
    const snapshot = await loadChatSnapshot({
        authorized: true,
        available: true,
        conversationId: "one",
        dispatch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/api/chat/conversations") {
                return Promise.resolve(
                    new Response("private-response", {
                        headers: { "content-length": "9000000" },
                    }),
                );
            }
            if (path === "/admin/models") {
                return Promise.resolve(Response.json({ data: [] }));
            }
            return Promise.resolve(
                Response.json({
                    conversation,
                    messages: Array.from(
                        { length: 201 },
                        (_, index) => ({ ...message, id: String(index) }),
                    ),
                }),
            );
        },
    });
    assertEquals(snapshot.messages.length, 200);
    assertEquals(snapshot.messages[0]?.id, "1");
    assert(snapshot.error?.includes("无法读取会话列表"));
    assert(snapshot.error?.includes("部分历史内容"));
    assertFalse(JSON.stringify(snapshot).includes("private-response"));
});
