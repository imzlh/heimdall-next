import { assertEquals, assertThrows } from "@std/assert";
import type { ChatMessageRecord } from "@heimdall/storage";
import { StorageNotFoundError } from "@heimdall/storage";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";
import { DatabaseSync } from "node:sqlite";

Deno.test("chat history preserves insertion order across equal timestamps and clock changes", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-order-",
    });
    const path = `${directory}/chat.sqlite`;
    let store = openSqliteChatStore(path);
    try {
        const time = "2026-09-23T10:00:00.000Z";
        const conversation = store.createConversation("Ordering", time);
        const messages: ChatMessageRecord[] = [
            { id: "z-user", role: "user", text: "What time is it?" },
            {
                id: "y-call",
                role: "assistant",
                text: "{}",
                callId: "call-1",
                name: "current_time",
            },
            {
                id: "x-result",
                role: "tool",
                text: time,
                callId: "call-1",
                name: "current_time",
            },
            { id: "a-reply", role: "assistant", text: "It is 10:00." },
        ].map((item) => ({
            ...item,
            role: item.role as ChatMessageRecord["role"],
            conversationId: conversation.id,
            createdAt: time,
        }));
        for (const message of messages) store.addMessage(message);
        // A later turn remains later even if the system clock moves backwards.
        const last: ChatMessageRecord = {
            id: "b-later",
            conversationId: conversation.id,
            role: "user",
            text: "Thanks",
            createdAt: "2026-09-23T09:59:59.000Z",
        };
        store.addMessage(last);
        assertEquals(store.listMessages(conversation.id), [...messages, last]);
        store.close();
        store = openSqliteChatStore(path);
        assertEquals(store.listMessages(conversation.id), [...messages, last]);
        store.deleteMessages(["y-call", "x-result"]);
        assertEquals(
            store.listMessages(conversation.id).map((item) => item.id),
            ["z-user", "a-reply", "b-later"],
        );
    } finally {
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("conversation rename persists its title and timestamp after reopening", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-rename-",
    });
    const path = `${directory}/chat.sqlite`;
    let store = openSqliteChatStore(path);
    try {
        const createdAt = "2026-09-23T10:00:00.000Z";
        const updatedAt = "2026-09-23T11:00:00.000Z";
        const conversation = store.createConversation("Original", createdAt);
        store.updateConversation(conversation.id, {
            title: "Renamed conversation",
            updatedAt,
        });
        store.close();
        store = openSqliteChatStore(path);
        assertEquals(store.getConversation(conversation.id), {
            ...conversation,
            title: "Renamed conversation",
            updatedAt,
        });
    } finally {
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("conversation deletion removes all descendants while preserving another conversation", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-delete-",
    });
    const path = `${directory}/chat.sqlite`;
    let store = openSqliteChatStore(path);
    const db = new DatabaseSync(path);
    try {
        const createdAt = "2026-09-23T10:00:00.000Z";
        const removed = store.createConversation("Remove", createdAt);
        const retained = store.createConversation("Retain", createdAt);
        store.addMessage({
            id: "removed-user",
            conversationId: removed.id,
            role: "user",
            text: "Images",
            createdAt,
            attachments: [
                { mediaType: "image/png", dataBase64: "cG5n" },
                { mediaType: "image/jpeg", dataBase64: "anBlZw==" },
            ],
        });
        store.addMessage({
            id: "removed-assistant",
            conversationId: removed.id,
            role: "assistant",
            text: "Reply",
            createdAt,
        });
        const retainedMessage: ChatMessageRecord = {
            id: "retained-user",
            conversationId: retained.id,
            role: "user",
            text: "Keep this image",
            createdAt,
            attachments: [{ mediaType: "image/png", dataBase64: "a2VlcA==" }],
        };
        store.addMessage(retainedMessage);
        store.deleteConversation(removed.id);
        assertEquals(store.getConversation(removed.id), null);
        assertEquals(store.listMessages(removed.id), []);
        assertEquals(store.getConversation(retained.id), retained);
        assertEquals(store.listMessages(retained.id), [retainedMessage]);
        // Query the attachment table directly so orphaned rows cannot be hidden
        // by the inner join used by listMessages.
        assertEquals(
            db.prepare("SELECT message_id FROM message_attachments").all().map(
                (row) => row.message_id,
            ),
            [retainedMessage.id],
        );
        assertThrows(
            () => store.deleteConversation(removed.id),
            StorageNotFoundError,
        );
        store.close();
        store = openSqliteChatStore(path);
        assertEquals(store.listConversations(), [retained]);
        assertEquals(store.listMessages(retained.id), [retainedMessage]);
    } finally {
        db.close();
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("conversation deletion rolls back messages and attachments if the final delete fails", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-delete-rollback-",
    });
    const path = `${directory}/chat.sqlite`;
    const store = openSqliteChatStore(path);
    const db = new DatabaseSync(path);
    try {
        const createdAt = "2026-09-23T10:00:00.000Z";
        const conversation = store.createConversation(
            "Keep on failure",
            createdAt,
        );
        const message: ChatMessageRecord = {
            id: "user-with-attachment",
            conversationId: conversation.id,
            role: "user",
            text: "Image",
            createdAt,
            attachments: [{ mediaType: "image/png", dataBase64: "aW1hZ2U=" }],
        };
        store.addMessage(message);
        db.exec(`
            CREATE TRIGGER reject_conversation_delete
            BEFORE DELETE ON conversations
            BEGIN
                SELECT RAISE(ABORT, 'injected deletion failure');
            END;
        `);
        assertThrows(
            () => store.deleteConversation(conversation.id),
            Error,
            "injected deletion failure",
        );
        assertEquals(store.getConversation(conversation.id), conversation);
        assertEquals(store.listMessages(conversation.id), [message]);
        // After rollback the connection must accept a new transaction.
        db.exec("DROP TRIGGER reject_conversation_delete");
        store.deleteConversation(conversation.id);
        assertEquals(store.getConversation(conversation.id), null);
        assertEquals(store.listMessages(conversation.id), []);
    } finally {
        db.close();
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("conversation settings persist, migrate on legacy tables, and clear", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-settings-",
    });
    const path = `${directory}/chat.sqlite`;
    // A legacy table without the settings columns must migrate on open.
    const legacy = new DatabaseSync(path);
    legacy.exec(
        `CREATE TABLE conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )`,
    );
    legacy.close();
    const store = openSqliteChatStore(path);
    try {
        const time = "2026-09-26T10:00:00.000Z";
        const conversation = store.createConversation("Settings", time);
        store.updateConversation(conversation.id, {
            updatedAt: time,
            systemPrompt: "Always answer in Chinese.",
            reasoningEffort: "high",
        });
        const updated = store.getConversation(conversation.id);
        assertEquals(updated?.systemPrompt, "Always answer in Chinese.");
        assertEquals(updated?.reasoningEffort, "high");

        // Empty strings clear; undefined keeps.
        store.updateConversation(conversation.id, {
            updatedAt: time,
            systemPrompt: "",
        });
        const cleared = store.getConversation(conversation.id);
        assertEquals(cleared?.systemPrompt, undefined);
        assertEquals(cleared?.reasoningEffort, "high");
    } finally {
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});
