import type {
    SystemLogEntryDto,
    SystemLogLevel,
    SystemLogListResponse,
    SystemLogQuery,
} from "@heimdall/admin-contracts/system-log.ts";

/** Default in-memory ring capacity. Restart clears the buffer by design. */
export const DEFAULT_SYSTEM_LOG_CAPACITY = 500;
export const MAX_SYSTEM_LOG_LIMIT = 500;
export const DEFAULT_SYSTEM_LOG_LIMIT = 200;

const MAX_SCOPE_CHARS = 64;
const MAX_MESSAGE_CHARS = 2000;
const MAX_DETAIL_CHARS = 4000;
/** Values shorter than this are left to shape-based redaction, not exact match. */
const MIN_REDACTABLE_SECRET_CHARS = 6;
const REDACTED = "[已隐藏]";

const LEVEL_ORDER: Record<SystemLogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

// Shape-based redaction is a backstop for upstream-authored text (error
// bodies, stack traces) that carries credentials the buffer was never told
// about. It is deliberately conservative and, like every heuristic redactor,
// not a guarantee — exact-value redaction (addSecret) covers what we do know.
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
    /\bsk-[A-Za-z0-9-]{6,}/g,
    /\bghp_[A-Za-z0-9]{6,}/g,
    /\bAKIA[0-9A-Z]{12,}/g,
    /\b(?:api[_-]?key|token|secret|password|passwd|cookie|authorization)\b\s*[=:]\s*"?[^\s"']{4,}"?/gi,
];

export interface SystemLogRecordInput {
    readonly level: SystemLogLevel;
    readonly scope: string;
    readonly message: string;
    readonly detail?: string;
}

export interface SystemLogOptions {
    readonly capacity?: number;
    /** Mirror recorded events to the console. The process default enables this. */
    readonly mirror?: boolean;
    readonly clock?: () => Date;
}

/**
 * Bounded, in-memory system event log. It never persists: a restart is meant
 * to clear it, so it needs no retention sweep and cannot outlive one process.
 * Recording is synchronous and cheap; it is safe on any hot path.
 */
export class SystemLog {
    #entries: SystemLogEntryDto[] = [];
    readonly #capacity: number;
    readonly #mirror: boolean;
    readonly #clock: () => Date;
    readonly #secrets = new Set<string>();
    #seq = 0;
    #dropped = 0;

    constructor(options: SystemLogOptions = {}) {
        const capacity = options.capacity ?? DEFAULT_SYSTEM_LOG_CAPACITY;
        this.#capacity = capacity > 0 ? Math.floor(capacity) : 1;
        this.#mirror = options.mirror ?? false;
        this.#clock = options.clock ?? (() => new Date());
    }

    /** Register an exact credential value so it is scrubbed from every field. */
    addSecret(value: string | undefined): void {
        const secret = value?.trim();
        if (secret && secret.length >= MIN_REDACTABLE_SECRET_CHARS) {
            this.#secrets.add(secret);
        }
    }

    record(input: SystemLogRecordInput): SystemLogEntryDto {
        const secrets = this.#secrets;
        const entry: SystemLogEntryDto = {
            seq: ++this.#seq,
            time: this.#clock().toISOString(),
            level: input.level,
            scope: boundedText(input.scope || "system", MAX_SCOPE_CHARS),
            message: redact(
                boundedText(input.message, MAX_MESSAGE_CHARS),
                secrets,
            ),
            ...(input.detail === undefined || input.detail === "" ? {} : {
                detail: redact(
                    boundedText(input.detail, MAX_DETAIL_CHARS),
                    secrets,
                ),
            }),
        };
        this.#entries.push(entry);
        while (this.#entries.length > this.#capacity) {
            this.#entries.shift();
            this.#dropped++;
        }
        if (this.#mirror) mirror(entry);
        return entry;
    }

    list(query: SystemLogQuery = {}): SystemLogListResponse {
        const minimum = query.level === undefined
            ? -1
            : LEVEL_ORDER[query.level];
        const afterSeq = Number.isFinite(query.afterSeq)
            ? query.afterSeq as number
            : -1;
        const limit = clampLimit(query.limit);
        const matched = this.#entries.filter((entry) =>
            LEVEL_ORDER[entry.level] >= minimum && entry.seq > afterSeq
        );
        // Return the most recent `limit`, still oldest-first for stable append.
        const entries = matched.length > limit
            ? matched.slice(matched.length - limit)
            : matched;
        return {
            entries,
            nextAfterSeq: this.#seq,
            dropped: this.#dropped,
            capacity: this.#capacity,
        };
    }

    /** Entries currently retained; primarily for tests. */
    get size(): number {
        return this.#entries.length;
    }

    get dropped(): number {
        return this.#dropped;
    }
}

function clampLimit(value: number | undefined): number {
    if (!Number.isFinite(value) || (value as number) <= 0) {
        return DEFAULT_SYSTEM_LOG_LIMIT;
    }
    return Math.min(Math.floor(value as number), MAX_SYSTEM_LOG_LIMIT);
}

function boundedText(value: string, maximum: number): string {
    const text = typeof value === "string" ? value : String(value ?? "");
    return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

/** Exact secrets first (facts), then shape heuristics (guesses at wording). */
function redact(value: string, secrets: ReadonlySet<string>): string {
    let result = value;
    for (const secret of secrets) {
        if (result.includes(secret)) {
            result = result.replaceAll(secret, REDACTED);
        }
    }
    for (const pattern of SECRET_VALUE_PATTERNS) {
        result = result.replace(pattern, (match) => {
            const separator = match.search(/[=:]/);
            return separator === -1
                ? REDACTED
                : `${match.slice(0, separator + 1)} ${REDACTED}`;
        });
    }
    return result;
}

function mirror(entry: SystemLogEntryDto): void {
    const line = `[${entry.scope}] ${entry.message}${
        entry.detail ? ` — ${entry.detail}` : ""
    }`;
    if (entry.level === "error") console.error(line);
    else if (entry.level === "warn") console.warn(line);
    else if (entry.level === "info") console.info(line);
    else console.debug(line);
}

/**
 * Process-wide default. Composition records into this instance and hands the
 * same reference to the management route, so the console and the admin page
 * observe one buffer. Tests construct their own `SystemLog` for isolation.
 */
export const systemLog: SystemLog = new SystemLog({ mirror: true });

/** Scoped convenience recorders for the default buffer. */
export const log = {
    debug(scope: string, message: string, detail?: string): void {
        systemLog.record({ level: "debug", scope, message, detail });
    },
    info(scope: string, message: string, detail?: string): void {
        systemLog.record({ level: "info", scope, message, detail });
    },
    warn(scope: string, message: string, detail?: string): void {
        systemLog.record({ level: "warn", scope, message, detail });
    },
    error(scope: string, message: string, detail?: string): void {
        systemLog.record({ level: "error", scope, message, detail });
    },
};
