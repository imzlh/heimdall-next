import type {
    ChatAttachment,
    ChatMessageRecord,
    ChatStore,
    ConversationRecord,
} from "@heimdall/storage";
import { StorageNotFoundError } from "@heimdall/storage";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  system_prompt TEXT,
  reasoning_effort TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  call_id TEXT,
  tool_name TEXT,
  status TEXT,
  error_code TEXT,
  error_message TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
CREATE TABLE IF NOT EXISTS message_attachments (
  message_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  data_base64 TEXT NOT NULL,
  PRIMARY KEY (message_id, position),
  FOREIGN KEY (message_id) REFERENCES messages(id)
);
CREATE INDEX IF NOT EXISTS messages_conversation
  ON messages(conversation_id, created_at, id);
`;

interface ConversationRow {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
    system_prompt: string | null;
    reasoning_effort: string | null;
}

interface MessageRow {
    id: string;
    conversation_id: string;
    role: string;
    text: string;
    created_at: string;
    call_id: string | null;
    tool_name: string | null;
    status: string | null;
    error_code: string | null;
    error_message: string | null;
}

interface RunResult {
    changes: number | bigint;
}

/** SQLite adapter for single-tenant chat history. */
export class SqliteChatStore implements ChatStore {
    readonly #db: DatabaseSync;
    #closed = false;

    constructor(db: DatabaseSync) {
        this.#db = db;
    }

    createConversation(title: string, now: string): ConversationRecord {
        this.#alive();
        const id = crypto.randomUUID();
        const record = {
            id,
            title: title.trim() || "新对话",
            createdAt: now,
            updatedAt: now,
        };
        this.#db.prepare(
            `INSERT INTO conversations (id, title, created_at, updated_at)
             VALUES (?, ?, ?, ?)`,
        ).run(record.id, record.title, record.createdAt, record.updatedAt);
        return record;
    }

    listConversations(limit = 50): readonly ConversationRecord[] {
        this.#alive();
        const rows = this.#db.prepare(
            `SELECT id, title, created_at, updated_at, system_prompt, reasoning_effort
             FROM conversations
             ORDER BY updated_at DESC, id DESC
             LIMIT ?`,
        ).all(clamp(limit)) as unknown as ConversationRow[];
        return rows.map(toConversation);
    }

    getConversation(id: string): ConversationRecord | null {
        this.#alive();
        const row = this.#db.prepare(
            `SELECT id, title, created_at, updated_at, system_prompt, reasoning_effort
             FROM conversations WHERE id = ?`,
        ).get(id) as ConversationRow | undefined;
        return row === undefined ? null : toConversation(row);
    }

    updateConversation(
        id: string,
        patch: {
            readonly title?: string;
            readonly updatedAt: string;
            readonly systemPrompt?: string;
            readonly reasoningEffort?: string;
        },
    ): void {
        this.#alive();
        const result = this.#db.prepare(
            `UPDATE conversations
             SET title = COALESCE(?, title),
                 updated_at = ?,
                 system_prompt = CASE
                     WHEN ? IS NULL THEN system_prompt
                     WHEN ? = '' THEN NULL
                     ELSE ?
                 END,
                 reasoning_effort = CASE
                     WHEN ? IS NULL THEN reasoning_effort
                     WHEN ? = '' THEN NULL
                     ELSE ?
                 END
             WHERE id = ?`,
        ).run(
            patch.title === undefined ? null : patch.title,
            patch.updatedAt,
            patch.systemPrompt === undefined ? null : patch.systemPrompt,
            patch.systemPrompt === undefined ? null : patch.systemPrompt,
            patch.systemPrompt === undefined ? null : patch.systemPrompt,
            patch.reasoningEffort === undefined ? null : patch.reasoningEffort,
            patch.reasoningEffort === undefined ? null : patch.reasoningEffort,
            patch.reasoningEffort === undefined ? null : patch.reasoningEffort,
            id,
        ) as RunResult;
        if (Number(result.changes) === 0) {
            throw new StorageNotFoundError(`conversation not found: ${id}`);
        }
    }

    deleteConversation(id: string): void {
        this.#alive();
        this.#db.exec("BEGIN IMMEDIATE");
        try {
            this.#db.prepare(
                `DELETE FROM message_attachments WHERE message_id IN (
                    SELECT id FROM messages WHERE conversation_id = ?
                )`,
            ).run(id);
            this.#db.prepare(
                "DELETE FROM messages WHERE conversation_id = ?",
            ).run(id);
            const result = this.#db.prepare(
                "DELETE FROM conversations WHERE id = ?",
            ).run(id) as RunResult;
            if (Number(result.changes) === 0) {
                throw new StorageNotFoundError(`conversation not found: ${id}`);
            }
            this.#db.exec("COMMIT");
        } catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
    }

    addMessage(message: ChatMessageRecord): void {
        this.#alive();
        if (this.getConversation(message.conversationId) === null) {
            throw new StorageNotFoundError(
                `conversation not found: ${message.conversationId}`,
            );
        }
        this.#db.prepare(
            `INSERT INTO messages (
                id, conversation_id, role, text, created_at, call_id, tool_name,
                status, error_code, error_message
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            message.id,
            message.conversationId,
            message.role,
            message.text,
            message.createdAt,
            message.callId ?? null,
            message.name ?? null,
            message.status ?? null,
            message.error?.code ?? null,
            message.error?.message ?? null,
        );
        for (
            const [position, attachment] of (message.attachments ?? [])
                .entries()
        ) {
            this.#db.prepare(
                `INSERT INTO message_attachments (
                    message_id, position, media_type, data_base64
                 ) VALUES (?, ?, ?, ?)`,
            ).run(
                message.id,
                position,
                attachment.mediaType,
                attachment.dataBase64,
            );
        }
    }

    listMessages(conversationId: string): readonly ChatMessageRecord[] {
        this.#alive();
        const rows = this.#db.prepare(
            `SELECT id, conversation_id, role, text, created_at, call_id, tool_name,
                    status, error_code, error_message
             FROM messages
             WHERE conversation_id = ?
             ORDER BY rowid ASC`,
        ).all(conversationId) as unknown as MessageRow[];
        const attachments = this.#db.prepare(
            `SELECT a.message_id, a.position, a.media_type, a.data_base64
             FROM message_attachments a
             JOIN messages m ON m.id = a.message_id
             WHERE m.conversation_id = ?
             ORDER BY a.position ASC`,
        ).all(conversationId) as unknown as AttachmentRow[];
        const grouped = new Map<string, ChatAttachment[]>();
        for (const row of attachments) {
            const list = grouped.get(row.message_id) ?? [];
            list.push({
                mediaType: row.media_type,
                dataBase64: row.data_base64,
            });
            grouped.set(row.message_id, list);
        }
        return rows.map((row) => toMessage(row, grouped.get(row.id) ?? []));
    }

    deleteMessages(ids: readonly string[]): void {
        this.#alive();
        if (ids.length === 0) return;
        const dropAttachment = this.#db.prepare(
            "DELETE FROM message_attachments WHERE message_id = ?",
        );
        const dropMessage = this.#db.prepare(
            "DELETE FROM messages WHERE id = ?",
        );
        this.#db.exec("BEGIN");
        try {
            for (const id of ids) {
                dropAttachment.run(id);
                dropMessage.run(id);
            }
            this.#db.exec("COMMIT");
        } catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#db.close();
    }

    #alive(): void {
        if (this.#closed) throw new Error("chat store is closed");
    }
}

