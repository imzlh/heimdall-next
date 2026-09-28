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

Deno.test("chat SSR snapshots retain all leaf choices while excluding private branch metadata", async () => {
    const branches = [
        { messageId: "user-leaf", label: "提问版本", selected: false },
        { messageId: "assistant-leaf", label: "回复版本", selected: true },
        { messageId: "tool-leaf", label: "插件结果", selected: false },
    ];
    const expected = {
        ...conversation,
        activeMessageId: "assistant-leaf",
        branches,
    };
    const payload = {
        ...expected,
        private: "private-conversation-data",
        branches: branches.map((branch, index) => ({
            ...branch,
            role: ["user", "assistant", "tool"][index],
            private: { token: "private-branch-data" },
        })),
    };
    const snapshot = await loadChatSnapshot({
        authorized: true,
        available: true,
        conversationId: conversation.id,
        dispatch: () =>
            Promise.resolve(Response.json({
                conversations: [payload, conversation],
                conversation: payload,
                messages: [message],
                data: [],
            })),
    });
    assertEquals(snapshot.conversations, [expected, conversation]);
    assertEquals(snapshot.conversation, expected);
    assertEquals(snapshot.messages, [message]);
    assertEquals(snapshot.error, undefined);
    assertFalse(JSON.stringify(snapshot).includes("private-"));
});

Deno.test("chat SSR snapshots preserve 10000 bounded leaf choices even when no branch is selected", async () => {
    const branches = Array.from({ length: 10_000 }, (_, index) => ({
        messageId: index === 0 ? "m".repeat(512) : `leaf-${index}`,
        label: index === 0 ? "标".repeat(512) : `分支 ${index}`,
        selected: false,
    }));
    const expected = { ...conversation, branches };
    const snapshot = await loadChatSnapshot({
        authorized: true,
        available: true,
        conversationId: conversation.id,
        dispatch: () =>
            Promise.resolve(Response.json({
                conversations: [expected],
                conversation: expected,
                messages: [message],
                data: [],
            })),
    });
    assertEquals(snapshot.conversations.length, 1);
    assertEquals(snapshot.conversations[0]?.branches?.length, branches.length);
    assertEquals(snapshot.conversation?.branches?.length, branches.length);
    for (let index = 0; index < branches.length; index++) {
        assertEquals(
            snapshot.conversations[0]?.branches?.[index],
            branches[index],
        );
        assertEquals(snapshot.conversation?.branches?.[index], branches[index]);
    }
    assertEquals(snapshot.messages, [message]);
    assertEquals(snapshot.error, undefined);
});

