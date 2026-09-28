/**
 * Runtime-neutral persistence contracts.
 *
 * This module intentionally has no imports.  Protocol and source plugins may
 * depend on these types without gaining access to Deno KV, SQLite, or a host
 * database handle.  Runtime adapters live below `adapters/` and are imported
 * only by the composition root.
 */

export type StorageKeyPart =
    | string
    | number
    | bigint
    | boolean
    | Uint8Array;
export type StorageKey = readonly StorageKeyPart[];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {
    readonly [key: string]: JsonValue;
};
export type JsonObject = Readonly<Record<string, JsonValue>>;

export interface VersionedValue<T> {
    readonly value: T;
    readonly versionstamp: string;
}

export interface StoredEntry<T> extends VersionedValue<T> {
    /** Key relative to the namespace passed to the repository. */
    readonly key: StorageKey;
}

export interface WriteOptions {
    /** Omit for an unconditional write; use null for create-only. */
    readonly expectedVersionstamp?: string | null;
    readonly expireIn?: number;
}

/**
 * Namespaced key/value access used by host services and plugin configuration.
 * Values are deliberately generic because Deno KV supports structured-clone
 * values; serialization policy belongs to the adapter that owns the store.
 */
export interface ConfigStore {
    namespace(...path: StorageKeyPart[]): ConfigStore;
    get<T = unknown>(path?: StorageKey): Promise<VersionedValue<T> | null>;
    set<T>(
        path: StorageKey,
        value: T,
        options?: WriteOptions,
    ): Promise<string>;
    delete(
        path: StorageKey,
        expectedVersionstamp?: string | null,
    ): Promise<void>;
    list<T = unknown>(path?: StorageKey): AsyncIterable<StoredEntry<T>>;
}

export type RequestStatus =
    | "pending"
    | "running"
    | "completed"
    | "error"
    | "cancelled";

/** Request DTO persisted by the host. `request` is opaque to storage. */
export interface NewRequestRecord {
    readonly requestId: string;
    readonly streamId?: string;
    readonly operation?: string;
    readonly model?: string;
    readonly protocolPluginId?: string;
    readonly upstreamPluginId?: string;
    readonly receivedAt: string;
    readonly request: JsonValue;
    readonly metadata?: JsonObject;
}

export interface RequestRecord extends NewRequestRecord {
    readonly status: RequestStatus;
    readonly completedAt?: string;
    /** When the first content frame arrived; the gap from `receivedAt` is TTFT. */
    readonly firstTokenAt?: string;
    readonly response?: JsonValue;
    readonly error?: JsonValue;
}

export interface RequestPatch {
    readonly status: RequestStatus;
    readonly completedAt?: string;
    readonly response?: JsonValue;
    readonly error?: JsonValue;
}

export interface RequestListOptions {
    readonly status?: RequestStatus;
    /** Literal substring across request id, model, operation and plugin ids. */
    readonly q?: string;
    /** Exclusive position in receivedAt DESC, requestId DESC order. */
    readonly cursor?: {
        readonly receivedAt: string;
        readonly requestId: string;
    };
    /** Legacy exclusive timestamp filter; prefer cursor when paging. */
    readonly before?: string;
    readonly limit?: number;
}

/** Persisted HIP event envelope without importing HIP implementation types. */
export interface StoredFrame {
    readonly version: number;
    readonly streamId: string;
    readonly requestId: string;
    readonly seq: number;
    readonly eventId: string;
    readonly timestamp: string;
    readonly event: JsonValue;
    readonly causationId?: string;
    readonly extensions?: JsonObject;
}

export interface UsageRecord {
    readonly requestId: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly reasoningTokens?: number;
    readonly cachedInputTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly totalTokens?: number;
    /** Decimal text keeps provider prices exact across storage engines. */
    readonly cost?: string;
    readonly currency?: string;
    readonly extensions?: JsonObject;
    readonly updatedAt: string;
}

export interface UsageTotals {
    readonly requestCount: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheWriteTokens: number;
    readonly totalTokens: number;
}

/** Requests received in one window, with the usage they reported. */
export interface RequestWindowStats {
    readonly requestCount: number;
    readonly completedCount: number;
    readonly failedCount: number;
    readonly cancelledCount: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheWriteTokens: number;
    readonly totalTokens: number;
}

export interface ModelWindowStats extends RequestWindowStats {
    /** Null collects requests that named no model. */
    readonly model: string | null;
}

/** Host-facing request history contract. */
export interface RequestStore {
    createRequest(record: NewRequestRecord): void;
    getRequest(requestId: string): RequestRecord | null;
    updateRequest(requestId: string, patch: RequestPatch): void;
    /** Record the first content frame's timestamp once, keeping the earliest. */
    markFirstToken(requestId: string, timestamp: string): void;
    listRequests(options?: RequestListOptions): readonly RequestRecord[];
    appendFrame(frame: StoredFrame): boolean;
    listFrames(
        requestId: string,
        afterSeq?: number,
        limit?: number,
    ): readonly StoredFrame[];
    /** Captures the current export boundary without loading the event bodies. */
    getFrameSummary(requestId: string): {
        readonly count: number;
        readonly lastSeq: number | null;
    };
    putUsage(usage: UsageRecord): void;
    getUsage(requestId: string): UsageRecord | null;
    usageTotals(from?: string, until?: string): UsageTotals;
    /** Aggregate requests received in `[from, until)`. */
    windowStats(from: string, until: string): RequestWindowStats;
    /** The same window grouped by model, busiest first, at most `limit` rows. */
    modelStats(
        from: string,
        until: string,
        limit: number,
    ): readonly ModelWindowStats[];
    close(): void;
}

