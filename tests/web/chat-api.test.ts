import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import type {
    ChatConversation,
    ChatMessage,
} from "@heimdall/admin-contracts/chat.ts";
import {
    acquireChatAttachment,
    forkChatConversation,
    loadChatConversation,
    releaseChatAttachment,
    switchChatBranch,
    uploadChatAttachment,
} from "@heimdall/core/web/client/api/chat.ts";
import {
    AdminApiError,
    clearAdminToken,
    configureAdminTransport,
    setAdminToken,
} from "@heimdall/core/web/client/api/transport.ts";
import { createChatApi } from "@heimdall/core/web/client/chat/api.ts";

const conversation: ChatConversation = {
    id: "conversation-1",
    title: "图片分析",
    createdAt: "2026-09-27T04:00:00.000Z",
    updatedAt: "2026-09-27T04:01:00.000Z",
    activeMessageId: "assistant-2",
};
const messages: [ChatMessage, ChatMessage] = [{
    id: "user-1",
    conversationId: conversation.id,
    parentId: null,
    role: "user",
    text: "描述图片",
    createdAt: conversation.createdAt,
    branch: { index: 0, count: 1, messageIds: ["user-1"] },
}, {
    id: "assistant-2",
    conversationId: conversation.id,
    parentId: "user-1",
    role: "assistant",
    text: "这是一张图片",
    createdAt: conversation.updatedAt,
    status: "stopped",
    branch: {
        index: 1,
        count: 2,
        messageIds: ["assistant-1", "assistant-2"],
    },
}];
const history = { conversation, messages };
const asset = {
    assetId: "asset_1-test",
    mediaType: "image/png",
    size: 8,
    name: "截图 一.png",
    url: "/admin/chat/api/assets/asset_1-test",
};

/** Both transports still execute their real request and response adapters. */
function respondWith(
    handler: (
        input: RequestInfo | URL,
        init?: RequestInit,
    ) => Response | Promise<Response>,
) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => Promise.resolve(handler(input, init));
    return {
        [Symbol.dispose]() {
            globalThis.fetch = originalFetch;
            configureAdminTransport();
            clearAdminToken();
        },
    };
}

Deno.test("chat history preserves branch metadata and projects attachments to local asset references", async () => {
    using _transport = respondWith(() =>
        Response.json({
            conversation: { ...conversation, privateState: "private" },
            messages: messages.map((message) => ({
                ...message,
                privateState: "private",
                quota: { meters: [{ name: "sample", remaining: 12 }] },
                ...(message.role === "user"
                    ? {
                        attachments: [{
                            ...asset,
                            url: "https://attacker.example/track",
                            dataBase64: "private-large-image-payload",
                            storagePath: "private/file.png",
                        }],
                    }
                    : {}),
            })),
        })
    );
    const loaded = await createChatApi().load(conversation.id);
    assertEquals(loaded, {
        conversation,
        messages: [{ ...messages[0], attachments: [asset] }, messages[1]],
    });
});

Deno.test("chat history rejects malformed branch selectors and active or parent references", async () => {
    let response: unknown;
    using _transport = respondWith(() => Response.json(response));
    const invalidBranches = [
        null,
        [],
        {},
        { index: 0, count: 0, messageIds: [] },
        { index: -1, count: 1, messageIds: ["assistant-2"] },
        { index: 1, count: 1, messageIds: ["assistant-2"] },
        { index: 0.5, count: 1, messageIds: ["assistant-2"] },
        { index: 0, count: 2, messageIds: ["assistant-2"] },
        { index: 0, count: 1.5, messageIds: ["assistant-2"] },
        { index: 0, count: 1, messageIds: ["different-message"] },
        { index: 0, count: 2, messageIds: ["assistant-2", "assistant-2"] },
        { index: 0, count: 2, messageIds: ["assistant-2", 12] },
    ];
    for (const branch of invalidBranches) {
        response = {
            conversation,
            messages: [messages[0], { ...messages[1], branch }],
        };
        const error = await assertRejects(
            () => createChatApi().load(conversation.id),
            AdminApiError,
        );
        assertEquals(error.code, "invalid_response", JSON.stringify(branch));
    }
    for (
        const invalid of [
            {
                conversation: { ...conversation, activeMessageId: 42 },
                messages,
            },
            { conversation, messages: [{ ...messages[0], parentId: {} }] },
        ]
    ) {
        response = invalid;
        const error = await assertRejects(
            () => createChatApi().load(conversation.id),
            AdminApiError,
        );
        assertEquals(error.code, "invalid_response");
    }
});

