import { assertEquals, assertNotEquals } from "@std/assert";
import { createServer } from "../main.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";

const origin = "http://localhost";
const createdAt = "2026-09-22T00:00:00.000Z";

Deno.test("chat conversation rename and deletion update real history without changing other conversations", async () => {
    const store = openSqliteChatStore(":memory:");
    try {
        const app = createServer({ chat: { store } });
        const conversation = store.createConversation("原来的标题", createdAt);
        const other = store.createConversation("保留的对话", createdAt);
        const message = {
            id: "image-message",
            conversationId: conversation.id,
            role: "user" as const,
            text: "看看这张图片",
            createdAt,
            attachments: [{ mediaType: "image/png", dataBase64: "aGVsbG8=" }],
        };
        store.addMessage(message);
        const url = `${origin}/api/chat/conversation?id=${conversation.id}`;
        const renamed = await app.request(url, {
            method: "PATCH",
            headers: {
                "content-type": "application/json",
                "x-request-id": "rename-conversation",
            },
            body: JSON.stringify({ title: "  整理后的标题  " }),
        });
        assertEquals(renamed.status, 200);
        assertEquals(
            renamed.headers.get("x-heimdall-request-id"),
            "rename-conversation",
        );
        const { conversation: updated } = await renamed.json();
        assertEquals(updated.id, conversation.id);
        assertEquals(updated.title, "整理后的标题");
        assertEquals(updated.createdAt, createdAt);
        assertNotEquals(updated.updatedAt, createdAt);
        assertEquals(store.getConversation(conversation.id), updated);
        assertEquals(store.listMessages(conversation.id), [message]);
        const loaded = await app.request(url);
        assertEquals((await loaded.json()).conversation.title, "整理后的标题");

        const deleted = await app.request(url, { method: "DELETE" });
        assertEquals(deleted.status, 200);
        assertEquals(await deleted.json(), {
            deleted: true,
            id: conversation.id,
        });
        assertEquals(store.listMessages(conversation.id), []);
        assertEquals(store.listConversations(), [other]);
        assertEquals((await app.request(url)).status, 404);
        const missing = await app.request(url, { method: "DELETE" });
        assertEquals(missing.status, 404);
        assertEquals((await missing.json()).error.code, "not_found");
    } finally {
        store.close();
    }
});

Deno.test("chat conversation mutations reject invalid ids and titles without changing stored data", async () => {
    const store = openSqliteChatStore(":memory:");
    try {
        const app = createServer({ chat: { store } });
        const conversation = store.createConversation("原来的标题", createdAt);
        const url = `${origin}/api/chat/conversation?id=${conversation.id}`;
        for (
            const title of [
                undefined,
                null,
                7,
                [],
                "",
                " \n ",
                "字".repeat(121),
            ]
        ) {
            const response = await app.request(url, {
                method: "PATCH",
                body: JSON.stringify({ title }),
            });
            assertEquals(response.status, 400);
            assertEquals((await response.json()).error.code, "invalid_request");
            assertEquals(store.getConversation(conversation.id), conversation);
        }
        const malformed = await app.request(url, {
            method: "PATCH",
            body: "{",
        });
        assertEquals(malformed.status, 400);
        assertEquals((await malformed.json()).error.code, "invalid_json");
        for (const method of ["PATCH", "DELETE"]) {
            for (const suffix of ["", "?id=", "?id=%20"]) {
                const response = await app.request(
                    `${origin}/api/chat/conversation${suffix}`,
                    { method, body: JSON.stringify({ title: "新标题" }) },
                );
                assertEquals(response.status, 400);
                assertEquals(
                    (await response.json()).error.code,
                    "invalid_request",
                );
            }
            const missing = await app.request(
                `${origin}/api/chat/conversation?id=missing`,
                { method, body: JSON.stringify({ title: "新标题" }) },
            );
            assertEquals(missing.status, 404);
            assertEquals((await missing.json()).error.code, "not_found");
        }
        const maximum = await app.request(url, {
            method: "PATCH",
            body: JSON.stringify({ title: ` ${"字".repeat(120)} ` }),
        });
        assertEquals(maximum.status, 200);
        assertEquals(
            (await maximum.json()).conversation.title,
            "字".repeat(120),
        );
    } finally {
        store.close();
    }
});

Deno.test("chat rename and deletion preserve Bearer and browser session authorization boundaries", async () => {
    const store = openSqliteChatStore(":memory:");
    try {
        const token = "conversation-admin-token";
        const app = createServer({ adminAuthToken: token, chat: { store } });
        const conversation = store.createConversation("原来的标题", createdAt);
        for (const path of ["/api/chat", "/admin/chat/api"]) {
            for (const method of ["PATCH", "DELETE"]) {
                const denied = await app.request(
                    `${origin}${path}/conversation?id=${conversation.id}`,
                    {
                        method,
                        headers: { origin },
                        body: JSON.stringify({ title: "不应保存" }),
                    },
                );
                assertEquals(denied.status, 401);
                assertEquals((await denied.json()).error.code, "unauthorized");
            }
        }
        assertEquals(store.getConversation(conversation.id), conversation);
        for (const method of ["PATCH", "DELETE"]) {
            const allowed = await app.request(
                `${origin}/api/chat/conversation?id=${conversation.id}`,
                {
                    method,
                    headers: { authorization: `Bearer ${token}` },
                    body: JSON.stringify({ title: "已获授权" }),
                },
            );
            assertEquals(allowed.status, 200);
            await allowed.body?.cancel();
        }
        assertEquals(store.getConversation(conversation.id), null);
    } finally {
        store.close();
    }
});

Deno.test("a rename that finishes reading after deletion cannot recreate the conversation", async () => {
    const store = openSqliteChatStore(":memory:");
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let pending: Promise<Response> | undefined;
    try {
        const app = createServer({ chat: { store } });
        const conversation = store.createConversation("原来的标题", createdAt);
        const url = `${origin}/api/chat/conversation?id=${conversation.id}`;
        const reading = Promise.withResolvers<void>();
        const body = new ReadableStream<Uint8Array>({
            start(value) {
                controller = value;
            },
            pull() {
                reading.resolve();
            },
        });
        pending = Promise.resolve(app.request(url, { method: "PATCH", body }));
        await reading.promise;
        const removed = await app.request(url, { method: "DELETE" });
        assertEquals(removed.status, 200);
        await removed.json();
        controller!.enqueue(new TextEncoder().encode('{"title":"迟到的修改"}'));
        controller!.close();
        controller = undefined;
        const renamed = await pending;
        assertEquals(renamed.status, 404);
        assertEquals((await renamed.json()).error.code, "not_found");
        assertEquals(store.listConversations(), []);
    } finally {
        controller?.close();
        await pending;
        store.close();
    }
});
