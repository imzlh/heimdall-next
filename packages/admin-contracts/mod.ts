/**
 * Wire DTOs shared by the operator API and the server-owned JSX console.
 * These types intentionally contain serializable data only.
 */

import type { SourceProxySelection, SourceProxySummary } from "./proxies.ts";
import type { UiJsonObject } from "./ui.ts";
export type * from "./journal.ts";
export type { SourceModelMap } from "./source-model-map.ts";
export type { SourceMiddleware } from "./source-middleware.ts";

export type {
    ProxyEntryView,
    ProxyPoolInput,
    ProxyPoolView,
    SourceProxySelection,
    SourceProxySummary,
} from "./proxies.ts";

export type {
    AuthorizationState,
    AuthorizationStates,
    FormAction,
    FormControl,
    FormErrors,
    FormField,
    FormObject,
    FormOptions,
    FormValue,
    FormValues,
    SourceConfigSchema,
} from "./forms.ts";
export type {
    UiAction,
    UiBlock,
    UiContext,
    UiContribution,
    UiJsonObject,
    UiJsonValue,
    UiPolicy,
    UiRender,
    UiSlot,
    UiTone,
    UiValuePath,
} from "./ui.ts";

export interface ApiError {
    readonly code: string;
    readonly message: string;
    readonly requestId?: string;
    readonly details?: unknown;
}

export interface HealthDto {
    readonly status: "ok" | "degraded" | "error";
    readonly version?: string;
    readonly requestId?: string;
}

export interface ModelDto {
    readonly id: string;
    readonly sourceId?: string;
    readonly ownedBy?: string;
    readonly capabilities?: readonly string[];
}

export interface ModelsResponse {
    readonly object: "list";
    readonly data: readonly ModelDto[];
}

export type AdminPluginKind =
    | "protocol"
    | "api"
    | "source"
    | "middleware"
    | "preset"
    | "tool"
    | "ui";

export interface PluginDto {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly capabilities?: readonly string[];
    readonly dependencies?: readonly string[];
    readonly version: string;
    readonly kind: AdminPluginKind;
    readonly enabled: boolean;
    readonly trust: "trusted" | "isolated";
    readonly digest?: string;
    readonly lastError?: string;
    readonly canToggle?: boolean;
    readonly managed?: boolean;
    readonly revision?: string;
    readonly rollbackVersion?: string;
}

/** Operator input for a new configured source instance. */
export interface CreateSourceInput {
    readonly healthPolicy?:
        | import("./source-health.ts").SourceHealthPolicy
        | null;
    readonly id: string;
    readonly name: string;
    readonly priority: number;
    readonly proxy?: SourceProxySelection;
    readonly modelMap?: import("./source-model-map.ts").SourceModelMap;
    readonly middleware?: import("./source-middleware.ts").SourceMiddleware;
    readonly sourcePluginId: string;
    readonly presetId?: string;
    readonly config: unknown;
}

/** Host-owned instance settings; provider configuration has a separate endpoint. */
export interface UpdateSourceInput {
    readonly healthPolicy?:
        | import("./source-health.ts").SourceHealthPolicy
        | null;
    readonly name?: string;
    readonly priority?: number;
    readonly enabled?: boolean;
    readonly proxy?: SourceProxySelection;
    readonly modelMap?: import("./source-model-map.ts").SourceModelMap;
    readonly middleware?: import("./source-middleware.ts").SourceMiddleware;
}

export interface SourceDto {
    readonly healthPolicy?:
        | import("./source-health.ts").SourceHealthPolicy
        | null;
    readonly effectiveHealthPolicy?:
        import("./source-health.ts").EffectiveSourceHealthPolicy;
    readonly id: string;
    /** Invalid host metadata suspends routing until the operator repairs it. */
    readonly configurationError?: string;
    readonly configurationErrorField?:
        | "modelMap"
        | "config"
        | "middleware"
        | "healthPolicy";
    readonly name?: string;
    readonly priority?: number;
    readonly proxy?: SourceProxySelection;
    readonly modelMap?: import("./source-model-map.ts").SourceModelMap;
    readonly middleware?: import("./source-middleware.ts").SourceMiddleware;
    readonly proxySummary?: SourceProxySummary;
    readonly sourcePluginId?: string;
    readonly enabled: boolean;
    /** Operator's instance switch, independent of the parent plugin switch. */
    readonly instanceEnabled?: boolean;
    readonly pluginEnabled?: boolean;
    /** CAS token covering both instance settings and provider configuration. */
    readonly versionstamp?: string;
    readonly models?: readonly string[];
    readonly capabilities?: readonly string[];
    /** Routing eligibility; ready does not assert a successful upstream probe. */
    readonly health?: "ready" | "cooldown";
    readonly cooldown?: import("./source-health.ts").SourceCooldownDto;
    /** Validated, redacted UI state supplied by this source's plugin. */
    readonly ui?: UiJsonObject;
    /** Present after an operator probe has been recorded for this source. */
    readonly probe?: {
        readonly ok: boolean;
        readonly checkedAt: string;
        readonly message: string;
    };
}