export interface ConversationRecord {
    readonly id: string;
    readonly title: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    /** Injected before every completion of this conversation. */
    readonly systemPrompt?: string;
    /** Upstream reasoning effort preference: "low" | "medium" | "high". */
    readonly reasoningEffort?: "low" | "medium" | "high";
    /** Tool plugin ids the model must not see in this conversation. */
    readonly disabledTools?: readonly string[];
    /** Leaf of the currently selected path; other branches remain stored. */
    readonly activeMessageId?: string;
}

export type ChatAttachment = ChatAssetAttachment | ChatInlineAttachment;

/** URLs are derived at the presentation boundary and are never stored. */
export interface ChatAssetAttachment {
    readonly assetId: string;
    /** Accepted at the command boundary, stripped before storing a message. */
    readonly leaseId?: string;
    readonly mediaType: string;
    readonly dataBase64?: never;
}

/** Compatibility input for histories created before image assets were introduced. */
export interface ChatInlineAttachment {
    readonly mediaType: string;
    readonly dataBase64: string;
    readonly assetId?: never;
    readonly leaseId?: never;
}

export interface ChatMessageRecord {
    readonly id: string;
    readonly conversationId: string;
    readonly role: "system" | "user" | "assistant" | "tool";
    readonly text: string;
    readonly createdAt: string;
    /** Omitted by legacy writers to append to the selected path. */
    readonly parentId?: string | null;
    /** Write-only variant intent; adapters preserve its stable group after deletion. */
    readonly variantOf?: string;
    readonly branch?: {
        readonly index: number;
        readonly count: number;
        readonly messageIds: readonly string[];
    };
    /** Absent on legacy messages, which are treated as completed. */
    readonly status?: "completed" | "failed" | "stopped";
    readonly error?: { readonly code: string; readonly message: string };
    /** Set when this row is a tool call or a tool result. */
    readonly callId?: string;
    readonly name?: string;
    readonly attachments?: readonly ChatAttachment[];
    /** Public reasoning transcript surfaced alongside the answer. */
    readonly reasoning?: string;
    /** Cloud activity lines (e.g. searches) the model ran for this reply. */
    readonly activity?: readonly { readonly summary: string }[];
    /** Sources the answer cited. */
    readonly citations?: readonly {
        readonly label?: string;
        readonly url?: string;
        readonly ref?: string;
    }[];
    /** Per-turn account quota snapshot shown with the reply. */
    readonly quota?: {
        readonly meters: readonly {
            readonly name: string;
            readonly remaining?: number;
            readonly blocked?: boolean;
            readonly error?: string;
        }[];
    };
}

/** Single-tenant chat history. The kernel does not depend on this port. */
export interface ChatStore {
    createConversation(title: string, now: string): ConversationRecord;
    listConversations(limit?: number): readonly ConversationRecord[];
    getConversation(id: string): ConversationRecord | null;
    updateConversation(
        id: string,
        patch: {
            readonly title?: string;
            readonly updatedAt: string;
            /** Empty string clears the stored prompt; undefined keeps it. */
            readonly systemPrompt?: string;
            /** Empty string clears; undefined keeps; otherwise low/medium/high. */
            readonly reasoningEffort?: string;
            /** Undefined keeps the list; otherwise it replaces it wholesale. */
            readonly disabledTools?: readonly string[];
        },
    ): void;
    /** Atomically delete the conversation, its messages and attachments. */
    deleteConversation(id: string): void;
    addMessage(message: ChatMessageRecord): void;
    /** Atomically append a chain and select its leaf. Explicit null starts a root. */
    appendMessages(
        messages: readonly ChatMessageRecord[],
        patch?: { readonly title?: string; readonly updatedAt: string },
    ): void;
    /** The selected path, annotated with sibling variants. */
    listMessages(conversationId: string): readonly ChatMessageRecord[];
    listAllMessages(conversationId: string): readonly ChatMessageRecord[];
    /** Ancestors through the target, without changing the selected path. */
    messagePath(
        conversationId: string,
        messageId: string,
    ): readonly ChatMessageRecord[];
    /** Restore the selected descendants of this node, preserving other choices. */
    selectBranch(conversationId: string, messageId: string, now: string): void;
    /** Copy only the ancestry through the target, with new ids and settings. */
    forkConversation(
        conversationId: string,
        messageId: string,
        now: string,
        title?: string,
    ): ConversationRecord;
    replaceMessageAttachments(
        messageId: string,
        attachments: readonly ChatAttachment[],
    ): void;
    assetIdsForMessages(ids: readonly string[]): readonly string[];
    assetIdsForConversation(id: string): readonly string[];
    referencedAssetIds(ids: readonly string[]): readonly string[];
    quarantineLegacyAttachments(
        messageId: string,
        indices: readonly number[],
        reason: string,
    ): void;
    /** Delete these message ids and their attachments. Missing ids are ignored. */
    deleteMessages(ids: readonly string[], updatedAt?: string): void;
    close(): void;
}

/**
 * Storage capability supplied to the server. Each capability is optional so
 * tests and read-only deployments can provide only the backend they need.
 */
export interface StoragePort {
    readonly config?: ConfigStore;
    readonly requests?: RequestStore;
    readonly chat?: ChatStore;
    close(): void | PromiseLike<void>;
}

export class StorageConflictError extends Error {
    override readonly name = "StorageConflictError";
}

export class StorageNotFoundError extends Error {
    override readonly name = "StorageNotFoundError";
}