export function openSqliteChatStore(path: string): SqliteChatStore {
    const file = path.trim();
    if (file.length === 0) throw new TypeError("chat store path is required");
    const parent = parentDirectory(file);
    if (parent !== undefined) Deno.mkdirSync(parent, { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    ensureColumn(db, "call_id");
    ensureColumn(db, "tool_name");
    ensureColumn(db, "status");
    ensureColumn(db, "error_code");
    ensureColumn(db, "error_message");
    ensureConversationColumn(db, "system_prompt");
    ensureConversationColumn(db, "reasoning_effort");
    return new SqliteChatStore(db);
}

function toConversation(row: ConversationRow): ConversationRecord {
    return {
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.system_prompt ? { systemPrompt: row.system_prompt } : {}),
        ...(row.reasoning_effort === "low" ||
                row.reasoning_effort === "medium" ||
                row.reasoning_effort === "high"
            ? { reasoningEffort: row.reasoning_effort }
            : {}),
    };
}

interface AttachmentRow {
    message_id: string;
    position: number;
    media_type: string;
    data_base64: string;
}

function toMessage(
    row: MessageRow,
    attachments: readonly ChatAttachment[],
): ChatMessageRecord {
    const role = row.role === "system" || row.role === "assistant" ||
            row.role === "tool"
        ? row.role
        : "user";
    return {
        id: row.id,
        conversationId: row.conversation_id,
        role,
        text: row.text,
        createdAt: row.created_at,
        ...(row.call_id === null ? {} : { callId: row.call_id }),
        ...(row.tool_name === null ? {} : { name: row.tool_name }),
        ...(row.status === "completed" || row.status === "failed" ||
                row.status === "stopped"
            ? { status: row.status }
            : {}),
        ...(row.error_code === null || row.error_message === null ? {} : {
            error: { code: row.error_code, message: row.error_message },
        }),
        ...(attachments.length === 0 ? {} : { attachments }),
    };
}

function ensureColumn(db: DatabaseSync, column: string): void {
    const rows = db.prepare("PRAGMA table_info(messages)").all() as {
        name: string;
    }[];
    if (rows.some((row) => row.name === column)) return;
    db.exec(`ALTER TABLE messages ADD COLUMN ${column} TEXT`);
}

function ensureConversationColumn(db: DatabaseSync, column: string): void {
    const rows = db.prepare("PRAGMA table_info(conversations)").all() as {
        name: string;
    }[];
    if (rows.some((row) => row.name === column)) return;
    db.exec(`ALTER TABLE conversations ADD COLUMN ${column} TEXT`);
}

function clamp(limit: number): number {
    if (!Number.isInteger(limit) || limit < 1) {
        throw new TypeError("limit must be a positive integer");
    }
    return Math.min(limit, 100);
}

function parentDirectory(path: string): string | undefined {
    const normalized = path.replaceAll("\\", "/");
    const index = normalized.lastIndexOf("/");
    if (index <= 0) return undefined;
    return path.slice(0, index);
}