Deno.test("chat session uploads raw files using cookies and bypasses the bearer bridge", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const file = new File([bytes], asset.name, { type: asset.mediaType });
    const abort = new AbortController();
    let calls = 0;
    let bridgeCalls = 0;
    using _transport = respondWith(async (input, init) => {
        calls++;
        assertEquals(String(input), "/admin/chat/api/assets");
        assertEquals(init?.method, "POST");
        assertEquals(init?.credentials, "same-origin");
        assertStrictEquals(init?.body, file);
        assertStrictEquals(init?.signal, abort.signal);
        assertEquals(new Uint8Array(await file.arrayBuffer()), bytes);
        const headers = new Headers(init?.headers);
        assertEquals(headers.get("accept"), "application/json");
        assertEquals(headers.get("content-type"), "image/png");
        assertEquals(
            headers.get("x-file-name"),
            encodeURIComponent(asset.name),
        );
        assertEquals(headers.get("authorization"), null);
        return Response.json({ attachment: asset }, { status: 201 });
    });
    configureAdminTransport(() => {
        bridgeCalls++;
        return Promise.reject(
            new Error("session upload used the admin bridge"),
        );
    });
    setAdminToken("must-not-enter-session-upload");
    assertEquals(await createChatApi().upload(file, abort.signal), asset);
    assertEquals(calls, 1);
    assertEquals(bridgeCalls, 0);
});

Deno.test("chat upload rejects inline responses and malformed asset identities or sizes", async () => {
    let attachment: unknown;
    using _transport = respondWith(() => Response.json({ attachment }));
    const file = new File(["png-data"], "file.png", { type: "image/png" });
    for (
        const invalid of [
            null,
            { mediaType: "image/png", dataBase64: "aW1hZ2U=" },
            { ...asset, assetId: "../outside" },
            { ...asset, assetId: "file?id=other" },
            { ...asset, assetId: "" },
            { ...asset, size: 0 },
            { ...asset, size: -1 },
            { ...asset, size: 1.5 },
            { ...asset, size: "8" },
            { ...asset, mediaType: null },
        ]
    ) {
        attachment = invalid;
        const error = await assertRejects(
            () => createChatApi().upload(file),
            AdminApiError,
        );
        assertEquals(error.code, "invalid_response", JSON.stringify(invalid));
    }
});

Deno.test("chat history ignores remote and executable asset URLs while retaining legacy inline images", async () => {
    let url = "";
    const inline = { mediaType: "image/png", dataBase64: "aW1hZ2U=" };
    using _transport = respondWith(() =>
        Response.json({
            conversation,
            messages: [{
                ...messages[0],
                attachments: [{ ...asset, url }, inline],
            }],
        })
    );
    for (
        const unsafe of [
            "https://attacker.example/track",
            "//attacker.example/track",
            "javascript:alert(1)",
            "data:image/svg+xml,<svg onload=alert(1)>",
            "/admin/settings?token=leak",
        ]
    ) {
        url = unsafe;
        const loaded = await createChatApi().load(conversation.id);
        assertEquals(loaded.messages[0]?.attachments, [asset, inline]);
    }
});

Deno.test("chat history accepts an asset reference without optional presentation metadata", async () => {
    using _transport = respondWith(() =>
        Response.json({
            conversation,
            messages: [{
                ...messages[0],
                attachments: [{
                    assetId: asset.assetId,
                    mediaType: asset.mediaType,
                }],
            }],
        })
    );
    const loaded = await createChatApi().load(conversation.id);
    assertEquals(loaded.messages[0]?.attachments, [{
        assetId: asset.assetId,
        mediaType: asset.mediaType,
        url: asset.url,
    }]);
});