export interface PresetDto {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly sourcePluginId: string;
    readonly description?: string;
}

export interface AdminSnapshot {
    readonly health: HealthDto;
    readonly models: ModelsResponse;
    readonly plugins: readonly PluginDto[];
    readonly sources: readonly SourceDto[];
    readonly presets: readonly PresetDto[];
}

export type RequestStatusDto =
    | "pending"
    | "running"
    | "completed"
    | "error"
    | "cancelled";

/** Request list row. The body stays off this DTO so lists cannot leak payloads. */
export interface RequestSummaryDto {
    readonly requestId: string;
    readonly status: RequestStatusDto;
    readonly receivedAt: string;
    readonly streamId?: string;
    readonly operation?: string;
    readonly model?: string;
    readonly completedAt?: string;
    /** When the first content frame arrived; TTFT is the gap from `receivedAt`. */
    readonly firstTokenAt?: string;
    /** True when the turn streamed (SSE); a single duration is shown otherwise. */
    readonly streaming?: boolean;
    readonly protocolPluginId?: string;
    readonly upstreamPluginId?: string;
    /** Token counts for the row, when recorded. Aggregate figures, not a body. */
    readonly usage?: UsageDto | null;
}

export interface UsageDto {
    readonly requestId: string;
    readonly updatedAt: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly reasoningTokens?: number;
    readonly cachedInputTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly totalTokens?: number;
    readonly cost?: string;
    readonly currency?: string;
    readonly extensions?: unknown;
}

export interface RequestDetailDto extends RequestSummaryDto {
    readonly request: unknown;
    readonly response?: unknown;
    readonly error?: unknown;
    readonly usage?: UsageDto | null;
    readonly metadata?: unknown;
}

export interface FrameDto {
    readonly version: number;
    readonly streamId: string;
    readonly requestId: string;
    readonly seq: number;
    readonly eventId: string;
    readonly timestamp: string;
    readonly event: unknown;
    readonly causationId?: string;
    readonly extensions?: unknown;
}

export interface UsageTotalsDto {
    readonly requestCount: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheWriteTokens: number;
    readonly totalTokens: number;
}

export interface UsageDayDto {
    readonly day: string;
    readonly requestCount: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
}

/** Requests received in one window, with the usage they reported. */
export interface UsageCountersDto {
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

export interface UsageSeriesPointDto extends UsageCountersDto {
    /** Natural day, YYYY-MM-DD, in the response's `timeZone`. */
    readonly date: string;
}

export interface ModelUsageDto extends UsageCountersDto {
    /** Null collects requests that named no model. */
    readonly model: string | null;
}

/** `GET /stats`: today, the last seven natural days, and today's models. */
export interface StatsOverviewDto {
    readonly timeZone: string;
    readonly date: string;
    readonly today: UsageCountersDto;
    readonly week: UsageCountersDto;
    readonly models: readonly ModelUsageDto[];
    readonly modelsTruncated: boolean;
}

/** `GET /stats/series?days=N`: one point per natural day, oldest first. */
export interface StatsSeriesDto {
    readonly timeZone: string;
    readonly days: number;
    readonly series: readonly UsageSeriesPointDto[];
}

/** Which window the trend chart draws: natural days, wall-clock hours, or the adaptive recent window. */
export type StatsTrendMode = "day" | "hour" | "recent";

export interface StatsTrendPointDto extends UsageCountersDto {
    /** Bucket start, ISO-8601 UTC. Buckets are `[from, from + bucketMinutes)`. */
    readonly from: string;
    /** Civil date of the bucket start in the response's `timeZone`. */
    readonly day: string;
    /** Wall-clock label: `MM-DD` for day buckets, `HH:mm` for hour and finer. */
    readonly label: string;
}

/** `GET /stats/trend?mode=…`: one bucket per point, oldest first, ending in the present bucket. */
export interface StatsTrendDto {
    readonly timeZone: string;
    readonly mode: StatsTrendMode;
    /** Bucket width in minutes: 1440, 60, 30, or 15. */
    readonly bucketMinutes: number;
    /** Window start (inclusive) and end (exclusive), ISO-8601 UTC. */
    readonly from: string;
    readonly until: string;
    /** `recent` found no usage today and fell back to the trailing day. */
    readonly fallback: boolean;
    readonly series: readonly StatsTrendPointDto[];
}

/** `GET /stats/models?date=YYYY-MM-DD`: one natural day, busiest model first. */
export interface ModelRankingDto {
    readonly timeZone: string;
    readonly date: string;
    readonly models: readonly ModelUsageDto[];
    readonly truncated: boolean;
}
