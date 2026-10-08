export {
    DEFAULT_SOURCE_HEALTH_POLICY,
    parseSourceHealthPolicy,
} from "../contracts/source-health.ts";
export type {
    EffectiveSourceHealthPolicy,
    SourceHealthPolicy,
} from "../contracts/source-health.ts";

/** Public host-owned categories. Upstream response bodies never cross this DTO. */
export interface SourceCooldownDto {
    readonly reason:
        | "authentication"
        | "rate_limit"
        | "upstream"
        | "transport"
        | "probe";
    readonly startedAt: string;
    readonly until: string;
}

export interface SourceHealthDto {
    readonly health: "ready" | "cooldown";
    readonly cooldown?: SourceCooldownDto;
}

export interface SourceHealthResetDto extends SourceHealthDto {
    readonly sourceId: string;
    readonly cleared: boolean;
}

/** Reject malformed or unrecognised data before rendering SSR/client state. */
export function readSourceCooldown(
    value: unknown,
): SourceCooldownDto | undefined {
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (
        typeof item.reason !== "string" ||
        !["authentication", "rate_limit", "upstream", "transport", "probe"]
            .includes(item.reason) ||
        typeof item.startedAt !== "string" || typeof item.until !== "string" ||
        !Number.isFinite(Date.parse(item.startedAt)) ||
        !Number.isFinite(Date.parse(item.until))
    ) return;
    return {
        reason: item.reason as SourceCooldownDto["reason"],
        startedAt: new Date(item.startedAt).toISOString(),
        until: new Date(item.until).toISOString(),
    };
}