Deno.test("chat draft leases use cookie requests without image bytes and encode resource identities", async () => {
    const leaseId = "lease_1-draft";
    const abort = new AbortController();
    const paths: string[] = [];
    let bridgeCalls = 0;
    using _transport = respondWith((input, init) => {
        const path = String(input);
        paths.push(path);
        const headers = new Headers(init?.headers);
        assertEquals(init?.credentials, "same-origin");
        assertEquals(init?.body, undefined);
        assertEquals(headers.get("authorization"), null);
        assertEquals(headers.get("content-type"), null);
        assertEquals(headers.get("x-file-name"), null);
        assertEquals(headers.get("accept"), "application/json");
        if (init?.method === "POST") {
            assertStrictEquals(init.signal, abort.signal);
        } else assertEquals(init?.method, "DELETE");
        if (path.includes("%")) {
            return Response.json({
                error: {
                    code: "invalid_asset_id",
                    message: "Invalid identity",
                },
            }, { status: 400 });
        }
        return init?.method === "POST"
            ? Response.json({ attachment: { ...asset, leaseId } }, {
                status: 201,
            })
            : Response.json({ released: true });
    });
    configureAdminTransport(() => {
        bridgeCalls++;
        return Promise.reject(new Error("session lease used the admin bridge"));
    });
    setAdminToken("must-not-enter-lease-request");
    const api = createChatApi();
    assertEquals(await api.acquireAttachment(asset.assetId, abort.signal), {
        ...asset,
        leaseId,
    });
    await api.releaseAttachment(asset.assetId, leaseId);

    const specialAsset = "asset /?&中文";
    const specialLease = "lease /?&中文";
    const options = {
        endpoint: "/admin/chat/api/",
        session: true,
        signal: abort.signal,
    };
    for (
        const operation of [
            () => acquireChatAttachment(specialAsset, options),
            () => releaseChatAttachment(specialAsset, specialLease, options),
        ]
    ) {
        const error = await assertRejects(operation, AdminApiError);
        assertEquals(error.status, 400);
    }
    assertEquals(paths, [
        `/admin/chat/api/assets/${asset.assetId}/lease`,
        `/admin/chat/api/assets/${asset.assetId}/lease?leaseId=${leaseId}`,
        `/admin/chat/api/assets/${encodeURIComponent(specialAsset)}/lease`,
        `/admin/chat/api/assets/${
            encodeURIComponent(specialAsset)
        }/lease?leaseId=${encodeURIComponent(specialLease)}`,
    ]);
    const encoded = new URL(paths[3]!, "http://localhost");
    assertEquals([...encoded.searchParams], [["leaseId", specialLease]]);
    assertEquals(bridgeCalls, 0);
});

Deno.test("chat uploads retain a draft lease but history and branch responses discard it", async () => {
    const draft = { ...asset, leaseId: "lease_upload-draft" };
    const file = new File(["png-data"], asset.name, { type: asset.mediaType });
    const exposedHistory = {
        conversation,
        messages: [{ ...messages[0], attachments: [draft] }, messages[1]],
    };
    using _transport = respondWith((input) =>
        Response.json(
            String(input).endsWith("/assets")
                ? { attachment: draft }
                : exposedHistory,
        )
    );
    const api = createChatApi();
    assertEquals(await api.upload(file), draft);
    const expected = {
        conversation,
        messages: [{ ...messages[0], attachments: [asset] }, messages[1]],
    };
    assertEquals(await api.load(conversation.id), expected);
    assertEquals(
        await api.switchBranch(conversation.id, "assistant-2"),
        expected,
    );
});

Deno.test("chat lease acquisition validates its asset and lease while release requires a true acknowledgement", async () => {
    let payload: unknown;
    using _transport = respondWith(() => Response.json(payload));
    const api = createChatApi();
    for (
        const attachment of [
            asset,
            { ...asset, assetId: "other-asset", leaseId: "draft-lease" },
            { ...asset, leaseId: "" },
            { ...asset, leaseId: "lease?other=value" },
            { ...asset, leaseId: 42 },
        ]
    ) {
        payload = { attachment };
        const error = await assertRejects(
            () => api.acquireAttachment(asset.assetId),
            AdminApiError,
        );
        assertEquals(error.code, "invalid_response");
    }
    for (
        const acknowledgement of [null, {}, { released: false }, {
            released: "true",
        }]
    ) {
        payload = acknowledgement;
        const error = await assertRejects(
            () => api.releaseAttachment(asset.assetId, "draft-lease"),
            AdminApiError,
        );
        assertEquals(error.code, "invalid_response");
    }
});

