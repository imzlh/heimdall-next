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
 id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 system_prompt TEXT, reasoning_effort TEXT, active_message_id TEXT, disabled_tools TEXT
);
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
 created_at TEXT NOT NULL, call_id TEXT, tool_name TEXT, status TEXT, error_code TEXT, error_message TEXT,
 parent_id TEXT, selected_child_id TEXT, branch_group_id TEXT, reasoning TEXT, activity TEXT, citations TEXT,
 FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
CREATE TABLE IF NOT EXISTS message_attachments (
 message_id TEXT NOT NULL, position INTEGER NOT NULL, media_type TEXT NOT NULL, data_base64 TEXT NOT NULL,
 asset_id TEXT, PRIMARY KEY (message_id,position), FOREIGN KEY (message_id) REFERENCES messages(id)
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at,id);
CREATE INDEX IF NOT EXISTS conversations_activity ON conversations(updated_at,id);
CREATE TABLE IF NOT EXISTS legacy_attachment_quarantine (
 message_id TEXT NOT NULL, position INTEGER NOT NULL, media_type TEXT NOT NULL,
 data_base64 TEXT NOT NULL, reason TEXT NOT NULL, quarantined_at TEXT NOT NULL,
 PRIMARY KEY(message_id,position)
);
`;

interface ConversationRow {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
    system_prompt: string | null;
    reasoning_effort: string | null;
    active_message_id: string | null;
    disabled_tools: string | null;
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
    parent_id: string | null;
    selected_child_id: string | null;
    branch_group_id: string | null;
    reasoning: string | null;
    activity: string | null;
    citations: string | null;
}
interface AttachmentRow {
    message_id: string;
    media_type: string;
    data_base64: string;
    asset_id: string | null;
}

/** Durable message tree. Selecting a path never deletes another branch. */
export class SqliteChatStore implements ChatStore {
    readonly #db: DatabaseSync;
    #closed = false;
    constructor(db: DatabaseSync) {
        this.#db = db;
    }
    createConversation(title: string, now: string): ConversationRecord {
        this.#alive();
        const record = {
            id: crypto.randomUUID(),
            title: title.trim() || "新对话",
            createdAt: now,
            updatedAt: now,
        };
        this.#db.prepare(
            "INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)",
        ).run(record.id, record.title, now, now);
        return record;
    }
    listConversations(limit = 50): readonly ConversationRecord[] {
        this.#alive();
        if (!Number.isInteger(limit) || limit < 1) {
            throw new TypeError("limit must be a positive integer");
        }
        return (this.#db.prepare(
            "SELECT * FROM conversations ORDER BY updated_at DESC,id DESC LIMIT ?",
        ).all(Math.min(limit, 100)) as unknown as ConversationRow[]).map(
            toConversation,
        );
    }
    getConversation(id: string): ConversationRecord | null {
        this.#alive();
        const row = this.#db.prepare("SELECT * FROM conversations WHERE id=?")
            .get(id) as ConversationRow | undefined;
        return row ? toConversation(row) : null;
    }
    /** Bounded, oldest-first keyset scan for host retention, including every branch. */
    listConversationsOlderThan(
        before: string,
        limit: number,
        after?: { readonly updatedAt: string; readonly id: string },
    ): readonly ConversationRecord[] {
        this.#alive();
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
            throw new TypeError(
                "retention limit must be an integer from 1 to 500",
            );
        }
        const query = after
            ? "SELECT * FROM conversations WHERE updated_at < ? AND (updated_at > ? OR (updated_at = ? AND id > ?)) ORDER BY updated_at,id LIMIT ?"
            : "SELECT * FROM conversations WHERE updated_at < ? ORDER BY updated_at,id LIMIT ?";
        const rows = after
            ? this.#db.prepare(query).all(
                before,
                after.updatedAt,
                after.updatedAt,
                after.id,
                limit,
            )
            : this.#db.prepare(query).all(before, limit);
        return (rows as unknown as ConversationRow[]).map(toConversation);
    }
    updateConversation(
        id: string,
        patch: Parameters<ChatStore["updateConversation"]>[1],
    ): void {
        this.#alive();
        const result = this.#db.prepare(
            `UPDATE conversations SET title=COALESCE(?,title),updated_at=?,
   system_prompt=CASE WHEN ? IS NULL THEN system_prompt ELSE NULLIF(?,'') END,
   reasoning_effort=CASE WHEN ? IS NULL THEN reasoning_effort ELSE NULLIF(?,'') END,
   disabled_tools=CASE WHEN ? IS NULL THEN disabled_tools ELSE ? END WHERE id=?`,
        )
            .run(
                patch.title ?? null,
                patch.updatedAt,
                patch.systemPrompt ?? null,
                patch.systemPrompt ?? null,
                patch.reasoningEffort ?? null,
                patch.reasoningEffort ?? null,
                patch.disabledTools === undefined
                    ? null
                    : JSON.stringify(patch.disabledTools),
                patch.disabledTools === undefined
                    ? null
                    : JSON.stringify(patch.disabledTools),
                id,
            );
        if (Number(result.changes) === 0) throw missingConversation(id);
    }
    deleteConversation(id: string): void {
        this.#transaction(() => {
            this.#db.prepare(
                "DELETE FROM legacy_attachment_quarantine WHERE message_id IN(SELECT id FROM messages WHERE conversation_id=?)",
            ).run(id);
            this.#db.prepare(
                "DELETE FROM message_attachments WHERE message_id IN(SELECT id FROM messages WHERE conversation_id=?)",
            ).run(id);
            this.#db.prepare("DELETE FROM messages WHERE conversation_id=?")
                .run(id);
            const result = this.#db.prepare(
                "DELETE FROM conversations WHERE id=?",
            ).run(id);
            if (Number(result.changes) === 0) throw missingConversation(id);
        });
    }
    addMessage(message: ChatMessageRecord): void {
        this.appendMessages([message]);
    }
    appendMessages(
        messages: readonly ChatMessageRecord[],
        patch?: { readonly title?: string; readonly updatedAt: string },
    ): void {
        if (!messages.length) return;
        this.#transaction(() => {
            const conversationId = messages[0]!.conversationId;
            if (messages.some((row) => row.conversationId !== conversationId)) {
                throw new TypeError("messages must belong to one conversation");
            }
            for (const row of messages) this.#insert(row);
            if (patch) this.updateConversation(conversationId, patch);
        });
    }
    #insert(message: ChatMessageRecord): void {
        const conversation = this.getConversation(message.conversationId);
        if (!conversation) throw missingConversation(message.conversationId);
        const parentId = message.parentId === undefined
            ? conversation.activeMessageId ?? null
            : message.parentId;
        if (parentId !== null) {
            this.#messageRow(message.conversationId, parentId);
        }
        const variant = message.variantOf
            ? this.#messageRow(message.conversationId, message.variantOf)
            : this.#db.prepare(
                "SELECT * FROM messages WHERE conversation_id=? AND parent_id IS ? AND role=? ORDER BY rowid LIMIT 1",
            ).get(message.conversationId, parentId, message.role) as
                | MessageRow
                | undefined;
        if (variant && variant.role !== message.role) {
            throw new TypeError("variant role must match its original message");
        }
        if (variant && variant.parent_id !== parentId) {
            throw new TypeError("variant must use its original message prefix");
        }
        const branchGroupId = variant?.branch_group_id ?? variant?.id ??
            message.id;
        this.#db.prepare(
            `INSERT INTO messages(id,conversation_id,role,text,created_at,call_id,tool_name,status,error_code,error_message,parent_id,branch_group_id,reasoning,activity,citations)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
            parentId,
            branchGroupId,
            message.reasoning ?? null,
            message.activity?.length ? JSON.stringify(message.activity) : null,
            message.citations?.length
                ? JSON.stringify(message.citations)
                : null,
        );
        this.#writeAttachments(message.id, message.attachments ?? []);
        this.#selectLeaf(message.conversationId, message.id);
    }
    listAllMessages(conversationId: string): readonly ChatMessageRecord[] {
        this.#alive();
        const rows = this.#rows(conversationId);
        const attachments = this.#db.prepare(
            `SELECT a.* FROM message_attachments a JOIN messages m ON m.id=a.message_id WHERE m.conversation_id=? ORDER BY a.position ASC`,
        ).all(conversationId) as unknown as AttachmentRow[];
        const grouped = new Map<string, ChatAttachment[]>();
        for (const row of attachments) {
            const list = grouped.get(row.message_id) ?? [];
            list.push(toAttachment(row));
            grouped.set(row.message_id, list);
        }
        const siblings = new Map<string, string[]>();
        const key = (row: MessageRow) => row.branch_group_id ?? row.id;
        for (const row of rows) {
            const list = siblings.get(key(row)) ?? [];
            list.push(row.id);
            siblings.set(key(row), list);
        }
        const byId = new Map(rows.map((row) => [row.id, row]));
        const representative = (entry: MessageRow): MessageRow | undefined => {
            let cursor: MessageRow | undefined = entry;
            while (cursor?.call_id || cursor?.role === "tool") {
                cursor = cursor.selected_child_id
                    ? byId.get(cursor.selected_child_id)
                    : undefined;
            }
            return cursor;
        };
        const branches = new Map<
            string,
            NonNullable<ChatMessageRecord["branch"]>
        >();
        for (const ids of siblings.values()) {
            if (ids.length < 2) continue;
            const visible = ids.map((id) => representative(byId.get(id)!))
                .filter((row): row is MessageRow => row !== undefined).map(
                    (row) => row.id,
                );
            if (visible.length < 2) continue;
            visible.forEach((id, index) =>
                branches.set(id, {
                    index,
                    count: visible.length,
                    messageIds: visible,
                })
            );
        }
        return rows.map((row) => {
            const branch = branches.get(row.id);
            return {
                ...toMessage(row, grouped.get(row.id) ?? []),
                ...(branch ? { branch } : {}),
            };
        });
    }
    listMessages(conversationId: string): readonly ChatMessageRecord[] {
        const conversation = this.getConversation(conversationId);
        return conversation?.activeMessageId
            ? this.messagePath(conversationId, conversation.activeMessageId)
            : [];
    }
    messagePath(
        conversationId: string,
        messageId: string,
    ): readonly ChatMessageRecord[] {
        const map = new Map(
            this.listAllMessages(conversationId).map((row) => [row.id, row]),
        );
        if (!map.has(messageId)) throw missingMessage(messageId);
        const path: ChatMessageRecord[] = [];
        const seen = new Set<string>();
        let cursor: string | null = messageId;
        while (cursor !== null) {
            if (seen.has(cursor)) throw new Error("chat tree contains a cycle");
            seen.add(cursor);
            const row = map.get(cursor);
            if (!row) throw new Error("chat tree contains a missing parent");
            path.push(row);
            cursor = row.parentId ?? null;
        }
        return path.reverse();
    }
    selectBranch(conversationId: string, messageId: string, now: string): void {
        this.#transaction(() => {
            const map = new Map(
                this.#rows(conversationId).map((row) => [row.id, row]),
            );
            let row = map.get(messageId);
            if (!row) throw missingMessage(messageId);
            const seen = new Set<string>();
            while (row.selected_child_id) {
                if (seen.has(row.id)) {
                    throw new Error("chat tree contains a cycle");
                }
                seen.add(row.id);
                const child = map.get(row.selected_child_id);
                if (!child || child.parent_id !== row.id) {
                    throw new Error("chat branch selection is invalid");
                }
                row = child;
            }
            this.#selectLeaf(conversationId, row.id);
            this.updateConversation(conversationId, { updatedAt: now });
        });
    }
    forkConversation(
        conversationId: string,
        messageId: string,
        now: string,
        title?: string,
    ): ConversationRecord {
        return this.#transaction(() => {
            const source = this.getConversation(conversationId);
            if (!source) throw missingConversation(conversationId);
            const path = this.messagePath(conversationId, messageId);
            const fork = this.createConversation(
                title ?? `${source.title.slice(0, 115)} · 分支`,
                now,
            );
            this.updateConversation(fork.id, {
                updatedAt: now,
                systemPrompt: source.systemPrompt,
                reasoningEffort: source.reasoningEffort,
                ...(source.disabledTools
                    ? { disabledTools: source.disabledTools }
                    : {}),
            });
            let parentId: string | null = null;
            for (const row of path) {
                const copied: ChatMessageRecord = {
                    ...row,
                    id: crypto.randomUUID(),
                    conversationId: fork.id,
                    parentId,
                };
                this.#insert(copied);
                parentId = copied.id;
            }
            return this.getConversation(fork.id)!;
        });
    }
    replaceMessageAttachments(
        messageId: string,
        attachments: readonly ChatAttachment[],
    ): void {
        this.#transaction(() => {
            if (
                !this.#db.prepare("SELECT id FROM messages WHERE id=?").get(
                    messageId,
                )
            ) throw missingMessage(messageId);
            this.#db.prepare(
                "DELETE FROM message_attachments WHERE message_id=?",
            ).run(messageId);
            this.#writeAttachments(messageId, attachments);
        });
    }
    listLegacyAttachments(
        limit = 100,
    ): readonly {
        messageId: string;
        attachments: readonly ChatAttachment[];
    }[] {
        this.#alive();
        const rows = this.#db.prepare(
            "SELECT DISTINCT message_id FROM message_attachments WHERE asset_id IS NULL LIMIT ?",
        ).all(Math.max(1, Math.min(100, limit))) as { message_id: string }[];
        return rows.map((row) => ({
            messageId: row.message_id,
            attachments: (this.#db.prepare(
                "SELECT * FROM message_attachments WHERE message_id=? ORDER BY position",
            ).all(row.message_id) as unknown as AttachmentRow[]).map(
                toAttachment,
            ),
        }));
    }
    assetIdsForMessages(ids: readonly string[]): readonly string[] {
        this.#alive();
        const found = new Set<string>();
        const query = this.#db.prepare(
            "SELECT DISTINCT asset_id FROM message_attachments WHERE message_id=? AND asset_id IS NOT NULL",
        );
        for (const id of ids) {
            for (const row of query.all(id)) {
                found.add(row.asset_id as string);
            }
        }
        return [...found];
    }
    assetIdsForConversation(id: string): readonly string[] {
        this.#alive();
        return (this.#db.prepare(
            "SELECT DISTINCT a.asset_id FROM message_attachments a JOIN messages m ON m.id=a.message_id WHERE m.conversation_id=? AND a.asset_id IS NOT NULL",
        ).all(id) as { asset_id: string }[]).map((row) => row.asset_id);
    }
    referencedAssetIds(ids: readonly string[]): readonly string[] {
        this.#alive();
        const query = this.#db.prepare(
            "SELECT 1 FROM message_attachments WHERE asset_id=? LIMIT 1",
        );
        return [...new Set(ids)].filter((id) => query.get(id) !== undefined);
    }
    quarantineLegacyAttachments(
        messageId: string,
        indices: readonly number[],
        reason: string,
    ): void {
        this.#transaction(() => {
            const rows = this.#db.prepare(
                "SELECT position,media_type,data_base64,asset_id FROM message_attachments WHERE message_id=? ORDER BY position",
            ).all(messageId) as {
                position: number;
                media_type: string;
                data_base64: string;
                asset_id: string | null;
            }[];
            const archive = this.#db.prepare(
                "INSERT OR REPLACE INTO legacy_attachment_quarantine(message_id,position,media_type,data_base64,reason,quarantined_at) VALUES(?,?,?,?,?,?)",
            );
            const remove = this.#db.prepare(
                "DELETE FROM message_attachments WHERE message_id=? AND position=?",
            );
            for (const index of new Set(indices)) {
                if (
                    !Number.isInteger(index) || index < 0 ||
                    index >= rows.length
                ) throw new TypeError("attachment index is invalid");
                const row = rows[index]!;
                if (row.asset_id !== null) {
                    throw new TypeError(
                        "only legacy attachments may be quarantined",
                    );
                }
                archive.run(
                    messageId,
                    row.position,
                    row.media_type,
                    row.data_base64,
                    reason,
                    new Date().toISOString(),
                );
                remove.run(messageId, row.position);
            }
        });
    }
    #writeAttachments(
        messageId: string,
        attachments: readonly ChatAttachment[],
    ): void {
        const insert = this.#db.prepare(
            "INSERT INTO message_attachments(message_id,position,media_type,data_base64,asset_id) VALUES(?,?,?,?,?)",
        );
        for (const [index, attachment] of attachments.entries()) {
            insert.run(
                messageId,
                index,
                attachment.mediaType,
                attachment.dataBase64 ?? "",
                attachment.assetId ?? null,
            );
        }
    }
    /** Splice removed nodes out of every path; all surviving descendants remain. */
    deleteMessages(ids: readonly string[], updatedAt?: string): void {
        if (!ids.length) return;
        this.#transaction(() => {
            const removed = new Set(ids);
            const conversations = new Set<string>();
            for (const id of removed) {
                const row = this.#db.prepare(
                    "SELECT conversation_id FROM messages WHERE id=?",
                ).get(id) as { conversation_id: string } | undefined;
                if (row) conversations.add(row.conversation_id);
            }
            for (const conversationId of conversations) {
                const rows = this.#rows(conversationId);
                const map = new Map(rows.map((row) => [row.id, row]));
                let leaf =
                    this.getConversation(conversationId)!.activeMessageId ??
                        null;
                while (leaf !== null && removed.has(leaf)) {
                    leaf = map.get(leaf)?.parent_id ?? null;
                }
                const update = this.#db.prepare(
                    "UPDATE messages SET parent_id=?,selected_child_id=? WHERE id=?",
                );
                for (const row of rows) {
                    if (removed.has(row.id)) continue;
                    let parent = row.parent_id;
                    let child = row.selected_child_id;
                    while (parent !== null && removed.has(parent)) {
                        parent = map.get(parent)?.parent_id ?? null;
                    }
                    while (child !== null && removed.has(child)) {
                        child = map.get(child)?.selected_child_id ?? null;
                    }
                    update.run(parent, child, row.id);
                }
                for (const row of rows) {
                    if (!removed.has(row.id)) continue;
                    this.#db.prepare(
                        "DELETE FROM legacy_attachment_quarantine WHERE message_id=?",
                    ).run(row.id);
                    this.#db.prepare(
                        "DELETE FROM message_attachments WHERE message_id=?",
                    ).run(row.id);
                    this.#db.prepare("DELETE FROM messages WHERE id=?").run(
                        row.id,
                    );
                }
                // Removing the selected variant must not strand surviving
                // siblings behind an empty active path. Restore a remaining
                // choice and its remembered descendants.
                const survivors = this.#rows(conversationId);
                let selected = survivors.find((row) => row.id === leaf) ??
                    survivors.findLast((row) => row.parent_id === null);
                while (selected) {
                    const children = survivors.filter((row) =>
                        row.parent_id === selected!.id
                    );
                    const next = children.find((row) =>
                        row.id === selected!.selected_child_id
                    ) ?? children.at(-1);
                    if (!next) {
                        break;
                    }
                    selected = next;
                }
                this.#selectLeaf(conversationId, selected?.id ?? null);
                if (updatedAt !== undefined) {
                    this.updateConversation(conversationId, { updatedAt });
                }
            }
        });
    }
    #rows(conversationId: string): MessageRow[] {
        return this.#db.prepare(
            "SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid ASC",
        ).all(conversationId) as unknown as MessageRow[];
    }
    #messageRow(conversationId: string, messageId: string): MessageRow {
        const row = this.#db.prepare(
            "SELECT * FROM messages WHERE id=? AND conversation_id=?",
        ).get(messageId, conversationId) as MessageRow | undefined;
        if (!row) throw missingMessage(messageId);
        return row;
    }
    #selectLeaf(conversationId: string, leaf: string | null): void {
        let cursor = leaf;
        while (cursor !== null) {
            const row = this.#messageRow(conversationId, cursor);
            if (row.parent_id !== null) {
                this.#db.prepare(
                    "UPDATE messages SET selected_child_id=? WHERE id=? AND conversation_id=?",
                ).run(cursor, row.parent_id, conversationId);
            }
            cursor = row.parent_id;
        }
        this.#db.prepare(
            "UPDATE conversations SET active_message_id=? WHERE id=?",
        ).run(leaf, conversationId);
    }
    #transaction<T>(run: () => T): T {
        this.#alive();
        this.#db.exec("BEGIN IMMEDIATE");
        try {
            const result = run();
            this.#db.exec("COMMIT");
            return result;
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
    if (!file.length) throw new TypeError("chat store path is required");
    const normalized = file.replaceAll("\\", "/");
    const slash = normalized.lastIndexOf("/");
    if (slash > 0) Deno.mkdirSync(file.slice(0, slash), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(SCHEMA);
    db.exec("BEGIN IMMEDIATE");
    try {
        const migrated = !columns(db, "messages").has("parent_id");
        const groupMigration = !columns(db, "messages").has("branch_group_id");
        for (
            const column of [
                "call_id",
                "tool_name",
                "status",
                "error_code",
                "error_message",
                "parent_id",
                "selected_child_id",
                "branch_group_id",
                "reasoning",
                "activity",
                "citations",
            ]
        ) ensureColumn(db, "messages", column);
        for (
            const column of [
                "system_prompt",
                "reasoning_effort",
                "active_message_id",
                "disabled_tools",
            ]
        ) ensureColumn(db, "conversations", column);
        ensureColumn(db, "message_attachments", "asset_id");
        if (migrated) {
            const rows = db.prepare(
                "SELECT id,conversation_id FROM messages ORDER BY rowid ASC",
            ).all() as { id: string; conversation_id: string }[];
            const previous = new Map<string, string>();
            for (const row of rows) {
                const parent = previous.get(row.conversation_id) ?? null;
                db.prepare("UPDATE messages SET parent_id=? WHERE id=?").run(
                    parent,
                    row.id,
                );
                if (parent) {
                    db.prepare(
                        "UPDATE messages SET selected_child_id=? WHERE id=?",
                    ).run(row.id, parent);
                }
                previous.set(row.conversation_id, row.id);
            }
            for (const [id, leaf] of previous) {
                db.prepare(
                    "UPDATE conversations SET active_message_id=? WHERE id=?",
                ).run(leaf, id);
            }
        }
        if (groupMigration) {
            const groups = new Map<string, string>();
            const rows = db.prepare(
                "SELECT id,conversation_id,parent_id,role FROM messages ORDER BY rowid",
            ).all() as {
                id: string;
                conversation_id: string;
                parent_id: string | null;
                role: string;
            }[];
            for (const row of rows) {
                const key = JSON.stringify([
                    row.conversation_id,
                    row.parent_id,
                    row.role,
                ]);
                const group = groups.get(key) ?? row.id;
                groups.set(key, group);
                db.prepare("UPDATE messages SET branch_group_id=? WHERE id=?")
                    .run(group, row.id);
            }
        }
        db.exec(
            "CREATE INDEX IF NOT EXISTS message_attachment_asset ON message_attachments(asset_id)",
        );
        db.exec(
            "CREATE INDEX IF NOT EXISTS messages_parent ON messages(conversation_id,parent_id)",
        );
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        db.close();
        throw error;
    }
    return new SqliteChatStore(db);
}
function columns(db: DatabaseSync, table: string): Set<string> {
    return new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
            .map((row) => row.name),
    );
}
function ensureColumn(db: DatabaseSync, table: string, column: string): void {
    if (!columns(db, table).has(column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
}
function missingConversation(id: string): StorageNotFoundError {
    return new StorageNotFoundError(`conversation not found: ${id}`);
}
function missingMessage(id: string): StorageNotFoundError {
    return new StorageNotFoundError(`message not found: ${id}`);
}
function toConversation(row: ConversationRow): ConversationRecord {
    let disabledTools: readonly string[] | undefined;
    if (row.disabled_tools) {
        try {
            const parsed: unknown = JSON.parse(row.disabled_tools);
            if (
                Array.isArray(parsed) &&
                parsed.every((item) => typeof item === "string")
            ) {
                disabledTools = parsed;
            }
        } catch { /* Legacy or corrupt rows simply have no disabled tools. */ }
    }
    return {
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.active_message_id
            ? { activeMessageId: row.active_message_id }
            : {}),
        ...(row.system_prompt ? { systemPrompt: row.system_prompt } : {}),
        ...(row.reasoning_effort === "low" ||
                row.reasoning_effort === "medium" ||
                row.reasoning_effort === "high"
            ? { reasoningEffort: row.reasoning_effort }
            : {}),
        ...(disabledTools?.length ? { disabledTools } : {}),
    };
}
function toAttachment(row: AttachmentRow): ChatAttachment {
    return row.asset_id
        ? { assetId: row.asset_id, mediaType: row.media_type }
        : { mediaType: row.media_type, dataBase64: row.data_base64 };
}
function toMessage(
    row: MessageRow,
    attachments: readonly ChatAttachment[],
): ChatMessageRecord {
    const role =
        row.role === "system" || row.role === "assistant" || row.role === "tool"
            ? row.role
            : "user";
    const activity = parseActivity(row.activity);
    const citations = parseCitations(row.citations);
    return {
        id: row.id,
        conversationId: row.conversation_id,
        parentId: row.parent_id,
        role,
        text: row.text,
        createdAt: row.created_at,
        ...(row.call_id === null ? {} : { callId: row.call_id }),
        ...(row.tool_name === null ? {} : { name: row.tool_name }),
        ...(row.status === "completed" || row.status === "failed" ||
                row.status === "stopped"
            ? { status: row.status }
            : {}),
        ...(row.error_code === null || row.error_message === null
            ? {}
            : { error: { code: row.error_code, message: row.error_message } }),
        ...(attachments.length ? { attachments } : {}),
        ...(row.reasoning ? { reasoning: row.reasoning } : {}),
        ...(activity ? { activity } : {}),
        ...(citations ? { citations } : {}),
    };
}

/** Parse the persisted activity JSON, tolerating legacy nulls and bad rows. */
function parseActivity(
    value: string | null,
): { summary: string }[] | undefined {
    if (!value) return undefined;
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) return undefined;
        const items = parsed
            .filter((item): item is { summary: string } =>
                typeof item === "object" && item !== null &&
                typeof (item as { summary?: unknown }).summary === "string"
            )
            .map((item) => ({ summary: item.summary }));
        return items.length > 0 ? items : undefined;
    } catch {
        return undefined;
    }
}

/** Parse the persisted citations JSON, tolerating legacy nulls and bad rows. */
function parseCitations(
    value: string | null,
): { label?: string; url?: string; ref?: string }[] | undefined {
    if (!value) return undefined;
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) return undefined;
        const items = parsed
            .filter((item): item is Record<string, unknown> =>
                typeof item === "object" && item !== null
            )
            .map((item) => ({
                ...(typeof item.label === "string"
                    ? { label: item.label }
                    : {}),
                ...(typeof item.url === "string" ? { url: item.url } : {}),
                ...(typeof item.ref === "string" ? { ref: item.ref } : {}),
            }))
            .filter((item) =>
                item.label !== undefined || item.url !== undefined
            );
        return items.length > 0 ? items : undefined;
    } catch {
        return undefined;
    }
}
