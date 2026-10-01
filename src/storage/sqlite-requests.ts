import type {
    ModelWindowStats,
    NewRequestRecord,
    RequestListOptions,
    RequestPatch,
    RequestRecord,
    RequestStatus,
    RequestStore,
    RequestWindowStats,
    StoredFrame,
    UsageRecord,
    UsageTotals,
} from "@heimdall/storage";
import { StorageConflictError, StorageNotFoundError } from "@heimdall/storage";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { queryModelStats, queryWindowStats } from "./sqlite-request-stats.ts";

const REQUEST_STATUSES = new Set<RequestStatus>([
    "pending",
    "running",
    "completed",
    "error",
    "cancelled",
]);

const INITIAL_STATUS: RequestStatus = "running";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY,
  stream_id TEXT,
  operation TEXT,
  model TEXT,
  protocol_plugin_id TEXT,
  upstream_plugin_id TEXT,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL,
  completed_at TEXT,
  first_token_at TEXT,
  request_json TEXT NOT NULL,
  response_json TEXT,
  error_json TEXT,
  metadata_json TEXT
);
CREATE TABLE IF NOT EXISTS frames (
  request_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  version INTEGER NOT NULL,
  stream_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  event_json TEXT NOT NULL,
  causation_id TEXT,
  extensions_json TEXT,
  PRIMARY KEY (request_id, seq),
  UNIQUE (request_id, event_id),
  FOREIGN KEY (request_id) REFERENCES requests(request_id)
);
CREATE TABLE IF NOT EXISTS usage_records (
  request_id TEXT PRIMARY KEY,
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  cached_input_tokens INTEGER,
  cache_write_tokens INTEGER,
  total_tokens INTEGER,
  cost TEXT,
  currency TEXT,
  extensions_json TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES requests(request_id)
);
CREATE INDEX IF NOT EXISTS requests_received
  ON requests(received_at DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS requests_status_received
  ON requests(status, received_at DESC);
CREATE INDEX IF NOT EXISTS requests_status_cursor
  ON requests(status, received_at DESC, request_id DESC);
`;

interface RequestRow {
    request_id: string;
    stream_id: string | null;
    operation: string | null;
    model: string | null;
    protocol_plugin_id: string | null;
    upstream_plugin_id: string | null;
    received_at: string;
    status: string;
    completed_at: string | null;
    first_token_at: string | null;
    request_json: string;
    response_json: string | null;
    error_json: string | null;
    metadata_json: string | null;
}

interface FrameRow {
    request_id: string;
    seq: number;
    version: number;
    stream_id: string;
    event_id: string;
    timestamp: string;
    event_json: string;
    causation_id: string | null;
    extensions_json: string | null;
}

interface UsageRow {
    request_id: string;
    input_tokens: number | null;
    output_tokens: number | null;
    reasoning_tokens: number | null;
    cached_input_tokens: number | null;
    cache_write_tokens: number | null;
    total_tokens: number | null;
    cost: string | null;
    currency: string | null;
    extensions_json: string | null;
    updated_at: string;
}

interface TotalRow {
    request_count: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    reasoning_tokens: number | null;
    cached_input_tokens: number | null;
    cache_write_tokens: number | null;
    total_tokens: number | null;
}

interface RunResult {
    changes: number | bigint;
}

/**
 * Synchronous SQLite adapter for the request journal.
 *
 * The kernel never sees this type. Composition maps HIP lifecycle events onto
 * the storage port, and this class only persists the port's JSON records.
 */
export class SqliteRequestStore implements RequestStore {
    readonly #db: DatabaseSync;
    readonly #resources: DisposableStack;
    /** Records finalized by this open's explicitly requested startup recovery. */
    readonly recoveredRequests: number;
    #closed = false;

    constructor(
        db: DatabaseSync,
        resources?: DisposableStack,
        recoveredRequests = 0,
    ) {
        this.#db = db;
        this.#resources = resources ?? new DisposableStack();
        if (resources === undefined) this.#resources.defer(() => db.close());
        this.recoveredRequests = recoveredRequests;
    }

    createRequest(record: NewRequestRecord): void {
        this.#alive();
        requireId(record.requestId, "request id");
        requireText(record.receivedAt, "receivedAt");
        try {
            this.#db.prepare(
                `INSERT INTO requests (
                    request_id, stream_id, operation, model,
                    protocol_plugin_id, upstream_plugin_id, received_at,
                    status, request_json, metadata_json
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
                record.requestId,
                optionalText(record.streamId),
                optionalText(record.operation),
                optionalText(record.model),
                optionalText(record.protocolPluginId),
                optionalText(record.upstreamPluginId),
                record.receivedAt,
                INITIAL_STATUS,
                encodeJson(record.request),
                record.metadata === undefined
                    ? null
                    : encodeJson(record.metadata),
            );
        } catch (error) {
            if (isConstraint(error, "UNIQUE")) {
                throw new StorageConflictError(
                    `request already exists: ${record.requestId}`,
                );
            }
            throw error;
        }
    }

    getRequest(requestId: string): RequestRecord | null {
        this.#alive();
        const row = this.#db.prepare(
            `SELECT request_id, stream_id, operation, model,
                    protocol_plugin_id, upstream_plugin_id, received_at,
                    status, completed_at, first_token_at, request_json,
                    response_json, error_json, metadata_json
             FROM requests WHERE request_id = ?`,
        ).get(requestId) as RequestRow | undefined;
        return row === undefined ? null : toRequest(row);
    }

    updateRequest(requestId: string, patch: RequestPatch): void {
        this.#alive();
        requireId(requestId, "request id");
        if (!REQUEST_STATUSES.has(patch.status)) {
            throw new TypeError(`unknown request status: ${patch.status}`);
        }
        const result = this.#db.prepare(
            `UPDATE requests SET
                status = ?,
                completed_at = COALESCE(?, completed_at),
                response_json = COALESCE(?, response_json),
                error_json = COALESCE(?, error_json)
             WHERE request_id = ?`,
        ).run(
            patch.status,
            optionalText(patch.completedAt),
            patch.response === undefined ? null : encodeJson(patch.response),
            patch.error === undefined ? null : encodeJson(patch.error),
            requestId,
        ) as RunResult;
        if (Number(result.changes) === 0) {
            throw new StorageNotFoundError(`request not found: ${requestId}`);
        }
    }

    /** Stamp the moment the first content frame arrived; keeps the earliest. */
    markFirstToken(requestId: string, timestamp: string): void {
        this.#alive();
        requireId(requestId, "request id");
        requireText(timestamp, "firstTokenAt");
        this.#db.prepare(
            `UPDATE requests SET first_token_at = ?
             WHERE request_id = ? AND first_token_at IS NULL`,
        ).run(timestamp, requestId);
    }

    listRequests(options: RequestListOptions = {}): readonly RequestRecord[] {
        this.#alive();
        const status = options.status;
        if (status !== undefined && !REQUEST_STATUSES.has(status)) {
            throw new TypeError(`unknown request status: ${status}`);
        }
        const before = optionalText(options.before);
        const cursor = options.cursor;
        if (cursor !== undefined) {
            requireText(cursor.receivedAt, "cursor receivedAt");
            requireId(cursor.requestId, "cursor requestId");
        }
        const query = optionalText(options.q);
        // Escape LIKE metacharacters so pasted IDs are searched literally.
        const pattern = query === null
            ? null
            : `%${
                query.replaceAll("\\", "\\\\").replaceAll("%", "\\%")
                    .replaceAll("_", "\\_")
            }%`;
        const filters: string[] = [];
        const parameters: (string | number)[] = [];
        if (status !== undefined) {
            filters.push("status = ?");
            parameters.push(status);
        }
        if (before !== null) {
            filters.push("received_at < ?");
            parameters.push(before);
        }
        if (cursor !== undefined) {
            filters.push("(received_at, request_id) < (?, ?)");
            parameters.push(cursor.receivedAt, cursor.requestId);
        }
        if (pattern !== null) {
            filters.push(`(request_id LIKE ? ESCAPE '\\'
                OR model LIKE ? ESCAPE '\\'
                OR operation LIKE ? ESCAPE '\\'
                OR protocol_plugin_id LIKE ? ESCAPE '\\'
                OR upstream_plugin_id LIKE ? ESCAPE '\\')`);
            parameters.push(pattern, pattern, pattern, pattern, pattern);
        }
        parameters.push(clampLimit(options.limit, 50, 200));
        const rows = this.#db.prepare(
            `SELECT request_id, stream_id, operation, model,
                    protocol_plugin_id, upstream_plugin_id, received_at,
                    status, completed_at, first_token_at, request_json,
                    response_json, error_json, metadata_json
             FROM requests
             ${filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`}
             ORDER BY received_at DESC, request_id DESC
             LIMIT ?`,
        ).all(...parameters) as unknown as RequestRow[];
        return rows.map(toRequest);
    }

    appendFrame(frame: StoredFrame): boolean {
        this.#alive();
        requireId(frame.requestId, "request id");
        if (!Number.isSafeInteger(frame.seq) || frame.seq < 0) {
            throw new TypeError("frame seq must be a non-negative integer");
        }
        requireText(frame.eventId, "event id");
        try {
            const result = this.#db.prepare(
                `INSERT OR IGNORE INTO frames (
                    request_id, seq, version, stream_id, event_id, timestamp,
                    event_json, causation_id, extensions_json
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
                frame.requestId,
                frame.seq,
                frame.version,
                frame.streamId,
                frame.eventId,
                frame.timestamp,
                encodeJson(frame.event),
                optionalText(frame.causationId),
                frame.extensions === undefined
                    ? null
                    : encodeJson(frame.extensions),
            ) as RunResult;
            return Number(result.changes) === 1;
        } catch (error) {
            if (isConstraint(error, "FOREIGN KEY")) {
                throw new StorageNotFoundError(
                    `request not found: ${frame.requestId}`,
                );
            }
            throw error;
        }
    }

    listFrames(
        requestId: string,
        afterSeq = -1,
        limit?: number,
    ): readonly StoredFrame[] {
        this.#alive();
        if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) {
            throw new TypeError(
                "afterSeq must be an integer greater than or equal to -1",
            );
        }
        const rows = this.#db.prepare(
            `SELECT request_id, seq, version, stream_id, event_id, timestamp,
                    event_json, causation_id, extensions_json
             FROM frames
             WHERE request_id = ? AND seq > ?
             ORDER BY seq ASC
             LIMIT ?`,
        ).all(
            requestId,
            afterSeq,
            clampLimit(limit, 200, 500),
        ) as unknown as FrameRow[];
        return rows.map(toFrame);
    }

    getFrameSummary(requestId: string): {
        count: number;
        lastSeq: number | null;
    } {
        this.#alive();
        const row = this.#db.prepare(
            `SELECT COUNT(*) AS count, MAX(seq) AS last_seq
             FROM frames WHERE request_id = ?`,
        ).get(requestId) as { count: number; last_seq: number | null };
        return { count: row.count, lastSeq: row.last_seq };
    }

    putUsage(usage: UsageRecord): void {
        this.#alive();
        requireId(usage.requestId, "request id");
        requireText(usage.updatedAt, "updatedAt");
        try {
            this.#db.prepare(
                `INSERT INTO usage_records (
                    request_id, input_tokens, output_tokens, reasoning_tokens,
                    cached_input_tokens, cache_write_tokens, total_tokens,
                    cost, currency, extensions_json, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(request_id) DO UPDATE SET
                    input_tokens = excluded.input_tokens,
                    output_tokens = excluded.output_tokens,
                    reasoning_tokens = excluded.reasoning_tokens,
                    cached_input_tokens = excluded.cached_input_tokens,
                    cache_write_tokens = excluded.cache_write_tokens,
                    total_tokens = excluded.total_tokens,
                    cost = excluded.cost,
                    currency = excluded.currency,
                    extensions_json = excluded.extensions_json,
                    updated_at = excluded.updated_at`,
            ).run(
                usage.requestId,
                optionalCount(usage.inputTokens),
                optionalCount(usage.outputTokens),
                optionalCount(usage.reasoningTokens),
                optionalCount(usage.cachedInputTokens),
                optionalCount(usage.cacheWriteTokens),
                optionalCount(usage.totalTokens),
                optionalText(usage.cost),
                optionalText(usage.currency),
                usage.extensions === undefined
                    ? null
                    : encodeJson(usage.extensions),
                usage.updatedAt,
            );
        } catch (error) {
            if (isConstraint(error, "FOREIGN KEY")) {
                throw new StorageNotFoundError(
                    `request not found: ${usage.requestId}`,
                );
            }
            throw error;
        }
    }

    getUsage(requestId: string): UsageRecord | null {
        this.#alive();
        const row = this.#db.prepare(
            `SELECT request_id, input_tokens, output_tokens, reasoning_tokens,
                    cached_input_tokens, cache_write_tokens, total_tokens,
                    cost, currency, extensions_json, updated_at
             FROM usage_records WHERE request_id = ?`,
        ).get(requestId) as UsageRow | undefined;
        return row === undefined ? null : toUsage(row);
    }

    usageTotals(from?: string, until?: string): UsageTotals {
        this.#alive();
        const start = optionalText(from);
        const end = optionalText(until);
        const row = this.#db.prepare(
            `SELECT COUNT(*) AS request_count,
                    COALESCE(SUM(input_tokens), 0) AS input_tokens,
                    COALESCE(SUM(output_tokens), 0) AS output_tokens,
                    COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
                    COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
                    COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens
             FROM usage_records
             WHERE (? IS NULL OR updated_at >= ?)
               AND (? IS NULL OR updated_at < ?)`,
        ).get(start, start, end, end) as unknown as TotalRow;
        return {
            requestCount: numberOrZero(row.request_count),
            inputTokens: numberOrZero(row.input_tokens),
            outputTokens: numberOrZero(row.output_tokens),
            reasoningTokens: numberOrZero(row.reasoning_tokens),
            cachedInputTokens: numberOrZero(row.cached_input_tokens),
            cacheWriteTokens: numberOrZero(row.cache_write_tokens),
            totalTokens: numberOrZero(row.total_tokens),
        };
    }

    windowStats(from: string, until: string): RequestWindowStats {
        this.#alive();
        requireText(from, "from");
        requireText(until, "until");
        return queryWindowStats(this.#db, from, until);
    }

    modelStats(
        from: string,
        until: string,
        limit: number,
    ): readonly ModelWindowStats[] {
        this.#alive();
        requireText(from, "from");
        requireText(until, "until");
        return queryModelStats(
            this.#db,
            from,
            until,
            clampLimit(limit, 50, 500),
        );
    }

    /**
     * Delete requests received before `before`, oldest first, up to `maxDeletes`
     * of them, together with their frames and usage rows (no ON DELETE CASCADE
     * is declared, so children are removed first inside one transaction).
     * Returns how many requests were removed and whether the cutoff is drained
     * (`done` is false when the budget was hit and another sweep is warranted).
     */
    pruneOlderThan(
        before: string,
        maxDeletes: number,
    ): { deleted: number; done: boolean } {
        this.#alive();
        requireText(before, "before");
        if (!Number.isInteger(maxDeletes) || maxDeletes < 1) {
            throw new TypeError("maxDeletes must be a positive integer");
        }
        const rows = this.#db.prepare(
            `SELECT request_id FROM requests
             WHERE received_at < ? AND status IN ('completed', 'error', 'cancelled')
             ORDER BY received_at ASC, request_id ASC
             LIMIT ?`,
        ).all(before, maxDeletes) as unknown as { request_id: string }[];
        if (rows.length === 0) return { deleted: 0, done: true };
        const ids = rows.map((row) => row.request_id);
        const holes = ids.map(() => "?").join(", ");
        this.#db.exec("BEGIN");
        try {
            this.#db.prepare(
                `DELETE FROM frames WHERE request_id IN (${holes})`,
            ).run(...ids);
            this.#db.prepare(
                `DELETE FROM usage_records WHERE request_id IN (${holes})`,
            ).run(...ids);
            this.#db.prepare(
                `DELETE FROM requests WHERE request_id IN (${holes})`,
            ).run(...ids);
            this.#db.exec("COMMIT");
        } catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
        return { deleted: ids.length, done: ids.length < maxDeletes };
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#resources.dispose();
    }

    #alive(): void {
        if (this.#closed) throw new Error("request store is closed");
    }
}