Deno.test("chat branch and fork send message identities and return their respective conversation paths", async () => {
    const abort = new AbortController();
    const forked = {
        conversation: {
            ...conversation,
            id: "forked-conversation",
            activeMessageId: "forked-assistant",
        },
        messages: [{
            ...messages[1],
            id: "forked-assistant",
            conversationId: "forked-conversation",
            parentId: null,
            branch: { index: 0, count: 1, messageIds: ["forked-assistant"] },
        }],
    };
    const requests: string[] = [];
    using _transport = respondWith((input, init) => {
        const path = String(input);
        requests.push(path);
        assertEquals(init?.method, "POST");
        assertEquals(init?.credentials, "same-origin");
        assertStrictEquals(init?.signal, abort.signal);
        assertEquals(new Headers(init?.headers).get("authorization"), null);
        assertEquals(
            new Headers(init?.headers).get("content-type"),
            "application/json",
        );
        assertEquals(JSON.parse(String(init?.body)), {
            conversationId: conversation.id,
            messageId: "assistant-2",
        });
        return Response.json(path.endsWith("/fork") ? forked : history);
    });
    const api = createChatApi();
    assertEquals(
        await api.switchBranch(conversation.id, "assistant-2", abort.signal),
        history,
    );
    assertEquals(
        await api.fork(conversation.id, "assistant-2", abort.signal),
        forked,
    );
    assertEquals(requests, ["/admin/chat/api/branch", "/admin/chat/api/fork"]);
});

Deno.test("chat clients reject conversation and message identity mismatches", async () => {
    let response: unknown;
    using _transport = respondWith(() => Response.json(response));
    const api = createChatApi();
    for (
        const [operation, invalid] of [
            [
                () => api.load(conversation.id),
                {
                    conversation: { ...conversation, id: "other" },
                    messages: [],
                },
            ],
            [
                () => api.load(conversation.id),
                {
                    conversation,
                    messages: [{ ...messages[0], conversationId: "other" }],
                },
            ],
            [
                () => api.switchBranch(conversation.id, "assistant-2"),
                {
                    conversation: { ...conversation, id: "other" },
                    messages: [],
                },
            ],
            [
                () => api.switchBranch(conversation.id, "assistant-2"),
                {
                    conversation,
                    messages: [{ ...messages[0], conversationId: "other" }],
                },
            ],
            [
                () => api.fork(conversation.id, "assistant-2"),
                { conversation: { ...conversation, id: "forked" }, messages },
            ],
        ] as const
    ) {
        response = invalid;
        const error = await assertRejects(operation, AdminApiError);
        assertEquals(error.code, "invalid_response");
    }
});

Deno.test("legacy chat endpoints keep bearer authentication for branches, forks, binary assets, and inline history", async () => {
    const file = new File(["png-data"], "legacy.png", { type: "image/png" });
    const inline = { mediaType: "image/png", dataBase64: "aW1hZ2U=" };
    const legacyHistory = {
        conversation,
        messages: [{ ...messages[0], attachments: [inline] }],
    };
    const forked = {
        conversation: { ...conversation, id: "forked" },
        messages: [],
    };
    const paths: string[] = [];
    using _transport = respondWith((input, init) => {
        const path = String(input);
        paths.push(path);
        assertEquals(
            new Headers(init?.headers).get("authorization"),
            "Bearer legacy-chat-token",
        );
        if (path.endsWith("/assets")) {
            assertStrictEquals(init?.body, file);
            assertEquals(
                new Headers(init?.headers).get("content-type"),
                "image/png",
            );
            return Response.json({ attachment: asset });
        }
        return Response.json(path.endsWith("/fork") ? forked : legacyHistory);
    });
    setAdminToken("legacy-chat-token");
    assertEquals(await loadChatConversation(conversation.id), legacyHistory);
    assertEquals(
        await switchChatBranch(conversation.id, "user-1"),
        legacyHistory,
    );
    assertEquals(await forkChatConversation(conversation.id, "user-1"), forked);
    assertEquals(await uploadChatAttachment(file), asset);
    assertEquals(paths, [
        "/api/chat/conversation?id=conversation-1",
        "/api/chat/branch",
        "/api/chat/fork",
        "/api/chat/assets",
    ]);
});
