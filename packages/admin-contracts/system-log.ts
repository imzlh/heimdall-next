/**
 * System (application) log DTOs shared by the in-memory ring buffer, the
 * management route, SSR and the browser island. These describe the service's
 * own operational events — startup, probing, maintenance, plugin lifecycle and
 * errors — as opposed to the per-request journal.
 */

/** Ordered from least to most severe; the query filter keeps this order. */
export type SystemLogLevel = "debug" | "info" | "warn" | "error";

export const SYSTEM_LOG_LEVELS: readonly SystemLogLevel[] = [
    "debug",
    "info",
    "warn",
    "error",
];

export interface SystemLogEntryDto {
    /** Monotonic per-process sequence; the client polls with `afterSeq`. */
    readonly seq: number;
    /** ISO timestamp of when the event was recorded. */
    readonly time: string;
    readonly level: SystemLogLevel;
    /** Coarse subsystem label, e.g. "startup", "probe", "maintenance". */
    readonly scope: string;
    readonly message: string;
    /** Optional bounded extra context; already redacted and length-limited. */
    readonly detail?: string;
}

export interface SystemLogListResponse {
    readonly entries: readonly SystemLogEntryDto[];
    /** Highest sequence the buffer holds; poll again with this as `afterSeq`. */
    readonly nextAfterSeq: number;
    /** Entries evicted since the process started, for gap awareness. */
    readonly dropped: number;
    /** Ring buffer size, so the UI can explain why history is bounded. */
    readonly capacity: number;
}

export interface SystemLogQuery {
    /** Minimum severity to include. Absent means every level. */
    readonly level?: SystemLogLevel;
    /** Only entries with a strictly greater sequence, for incremental polling. */
    readonly afterSeq?: number;
    readonly limit?: number;
}