export interface SqliteRequestStoreOptions {
    /**
     * Finalize unfinished records from a previous process before accepting new
     * work. Disabled for ordinary opens; executable startup opts in explicitly.
     */
    readonly recoverInterrupted?: boolean;
}

/**
 * Open the single writer for a request journal, creating parent directories.
 * File-backed stores retain a nonblocking OS lock until close (or process exit).
 */
export function openSqliteRequestStore(
    path: string,
    options: SqliteRequestStoreOptions = {},
): SqliteRequestStore {
    const input = path.trim();
    if (input.length === 0) {
        throw new TypeError("request store path is required");
    }
    const file = input === ":memory:" ? input : requestDatabasePath(input);
    using resources = new DisposableStack();
    if (file !== ":memory:") {
        const ownership = resources.use(Deno.openSync(`${file}.lock`, {
            read: true,
            write: true,
            create: true,
        }));
        if (!ownership.tryLockSync(true)) {
            throw new StorageConflictError(
                "request journal is already open for writing",
            );
        }
        // Keep the sidecar on disk. Removing it can let another process lock a
        // replacement file while an existing owner still holds the old handle.
    }
    const db = new DatabaseSync(file);
    // Registered after ownership so the database closes before the lock releases.
    resources.defer(() => db.close());
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    const version = db.prepare("PRAGMA user_version").get() as {
        user_version: number;
    };
    if (version.user_version > 1) {
        throw new Error(
            `unsupported request journal schema version ${version.user_version}`,
        );
    }
    db.exec(SCHEMA);
    // Additive column for pre-existing journals; new databases get it above.
    if (!columns(db, "requests").has("first_token_at")) {
        db.exec("ALTER TABLE requests ADD COLUMN first_token_at TEXT");
    }
    if (version.user_version < 1) db.exec("PRAGMA user_version = 1");
    const recoveredRequests = options.recoverInterrupted === true
        ? recoverInterruptedRequests(db)
        : 0;
    return new SqliteRequestStore(db, resources.move(), recoveredRequests);
}

