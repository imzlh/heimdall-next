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
    listRequests(options?: RequestListOptions): readonly RequestRecord[];
    appendFrame(frame: StoredFrame): boolean;
    listFrames(
        requestId: string,
        afterSeq?: number,
        limit?: number,
    ): readonly StoredFrame[];
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
}

export interface ChatAttachment {
    readonly mediaType: string;
    readonly dataBase64: string;
}

export interface ChatMessageRecord {
    readonly id: string;
    readonly conversationId: string;
    readonly role: "system" | "user" | "assistant" | "tool";
    readonly text: string;
    readonly createdAt: string;
    /** Absent on legacy messages, which are treated as completed. */
    readonly status?: "completed" | "failed" | "stopped";
    readonly error?: { readonly code: string; readonly message: string };
    /** Set when this row is a tool call or a tool result. */
    readonly callId?: string;
    readonly name?: string;
    readonly attachments?: readonly ChatAttachment[];
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
        },
    ): void;
    /** Atomically delete the conversation, its messages and attachments. */
    deleteConversation(id: string): void;
    addMessage(message: ChatMessageRecord): void;
    listMessages(conversationId: string): readonly ChatMessageRecord[];
    /** Delete these message ids and their attachments. Missing ids are ignored. */
    deleteMessages(ids: readonly string[]): void;
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