Deno.test("chat SSR snapshots discard malformed branch choices without dropping readable conversations or messages", async (t) => {
    const branch = { messageId: "leaf", label: "分支", selected: false };
    const invalid: [string, unknown][] = [
        ["not an array", {}],
        ["null list", null],
        ["non-object leaf", [null]],
        ["missing message ID", [{ label: "分支", selected: false }]],
        ["empty message ID", [{ ...branch, messageId: "" }]],
        ["overlong message ID", [{ ...branch, messageId: "m".repeat(513) }]],
        ["non-string message ID", [{ ...branch, messageId: 12 }]],
        ["missing label", [{ messageId: "leaf", selected: false }]],
        ["non-string label", [{ ...branch, label: 12 }]],
        ["overlong label", [{ ...branch, label: "标".repeat(513) }]],
        ["missing selected flag", [{ messageId: "leaf", label: "分支" }]],
        ["non-boolean selected flag", [{ ...branch, selected: "true" }]],
        ["mixed valid and invalid leaves", [
            branch,
            { ...branch, messageId: "other-leaf", selected: 1 },
        ]],
        ["duplicate IDs", [branch, { ...branch, label: "另一个分支" }]],
        ["multiple selected leaves", [
            { ...branch, selected: true },
            { ...branch, messageId: "other-leaf", selected: true },
        ]],
        [
            "too many leaves",
            Array.from({ length: 10_001 }, (_, index) => ({
                ...branch,
                messageId: `leaf-${index}`,
            })),
        ],
    ];
    for (const [name, branches] of invalid) {
        await t.step(name, async () => {
            const selected = { ...conversation, activeMessageId: "leaf" };
            const normal = { ...conversation, id: "normal-conversation" };
            const malformed = { ...selected, branches };
            const snapshot = await loadChatSnapshot({
                authorized: true,
                available: true,
                conversationId: conversation.id,
                dispatch: () =>
                    Promise.resolve(Response.json({
                        conversations: [normal, malformed],
                        conversation: malformed,
                        messages: [message],
                        data: [],
                    })),
            });
            assertEquals(snapshot.conversations, [normal, selected]);
            assertEquals(snapshot.conversation, selected);
            assertEquals(snapshot.messages, [message]);
            assertEquals(snapshot.error, undefined);
        });
    }
});

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
            if (path === "/admin/plugins") {
                return Promise.resolve(
                    Response.json({
                        data: [
                            {
                                id: "heimdall.tool.web",
                                name: "网页搜索与抓取",
                                description: "为 Chat 提供网页搜索和正文抓取。",
                                kind: "tool",
                                enabled: true,
                            },
                            {
                                id: "heimdall.source.off",
                                name: "停用的工具",
                                kind: "tool",
                                enabled: false,
                            },
                            {
                                id: "heimdall.source.x",
                                name: "渠道插件",
                                kind: "source",
                                enabled: true,
                            },
                        ],
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
    assertEquals(snapshot.tools, [{
        id: "heimdall.tool.web",
        name: "网页搜索与抓取",
        description: "为 Chat 提供网页搜索和正文抓取。",
    }]);
    assertEquals(snapshot.conversations[0]?.title, "[已隐藏] <script>");
    assertEquals(snapshot.messages.length, 3);
    assertEquals(snapshot.messages[0]?.attachments, [{
        mediaType: "image/png",
        dataBase64: "YQ==",
    }]);
    assertEquals(snapshot.messages[2]?.name, "plugin.operation");
    assertFalse(JSON.stringify(snapshot).includes("host-secret"));
    assertFalse(JSON.stringify(snapshot).includes("must-stay-private"));
    assertEquals(requests.length, 4);
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

Deno.test("chat snapshots preserve safe asset references and valid branch navigation", async () => {
    const assetId = "12345678-1234-4123-8123-123456789abc";
    const selected = { ...conversation, activeMessageId: message.id };
    const branch = {
        index: 0,
        count: 2,
        messageIds: [message.id, "sibling"],
    };
    const invalidBranches = [
        { index: -1, count: 2, messageIds: ["negative-index", "sibling"] },
        { index: 2, count: 2, messageIds: ["outside-index", "sibling"] },
        { index: 0.5, count: 2, messageIds: ["fractional-index", "sibling"] },
        { index: 1, count: 2, messageIds: ["wrong-selection", "sibling"] },
        { index: 0, count: 2, messageIds: ["duplicate-ids", "duplicate-ids"] },
    ];
    const snapshot = await loadChatSnapshot({
        authorized: true,
        available: true,
        conversationId: conversation.id,
        dispatch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/api/chat/conversations") {
                return Promise.resolve(
                    Response.json({ conversations: [selected] }),
                );
            }
            if (path === "/admin/models") {
                return Promise.resolve(Response.json({ data: [] }));
            }
            return Promise.resolve(Response.json({
                conversation: selected,
                messages: [
                    {
                        ...message,
                        parentId: "parent-message",
                        branch,
                        attachments: [{
                            assetId,
                            mediaType: "image/png",
                            size: 64,
                            name: "示例.png",
                            url: "https://remote.example/private-image?sig=private",
                            dataBase64: "YQ==",
                        }, {
                            assetId: "not-an-asset-id",
                            mediaType: "image/png",
                            dataBase64: "YQ==",
                        }, {
                            assetId,
                            mediaType: "image/svg+xml",
                            dataBase64: "YQ==",
                        }],
                    },
                    ...invalidBranches.map((invalidBranch) => ({
                        ...message,
                        id: invalidBranch.messageIds[0],
                        branch: invalidBranch,
                    })),
                ],
            }));
        },
    });

    assertEquals(snapshot.error, undefined);
    assertEquals(snapshot.conversation?.activeMessageId, message.id);
    assertEquals(snapshot.conversations[0]?.activeMessageId, message.id);
    assertEquals(snapshot.messages[0]?.parentId, "parent-message");
    assertEquals(snapshot.messages[0]?.branch, branch);
    assertEquals(snapshot.messages[0]?.attachments, [{
        assetId,
        mediaType: "image/png",
        size: 64,
        name: "示例.png",
        url: `/admin/chat/api/assets/${assetId}`,
    }]);
    assertEquals(snapshot.messages.length, 1 + invalidBranches.length);
    for (const item of snapshot.messages.slice(1)) {
        assertFalse("branch" in item, item.id);
    }
    const serialized = JSON.stringify(snapshot);
    assertFalse(serialized.includes("remote.example"));
    assertFalse(serialized.includes("dataBase64"));
    assertFalse(serialized.includes("not-an-asset-id"));
    assertFalse(serialized.includes("image/svg+xml"));
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
