/** Render timestamps in the viewer's local time, like the original console. */
export function requestReceivedTime(value?: string): string {
    if (!value) return "时间未知";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const pad = (input: number) => String(input).padStart(2, "0");
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${
        pad(date.getSeconds())
    }`;
    const sameYear = date.getFullYear() === new Date().getFullYear();
    const day = sameYear
        ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${
            pad(date.getDate())
        }`;
    return `${day} ${time}`;
}

export function requestState(status?: string): {
    label: string;
    tone: "green" | "amber" | "red" | "muted";
} {
    switch (status) {
        case "pending":
            return { label: "等待中", tone: "amber" };
        case "running":
            return { label: "处理中", tone: "amber" };
        case "completed":
            return { label: "已完成", tone: "green" };
        case "error":
            return { label: "失败", tone: "red" };
        case "cancelled":
            return { label: "已取消", tone: "muted" };
        default:
            return { label: status || "未知", tone: "muted" };
    }
}

/** Elapsed milliseconds between two ISO timestamps, or null when not derivable. */
function elapsedMs(from?: string, to?: string): number | null {
    if (!from || !to) return null;
    const span = Date.parse(to) - Date.parse(from);
    return Number.isFinite(span) && span >= 0 ? span : null;
}

/** `842 ms` under a second, `1.23 s` above it. */
export function formatDuration(ms: number): string {
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export interface RequestTimings {
    /** First-content latency, shown only for streamed turns. */
    readonly firstToken: string | null;
    /** Total wall-clock time from receipt to completion. */
    readonly total: string | null;
}

/**
 * Format a row's latencies. Streamed turns expose time-to-first-token and the
 * full duration; a non-streaming turn produces its answer in one shot, so only
 * the total is meaningful and `firstToken` stays null.
 */
export function requestTimings(
    row: {
        receivedAt?: string;
        completedAt?: string;
        firstTokenAt?: string;
        streaming?: boolean;
    },
): RequestTimings {
    const total = elapsedMs(row.receivedAt, row.completedAt);
    const first = row.streaming === true
        ? elapsedMs(row.receivedAt, row.firstTokenAt)
        : null;
    return {
        firstToken: first === null ? null : formatDuration(first),
        total: total === null ? null : formatDuration(total),
    };
}
import type { RequestStatusDto } from "@heimdall/admin-contracts";

export const REQUEST_STATUSES: readonly RequestStatusDto[] = [
    "pending",
    "running",
    "completed",
    "error",
    "cancelled",
];
