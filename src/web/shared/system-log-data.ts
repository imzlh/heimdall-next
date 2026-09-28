import type {
    SystemLogEntryDto,
    SystemLogLevel,
    SystemLogListResponse,
} from "@heimdall/admin-contracts/system-log.ts";
import { SYSTEM_LOG_LEVELS } from "@heimdall/admin-contracts/system-log.ts";

/** Shared SSR/island validation with no browser transport dependency. */
export class SystemLogDataError extends Error {
    constructor() {
        super("系统日志返回了无法识别的数据，请刷新重试");
        this.name = "SystemLogDataError";
    }
}

function invalid(): never {
    throw new SystemLogDataError();
}

function record(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return invalid();
    }
    return value as Record<string, unknown>;
}

function isLevel(value: unknown): value is SystemLogLevel {
    return typeof value === "string" &&
        (SYSTEM_LOG_LEVELS as readonly string[]).includes(value);
}

function integer(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        return invalid();
    }
    return value;
}

function text(value: unknown, allowEmpty = true): string {
    if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
        return invalid();
    }
    return value;
}

function entry(value: unknown): SystemLogEntryDto {
    const row = record(value);
    if (!isLevel(row.level)) invalid();
    const time = text(row.time, false);
    if (!Number.isFinite(Date.parse(time))) invalid();
    return {
        seq: integer(row.seq),
        time,
        level: row.level,
        scope: text(row.scope),
        message: text(row.message),
        ...(row.detail === undefined ? {} : { detail: text(row.detail) }),
    };
}

export function parseSystemLogList(value: unknown): SystemLogListResponse {
    const body = record(value);
    if (!Array.isArray(body.entries)) invalid();
    return {
        entries: body.entries.map(entry),
        nextAfterSeq: integer(body.nextAfterSeq),
        dropped: integer(body.dropped),
        capacity: integer(body.capacity),
    };
}

export interface SystemLogLevelPresentation {
    readonly label: string;
    /** Matches the shared `status-chip chip-<tone>` classes. */
    readonly tone: "muted" | "ok" | "amber" | "red";
}

const LEVEL_PRESENTATION: Record<SystemLogLevel, SystemLogLevelPresentation> = {
    debug: { label: "调试", tone: "muted" },
    info: { label: "信息", tone: "ok" },
    warn: { label: "警告", tone: "amber" },
    error: { label: "错误", tone: "red" },
};

export function systemLogLevel(
    level: SystemLogLevel,
): SystemLogLevelPresentation {
    return LEVEL_PRESENTATION[level];
}
