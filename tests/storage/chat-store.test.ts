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
        const expected = [...messages, last].map((item, index, ordered) => ({
            ...item,
            parentId: index === 0 ? null : ordered[index - 1]!.id,
        }));
        assertEquals(store.listMessages(conversation.id), expected);
        assertEquals(
            store.getConversation(conversation.id)?.activeMessageId,
            last.id,
        );
        store.close();
        store = openSqliteChatStore(path);
        assertEquals(store.listMessages(conversation.id), expected);
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

Deno.test("assistant reasoning, activity and citations persist across reopen", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-meta-",
    });
    const path = `${directory}/chat.sqlite`;
    let store = openSqliteChatStore(path);
    try {
        const time = "2026-09-28T10:00:00.000Z";
        const conversation = store.createConversation("Meta", time);
        store.addMessage({
            id: "u",
            conversationId: conversation.id,
            role: "user",
            text: "北京天气",
            createdAt: time,
        });
        const reply: ChatMessageRecord = {
            id: "a",
            conversationId: conversation.id,
            role: "assistant",
            text: "北京今天晴。",
            createdAt: time,
            reasoning: "先想想再查证。",
            activity: [{ summary: "🔍 搜索：北京 天气" }],
            citations: [{ label: "天气来源", url: "https://ref.example/a" }],
        };
        store.addMessage(reply);
        store.close();
        store = openSqliteChatStore(path);
        const stored = store.listMessages(conversation.id).find((row) =>
            row.id === "a"
        );
        assertEquals(stored?.reasoning, "先想想再查证。");
        assertEquals(stored?.activity, [{ summary: "🔍 搜索：北京 天气" }]);
        assertEquals(stored?.citations, [{
            label: "天气来源",
            url: "https://ref.example/a",
        }]);
    } finally {
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("chat history ignores an existing provider quota column and writes new replies", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-legacy-meta-",
    });
    const path = `${directory}/chat.sqlite`;
    let store = openSqliteChatStore(path);
    try {
        const time = "2026-09-29T00:00:00.000Z";
        const conversation = store.createConversation("Legacy metadata", time);
        const reply: ChatMessageRecord = {
            id: "legacy-reply",
            conversationId: conversation.id,
            role: "assistant",
            text: "A readable reply",
            createdAt: time,
        };
        store.addMessage(reply);
        store.close();
        const database = new DatabaseSync(path);
        try {
            const columns = database.prepare("PRAGMA table_info(messages)")
                .all().map((column) => column.name);
            assertEquals(columns.includes("quota"), false);
            database.exec("ALTER TABLE messages ADD COLUMN quota TEXT");
            database.prepare("UPDATE messages SET quota=? WHERE id=?").run(
                JSON.stringify({ meters: [{ name: "sample", remaining: 50 }] }),
                reply.id,
            );
        } finally {
            database.close();
        }
        store = openSqliteChatStore(path);
        assertEquals(store.listMessages(conversation.id), [{
            ...reply,
            parentId: null,
        }]);
        const next: ChatMessageRecord = {
            ...reply,
            id: "new-reply",
            text: "A new reply",
        };
        store.addMessage(next);
        assertEquals(store.listMessages(conversation.id), [
            { ...reply, parentId: null },
            { ...next, parentId: reply.id },
        ]);
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
        const retainedConversation = {
            ...retained,
            activeMessageId: retainedMessage.id,
        };
        const retainedMessages = [{ ...retainedMessage, parentId: null }];
        store.deleteConversation(removed.id);
        assertEquals(store.getConversation(removed.id), null);
        assertEquals(store.listMessages(removed.id), []);
        assertEquals(store.getConversation(retained.id), retainedConversation);
        assertEquals(store.listMessages(retained.id), retainedMessages);
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
        assertEquals(store.listConversations(), [retainedConversation]);
        assertEquals(store.listMessages(retained.id), retainedMessages);
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
        assertEquals(store.getConversation(conversation.id), {
            ...conversation,
            activeMessageId: message.id,
        });
        assertEquals(store.listMessages(conversation.id), [{
            ...message,
            parentId: null,
        }]);
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

Deno.test("legacy chat migration follows per-conversation insertion order and runs only once", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-tree-migrate-",
    });
    const path = `${directory}/chat.sqlite`;
    const legacy = new DatabaseSync(path);
    try {
        legacy.exec(`
            CREATE TABLE conversations (
                id TEXT PRIMARY KEY, title TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE messages (
                id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
                role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            );
            CREATE TABLE message_attachments (
                message_id TEXT NOT NULL, position INTEGER NOT NULL,
                media_type TEXT NOT NULL, data_base64 TEXT NOT NULL,
                PRIMARY KEY (message_id, position),
                FOREIGN KEY (message_id) REFERENCES messages(id)
            );
        `);
        const insertConversation = legacy.prepare(
            "INSERT INTO conversations VALUES (?, ?, ?, ?)",
        );
        for (const id of ["first", "second", "empty"]) {
            insertConversation.run(id, id, "2026-09-27", "2026-09-27");
        }
        const insertMessage = legacy.prepare(
            "INSERT INTO messages VALUES (?, ?, ?, ?, ?)",
        );
        // IDs, equal timestamps, clock rollback and interleaved conversations
        // must not reorder the history or join nodes from different conversations.
        for (
            const [id, conversationId, role, createdAt] of [
                ["z-user", "first", "user", "2026-09-27T10:00:00.000Z"],
                ["z-other", "second", "user", "2026-09-27T11:00:00.000Z"],
                ["a-answer", "first", "assistant", "2026-09-27T10:00:00.000Z"],
                ["a-other", "second", "assistant", "2026-09-27T09:00:00.000Z"],
                ["m-later", "first", "user", "2026-09-27T09:59:00.000Z"],
            ] as const
        ) {
            insertMessage.run(id, conversationId, role, id, createdAt);
        }
        legacy.prepare("INSERT INTO message_attachments VALUES (?, ?, ?, ?)")
            .run("z-user", 0, "image/png", "cG5n");
    } finally {
        legacy.close();
    }
    let store = openSqliteChatStore(path);
    try {
        const firstPath = store.listMessages("first");
        assertEquals(firstPath.map((m) => [m.id, m.parentId]), [
            ["z-user", null],
            ["a-answer", "z-user"],
            ["m-later", "a-answer"],
        ]);
        assertEquals(firstPath[0]?.attachments, [{
            mediaType: "image/png",
            dataBase64: "cG5n",
        }]);
        assertEquals(
            store.listMessages("second").map((m) => [m.id, m.parentId]),
            [
                ["z-other", null],
                ["a-other", "z-other"],
            ],
        );
        assertEquals(
            store.getConversation("first")?.activeMessageId,
            "m-later",
        );
        assertEquals(
            store.getConversation("second")?.activeMessageId,
            "a-other",
        );
        assertEquals(store.listMessages("empty"), []);
        assertEquals(
            store.getConversation("empty")?.activeMessageId,
            undefined,
        );
        store.addMessage({
            id: "new-variant",
            conversationId: "first",
            parentId: "z-user",
            role: "assistant",
            text: "alternative",
            createdAt: "2026-09-27T12:00:00.000Z",
        });
        const branched = store.listAllMessages("first");
        store.close();
        store = openSqliteChatStore(path);
        assertEquals(store.listAllMessages("first"), branched);
        assertEquals(store.listMessages("first").map((m) => m.id), [
            "z-user",
            "new-variant",
        ]);
        store.selectBranch("first", "a-answer", "2026-09-27T13:00:00.000Z");
        assertEquals(store.listMessages("first").map((m) => m.id), [
            "z-user",
            "a-answer",
            "m-later",
        ]);
        assertEquals(
            store.getConversation("first")?.activeMessageId,
            "m-later",
        );
        assertEquals(
            store.getConversation("second")?.activeMessageId,
            "a-other",
        );
    } finally {
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("chat append rolls back the entire branch and selection when a later attachment fails", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-append-rollback-",
    });
    const path = `${directory}/chat.sqlite`;
    const store = openSqliteChatStore(path);
    const db = new DatabaseSync(path);
    try {
        const time = "2026-09-27T10:00:00.000Z";
        const conversation = store.createConversation("Existing branch", time);
        const base = { conversationId: conversation.id, createdAt: time };
        store.appendMessages([
            { ...base, id: "original-user", role: "user", text: "question" },
            {
                ...base,
                id: "original-reply",
                role: "assistant",
                text: "answer",
            },
        ]);
        const beforeConversation = store.getConversation(conversation.id);
        const beforeMessages = store.listAllMessages(conversation.id);
        const beforeRows = db.prepare(
            "SELECT id, parent_id, selected_child_id FROM messages ORDER BY rowid",
        ).all();
        db.exec(`
            CREATE TRIGGER reject_later_attachment
            BEFORE INSERT ON message_attachments
            WHEN NEW.media_type = 'image/failure'
            BEGIN
                SELECT RAISE(ABORT, 'injected attachment failure');
            END;
        `);
        const attempted: ChatMessageRecord[] = [
            {
                ...base,
                id: "new-reply",
                parentId: "original-user",
                role: "assistant",
                text: "new branch",
                attachments: [{ mediaType: "image/png", dataBase64: "cG5n" }],
            },
            {
                ...base,
                id: "new-question",
                role: "user",
                text: "follow new branch",
                attachments: [{
                    mediaType: "image/failure",
                    dataBase64: "ZmFpbA==",
                }],
            },
        ];
        assertThrows(
            () => store.appendMessages(attempted),
            Error,
            "injected attachment failure",
        );
        assertEquals(
            store.getConversation(conversation.id),
            beforeConversation,
        );
        assertEquals(store.listAllMessages(conversation.id), beforeMessages);
        assertEquals(
            db.prepare(
                "SELECT id, parent_id, selected_child_id FROM messages ORDER BY rowid",
            ).all(),
            beforeRows,
        );
        assertEquals(db.prepare("SELECT * FROM message_attachments").all(), []);
        // Reusing both IDs and the same connection proves rollback closed the
        // transaction and removed the first message as well as the failing one.
        db.exec("DROP TRIGGER reject_later_attachment");
        store.appendMessages(attempted);
        assertEquals(store.listMessages(conversation.id).map((m) => m.id), [
            "original-user",
            "new-reply",
            "new-question",
        ]);
        store.selectBranch(conversation.id, "original-reply", time);
        assertEquals(store.listMessages(conversation.id).map((m) => m.id), [
            "original-user",
            "original-reply",
        ]);
        store.selectBranch(conversation.id, "new-reply", time);
        assertEquals(
            store.getConversation(conversation.id)?.activeMessageId,
            "new-question",
        );
    } finally {
        db.close();
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("chat fork rolls back its new conversation and copied attachments when a later message fails", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-fork-rollback-",
    });
    const path = `${directory}/chat.sqlite`;
    const store = openSqliteChatStore(path);
    const db = new DatabaseSync(path);
    try {
        const time = "2026-09-27T10:00:00.000Z";
        const conversation = store.createConversation("Original", time);
        store.updateConversation(conversation.id, {
            updatedAt: time,
            systemPrompt: "Answer briefly.",
            reasoningEffort: "low",
        });
        const base = { conversationId: conversation.id, createdAt: time };
        store.appendMessages([
            {
                ...base,
                id: "source-user",
                role: "user",
                text: "question",
                attachments: [{ mediaType: "image/png", dataBase64: "cG5n" }],
            },
            {
                ...base,
                id: "source-reply",
                role: "assistant",
                text: "fail copying this node",
            },
            {
                ...base,
                id: "source-later",
                role: "user",
                text: "later question",
            },
        ]);
        const beforeConversations = store.listConversations();
        const beforeMessages = db.prepare(
            "SELECT * FROM messages ORDER BY rowid",
        ).all();
        const beforeAttachments = db.prepare(
            "SELECT * FROM message_attachments",
        ).all();
        db.exec(`
            CREATE TRIGGER reject_forked_reply
            BEFORE INSERT ON messages
            WHEN NEW.text = 'fail copying this node' AND NEW.id <> 'source-reply'
            BEGIN
                SELECT RAISE(ABORT, 'injected fork failure');
            END;
        `);
        assertThrows(
            () =>
                store.forkConversation(
                    conversation.id,
                    "source-reply",
                    time,
                    "Failed fork",
                ),
            Error,
            "injected fork failure",
        );
        assertEquals(store.listConversations(), beforeConversations);
        assertEquals(
            db.prepare("SELECT * FROM messages ORDER BY rowid").all(),
            beforeMessages,
        );
        assertEquals(
            db.prepare("SELECT * FROM message_attachments").all(),
            beforeAttachments,
        );
        assertEquals(
            store.getConversation(conversation.id)?.activeMessageId,
            "source-later",
        );
        db.exec("DROP TRIGGER reject_forked_reply");
        const fork = store.forkConversation(
            conversation.id,
            "source-reply",
            time,
        );
        assertEquals(fork.systemPrompt, "Answer briefly.");
        assertEquals(fork.reasoningEffort, "low");
        assertEquals(store.listMessages(fork.id).map((m) => m.text), [
            "question",
            "fail copying this node",
        ]);
        assertEquals(store.listMessages(fork.id)[0]?.attachments, [{
            mediaType: "image/png",
            dataBase64: "cG5n",
        }]);
        assertEquals(
            store.getConversation(conversation.id)?.activeMessageId,
            "source-later",
        );
    } finally {
        db.close();
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("chat deletion splices consecutive nodes while keeping sibling subtrees selectable", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-splice-",
    });
    const path = `${directory}/chat.sqlite`;
    let store = openSqliteChatStore(path);
    const db = new DatabaseSync(path);
    try {
        const time = "2026-09-27T10:00:00.000Z";
        const conversation = store.createConversation("Splice tree", time);
        const base = { conversationId: conversation.id, createdAt: time };
        const attachment = { mediaType: "image/png", dataBase64: "cG5n" };
        store.appendMessages([
            { ...base, id: "root", role: "user", text: "question" },
            {
                ...base,
                id: "old-reply",
                role: "assistant",
                text: "first answer",
            },
            {
                ...base,
                id: "remove-user",
                role: "user",
                text: "remove question",
                attachments: [attachment],
            },
            {
                ...base,
                id: "remove-reply",
                role: "assistant",
                text: "remove answer",
            },
            {
                ...base,
                id: "keep-tail",
                role: "user",
                text: "later question",
                attachments: [attachment],
            },
            {
                ...base,
                id: "sibling",
                parentId: "root",
                role: "assistant",
                text: "alternate answer",
            },
            {
                ...base,
                id: "sibling-user",
                role: "user",
                text: "alternate question",
                attachments: [attachment],
            },
            {
                ...base,
                id: "sibling-reply",
                role: "assistant",
                text: "alternate final answer",
            },
        ]);
        const siblingBefore = store.listMessages(conversation.id);
        store.selectBranch(conversation.id, "old-reply", time);
        store.deleteMessages([
            "remove-user",
            "remove-reply",
            "already-missing",
        ]);
        assertEquals(
            store.listMessages(conversation.id).map((m) => [m.id, m.parentId]),
            [
                ["root", null],
                ["old-reply", "root"],
                ["keep-tail", "old-reply"],
            ],
        );
        assertEquals(
            store.getConversation(conversation.id)?.activeMessageId,
            "keep-tail",
        );
        assertEquals(store.listAllMessages(conversation.id).length, 6);
        assertEquals(
            db.prepare(
                "SELECT message_id FROM message_attachments ORDER BY message_id",
            )
                .all().map((row) => row.message_id),
            ["keep-tail", "sibling-user"],
        );
        store.selectBranch(conversation.id, "sibling", time);
        assertEquals(store.listMessages(conversation.id), siblingBefore);
        store.close();
        store = openSqliteChatStore(path);
        store.selectBranch(conversation.id, "old-reply", time);
        assertEquals(store.listMessages(conversation.id).map((m) => m.id), [
            "root",
            "old-reply",
            "keep-tail",
        ]);
        store.deleteMessages(["keep-tail"]);
        assertEquals(
            store.getConversation(conversation.id)?.activeMessageId,
            "old-reply",
        );
        assertEquals(store.listMessages(conversation.id).map((m) => m.id), [
            "root",
            "old-reply",
        ]);
        store.selectBranch(conversation.id, "sibling", time);
        assertEquals(store.listMessages(conversation.id), siblingBefore);
        assertEquals(
            db.prepare("SELECT message_id FROM message_attachments")
                .all().map((row) => row.message_id),
            ["sibling-user"],
        );
    } finally {
        db.close();
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("deleting the complete selected root variant restores the surviving root and its descendants", () => {
    const store = openSqliteChatStore(":memory:");
    try {
        const time = "2026-09-27T10:00:00.000Z";
        const conversation = store.createConversation("Root variants", time);
        const base = { conversationId: conversation.id, createdAt: time };
        store.appendMessages([
            {
                ...base,
                id: "original-root",
                role: "user",
                text: "original question",
            },
            {
                ...base,
                id: "original-answer",
                role: "assistant",
                text: "original answer",
            },
            {
                ...base,
                id: "original-followup",
                role: "user",
                text: "followup question",
            },
            {
                ...base,
                id: "original-leaf",
                role: "assistant",
                text: "followup answer",
            },
        ]);
        const original = store.listMessages(conversation.id);
        store.appendMessages([
            {
                ...base,
                id: "edited-root",
                parentId: null,
                role: "user",
                text: "edited question",
            },
            {
                ...base,
                id: "edited-answer",
                role: "assistant",
                text: "edited answer",
            },
        ]);
        assertEquals(store.listMessages(conversation.id).map((m) => m.id), [
            "edited-root",
            "edited-answer",
        ]);
        store.deleteMessages(["edited-root", "edited-answer"]);
        assertEquals(store.listMessages(conversation.id), original);
        assertEquals(store.listAllMessages(conversation.id), original);
        assertEquals(
            store.getConversation(conversation.id)?.activeMessageId,
            "original-leaf",
        );
    } finally {
        store.close();
    }
});

Deno.test("chat variant groups survive ancestry deletion, further edits and reopening", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-stable-groups-",
    });
    const path = `${directory}/chat.sqlite`;
    let store = openSqliteChatStore(path);
    try {
        const time = "2026-09-27T10:00:00.000Z";
        const conversation = store.createConversation("Stable variants", time);
        const base = { conversationId: conversation.id, createdAt: time };
        store.appendMessages([
            { ...base, id: "u1", role: "user", text: "first question" },
            { ...base, id: "a1", role: "assistant", text: "first answer" },
            { ...base, id: "u2", role: "user", text: "later question" },
            { ...base, id: "a2", role: "assistant", text: "later answer" },
            {
                ...base,
                id: "u1edit",
                parentId: null,
                variantOf: "u1",
                role: "user",
                text: "edited first question",
            },
            {
                ...base,
                id: "a1edit",
                role: "assistant",
                text: "edited question answer",
            },
            {
                ...base,
                id: "a1alt",
                parentId: "u1",
                variantOf: "a1",
                role: "assistant",
                text: "alternative first answer",
            },
        ]);
        assertEquals(
            store.listAllMessages(conversation.id).find((m) => m.id === "u1")
                ?.branch?.messageIds,
            ["u1", "u1edit"],
        );
        assertEquals(
            store.listAllMessages(conversation.id).find((m) => m.id === "a1")
                ?.branch?.messageIds,
            ["a1", "a1alt"],
        );
        store.deleteMessages(["u1", "a1"]);
        const spliced = store.listAllMessages(conversation.id);
        assertEquals(
            spliced.filter((m) => m.parentId === null).map((m) => m.id),
            ["u2", "u1edit", "a1alt"],
        );
        // The two surviving user roots came from different turns. Their new
        // shared parent is a deletion artifact, not evidence of a variant.
        assertEquals(spliced.filter((m) => m.branch !== undefined), []);
        store.appendMessages([
            {
                ...base,
                id: "a1alt-edit",
                parentId: null,
                variantOf: "a1alt",
                role: "assistant",
                text: "edited alternative",
            },
            {
                ...base,
                id: "a1alt-remake",
                parentId: null,
                variantOf: "a1alt",
                role: "assistant",
                text: "regenerated alternative",
            },
            {
                ...base,
                id: "u1edit-again",
                parentId: null,
                variantOf: "u1edit",
                role: "user",
                text: "edited first question again",
            },
        ]);
        const final = store.listAllMessages(conversation.id);
        for (const id of ["a1alt", "a1alt-edit", "a1alt-remake"]) {
            assertEquals(final.find((m) => m.id === id)?.branch?.messageIds, [
                "a1alt",
                "a1alt-edit",
                "a1alt-remake",
            ]);
        }
        for (const id of ["u1edit", "u1edit-again"]) {
            assertEquals(final.find((m) => m.id === id)?.branch?.messageIds, [
                "u1edit",
                "u1edit-again",
            ]);
        }
        assertEquals(final.find((m) => m.id === "u2")?.branch, undefined);
        store.close();
        store = openSqliteChatStore(path);
        assertEquals(store.listAllMessages(conversation.id), final);
        store.selectBranch(conversation.id, "u2", time);
        assertEquals(store.listMessages(conversation.id).map((m) => m.id), [
            "u2",
            "a2",
        ]);
        store.selectBranch(conversation.id, "u1edit", time);
        assertEquals(store.listMessages(conversation.id).map((m) => m.id), [
            "u1edit",
            "a1edit",
        ]);
        store.selectBranch(conversation.id, "a1alt-remake", time);
        assertEquals(store.listMessages(conversation.id).map((m) => m.id), [
            "a1alt-remake",
        ]);
        assertEquals(store.listMessages(conversation.id)[0]?.branch, {
            index: 2,
            count: 3,
            messageIds: ["a1alt", "a1alt-edit", "a1alt-remake"],
        });
    } finally {
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("chat append rolls back its variant, attachments and selection when updating the timestamp fails", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-append-timestamp-",
    });
    const path = `${directory}/chat.sqlite`;
    const store = openSqliteChatStore(path);
    const db = new DatabaseSync(path);
    try {
        const time = "2026-09-27T10:00:00.000Z";
        const updatedAt = "2026-09-27T11:00:00.000Z";
        const conversation = store.createConversation("Existing title", time);
        const base = { conversationId: conversation.id, createdAt: time };
        store.appendMessages([
            { ...base, id: "original-user", role: "user", text: "question" },
            {
                ...base,
                id: "original-reply",
                role: "assistant",
                text: "answer",
            },
            {
                ...base,
                id: "alternate-reply",
                parentId: "original-user",
                variantOf: "original-reply",
                role: "assistant",
                text: "alternative answer",
            },
        ]);
        const beforeConversation = store.getConversation(conversation.id);
        const beforeMessages = store.listAllMessages(conversation.id);
        const beforeRows = db.prepare("SELECT * FROM messages ORDER BY rowid")
            .all();
        assertEquals(beforeMessages[1]?.branch?.count, 2);
        db.exec(`
            CREATE TRIGGER reject_conversation_timestamp
            BEFORE UPDATE OF updated_at ON conversations
            BEGIN
                SELECT RAISE(ABORT, 'injected timestamp failure');
            END;
        `);
        const edited: ChatMessageRecord = {
            ...base,
            id: "edited-reply",
            parentId: "original-user",
            variantOf: "alternate-reply",
            role: "assistant",
            text: "edited answer",
            attachments: [{ mediaType: "image/png", dataBase64: "cG5n" }],
        };
        const patch = { title: "Edited title", updatedAt };
        assertThrows(
            () => store.appendMessages([edited], patch),
            Error,
            "injected timestamp failure",
        );
        assertEquals(
            store.getConversation(conversation.id),
            beforeConversation,
        );
        assertEquals(store.listAllMessages(conversation.id), beforeMessages);
        assertEquals(
            db.prepare("SELECT * FROM messages ORDER BY rowid").all(),
            beforeRows,
        );
        assertEquals(db.prepare("SELECT * FROM message_attachments").all(), []);
        assertEquals(
            store.listMessages(conversation.id).at(-1)?.branch?.count,
            2,
        );
        db.exec("DROP TRIGGER reject_conversation_timestamp");
        store.appendMessages([edited], patch);
        assertEquals(store.getConversation(conversation.id), {
            ...conversation,
            title: patch.title,
            updatedAt,
            activeMessageId: edited.id,
        });
        assertEquals(
            store.listMessages(conversation.id).at(-1)?.branch?.messageIds,
            ["original-reply", "alternate-reply", "edited-reply"],
        );
    } finally {
        db.close();
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("conversation disabled tools persist, fork, and clear", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-muted-tools-",
    });
    const store = openSqliteChatStore(`${directory}/chat.sqlite`);
    try {
        const time = "2026-09-27T10:00:00.000Z";
        const conversation = store.createConversation("Muted", time);
        store.updateConversation(conversation.id, {
            updatedAt: time,
            disabledTools: ["heimdall.tool.web"],
        });
        assertEquals(
            store.getConversation(conversation.id)?.disabledTools,
            ["heimdall.tool.web"],
        );

        // Undefined keeps the list; an empty array clears it.
        store.updateConversation(conversation.id, { updatedAt: time });
        assertEquals(
            store.getConversation(conversation.id)?.disabledTools,
            ["heimdall.tool.web"],
        );
        store.updateConversation(conversation.id, {
            updatedAt: time,
            disabledTools: [],
        });
        assertEquals(
            store.getConversation(conversation.id)?.disabledTools,
            undefined,
        );

        // Re-set and confirm a fork carries the switches over.
        store.updateConversation(conversation.id, {
            updatedAt: time,
            disabledTools: ["heimdall.tool.web", "heimdall.tool.clock"],
        });
        store.appendMessages([
            {
                id: "root-1",
                conversationId: conversation.id,
                role: "user",
                text: "question",
                createdAt: time,
            },
        ]);
        const fork = store.forkConversation(
            conversation.id,
            "root-1",
            time,
        );
        assertEquals(fork.disabledTools, [
            "heimdall.tool.web",
            "heimdall.tool.clock",
        ]);
    } finally {
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});
