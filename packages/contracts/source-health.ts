/** Host-owned durations in milliseconds; omitted fields inherit registry defaults. */
export interface SourceHealthPolicy {
    readonly cooldownMs?: number;
    readonly authCooldownMs?: number;
}

export interface EffectiveSourceHealthPolicy {
    readonly cooldownMs: number;
    readonly authCooldownMs: number;
}

export const MAX_SOURCE_COOLDOWN_MS = 86_400_000;
export const DEFAULT_SOURCE_HEALTH_POLICY: EffectiveSourceHealthPolicy = Object
    .freeze({
        cooldownMs: 30_000,
        authCooldownMs: 300_000,
    });

const POLICY_FIELDS = new Set(["cooldownMs", "authCooldownMs"]);

/** Accept only JSON data; getters, prototypes and extra fields never enter policy state. */
export function parseSourceHealthPolicy(
    value: unknown,
): SourceHealthPolicy | null {
    if (value === undefined || value === null) return null;
    const record = plainData(value, POLICY_FIELDS);
    if (!record) {
        throw new TypeError(
            "健康策略必须是只包含冷却时长的 JSON 对象，或 null。",
        );
    }
    const result: { cooldownMs?: number; authCooldownMs?: number } = {};
    for (const key of ["cooldownMs", "authCooldownMs"] as const) {
        if (!Object.hasOwn(record, key)) continue;
        const duration = record[key];
        if (
            typeof duration !== "number" || !Number.isSafeInteger(duration) ||
            duration < 0 || duration > MAX_SOURCE_COOLDOWN_MS
        ) {
            throw new TypeError(
                `${key} 必须是 0 至 ${MAX_SOURCE_COOLDOWN_MS} 的整数毫秒。`,
            );
        }
        result[key] = duration;
    }
    return result;
}

export type SourceCooldownReason =
    | "authentication"
    | "rate_limit"
    | "upstream"
    | "transport"
    | "probe";

/** Only bounded host categories and timestamps may be persisted or exposed. */
export interface SourceCooldown {
    readonly reason: SourceCooldownReason;
    readonly startedAt: string;
    readonly until: string;
}

const COOLDOWN_FIELDS = new Set(["reason", "startedAt", "until"]);
const REASONS = new Set<string>([
    "authentication",
    "rate_limit",
    "upstream",
    "transport",
    "probe",
]);

export function readSourceCooldown(value: unknown): SourceCooldown | undefined {
    const record = plainData(value, COOLDOWN_FIELDS);
    if (
        !record || typeof record.reason !== "string" ||
        !REASONS.has(record.reason)
    ) return undefined;
    const startedAt = isoTimestamp(record.startedAt);
    const until = isoTimestamp(record.until);
    if (
        startedAt === undefined || until === undefined || until <= startedAt ||
        until - startedAt > MAX_SOURCE_COOLDOWN_MS
    ) return undefined;
    return {
        reason: record.reason as SourceCooldownReason,
        startedAt: new Date(startedAt).toISOString(),
        until: new Date(until).toISOString(),
    };
}

function plainData(
    value: unknown,
    allowed: ReadonlySet<string>,
): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !allowed.has(key)) return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            return undefined;
        }
        result[key] = descriptor.value;
    }
    return result;
}

function isoTimestamp(value: unknown): number | undefined {
    if (typeof value !== "string") return undefined;
    const match =
        /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/
            .exec(value);
    if (!match) return undefined;
    // Date.parse alone normalizes invalid calendar dates such as February 30.
    const local = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
    const calendar = Date.parse(local);
    if (
        !Number.isFinite(calendar) || new Date(calendar).toISOString() !== local
    ) return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
}