function requestDatabasePath(path: string): string {
    const absolute = resolve(path);
    const name = basename(absolute);
    if (Deno.build.os === "windows" && /[. ]$/.test(name)) {
        throw new TypeError(
            "request journal filename must not end in a dot or space",
        );
    }
    const parent = dirname(absolute);
    Deno.mkdirSync(parent, { recursive: true });
    try {
        const canonical = Deno.realPathSync(absolute);
        const info = Deno.statSync(canonical);
        if (!info.isFile) {
            throw new TypeError("request journal path must be a file");
        }
        if (info.nlink !== null && info.nlink > 1) {
            throw new TypeError("request journal must not use hard links");
        }
        return canonical;
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    try {
        if (Deno.lstatSync(absolute).isSymlink) {
            throw new TypeError(
                "request journal symbolic link must target an existing file",
            );
        }
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    // Resolving the physical parent also unifies aliases before a DB exists.
    return join(Deno.realPathSync(parent), name);
}

/** A single UPDATE is atomic; callers have sole writer ownership at this point. */
function recoverInterruptedRequests(db: DatabaseSync): number {
    const result = db.prepare(
        `UPDATE requests SET status = 'error', completed_at = ?, error_json = ?
         WHERE status IN ('pending', 'running')`,
    ).run(
        new Date().toISOString(),
        encodeJson({
            code: "process_interrupted",
            message: "服务进程已中断，请重新发起请求。",
        }),
    ) as RunResult;
    return Number(result.changes);
}

function columns(db: DatabaseSync, table: string): Set<string> {
    return new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
            .map((row) => row.name),
    );
}

function toRequest(row: RequestRow): RequestRecord {
    const status = row.status as RequestStatus;
    return {
        requestId: row.request_id,
        streamId: row.stream_id ?? undefined,
        operation: row.operation ?? undefined,
        model: row.model ?? undefined,
        protocolPluginId: row.protocol_plugin_id ?? undefined,
        upstreamPluginId: row.upstream_plugin_id ?? undefined,
        receivedAt: row.received_at,
        status,
        completedAt: row.completed_at ?? undefined,
        firstTokenAt: row.first_token_at ?? undefined,
        request: decodeJson(row.request_json),
        response: row.response_json === null
            ? undefined
            : decodeJson(row.response_json),
        error: row.error_json === null ? undefined : decodeJson(row.error_json),
        metadata: row.metadata_json === null
            ? undefined
            : decodeJson(row.metadata_json) as RequestRecord["metadata"],
    };
}

function toFrame(row: FrameRow): StoredFrame {
    return {
        version: row.version,
        streamId: row.stream_id,
        requestId: row.request_id,
        seq: row.seq,
        eventId: row.event_id,
        timestamp: row.timestamp,
        event: decodeJson(row.event_json),
        causationId: row.causation_id ?? undefined,
        extensions: row.extensions_json === null
            ? undefined
            : decodeJson(row.extensions_json) as StoredFrame["extensions"],
    };
}

function toUsage(row: UsageRow): UsageRecord {
    return {
        requestId: row.request_id,
        inputTokens: row.input_tokens ?? undefined,
        outputTokens: row.output_tokens ?? undefined,
        reasoningTokens: row.reasoning_tokens ?? undefined,
        cachedInputTokens: row.cached_input_tokens ?? undefined,
        cacheWriteTokens: row.cache_write_tokens ?? undefined,
        totalTokens: row.total_tokens ?? undefined,
        cost: row.cost ?? undefined,
        currency: row.currency ?? undefined,
        extensions: row.extensions_json === null
            ? undefined
            : decodeJson(row.extensions_json) as UsageRecord["extensions"],
        updatedAt: row.updated_at,
    };
}

function encodeJson(value: unknown): string {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
        throw new TypeError("request journal value must be JSON");
    }
    return encoded;
}

function decodeJson(value: string): RequestRecord["request"] {
    return JSON.parse(value) as RequestRecord["request"];
}

function requireId(value: string, label: string): void {
    if (value.trim().length === 0) throw new TypeError(`${label} is required`);
}

function requireText(value: string, label: string): void {
    if (value.trim().length === 0) throw new TypeError(`${label} is required`);
}

function optionalText(value: string | undefined): string | null {
    if (value === undefined) return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
}

function optionalCount(value: number | undefined): number | null {
    if (value === undefined) return null;
    if (!Number.isFinite(value)) {
        throw new TypeError("usage counts must be finite numbers");
    }
    return value;
}

function clampLimit(
    value: number | undefined,
    fallback: number,
    max: number,
): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 1) {
        throw new TypeError("limit must be a positive integer");
    }
    return Math.min(value, max);
}

function numberOrZero(value: number | null): number {
    return value ?? 0;
}

function isConstraint(error: unknown, kind: string): boolean {
    return error instanceof Error &&
        error.message.includes(`${kind} constraint`);
}
