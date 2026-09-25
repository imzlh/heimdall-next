/**
 * Wire DTOs shared by the operator API and the server-owned JSX console.
 * These types intentionally contain serializable data only.
 */

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
}

/** Operator input for a new configured source instance. */
export interface CreateSourceInput {
    readonly id: string;
    readonly name: string;
    readonly priority: number;
    readonly sourcePluginId: string;
    readonly presetId?: string;
    readonly config: unknown;
}

/** Host-owned instance settings; provider configuration has a separate endpoint. */
export interface UpdateSourceInput {
    readonly name?: string;
    readonly priority?: number;
    readonly enabled?: boolean;
}

export interface SourceDto {
    readonly id: string;
    readonly name?: string;
    readonly priority?: number;
    readonly sourcePluginId?: string;
    readonly enabled: boolean;
    /** Operator's instance switch, independent of the parent plugin switch. */
    readonly instanceEnabled?: boolean;
    readonly pluginEnabled?: boolean;
    /** CAS token covering both instance settings and provider configuration. */
    readonly versionstamp?: string;
    readonly models?: readonly string[];
    readonly capabilities?: readonly string[];
    /** Present only while the source is cooling down after an upstream failure. */
    readonly health?: "ready" | "cooldown";
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
    readonly protocolPluginId?: string;
    readonly upstreamPluginId?: string;
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
}

export interface RequestDetailDto extends RequestSummaryDto {
    readonly request: unknown;
    readonly response?: unknown;
    readonly error?: unknown;
    readonly usage?: UsageDto | null;
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

/** `GET /stats/models?date=YYYY-MM-DD`: one natural day, busiest model first. */
export interface ModelRankingDto {
    readonly timeZone: string;
    readonly date: string;
    readonly models: readonly ModelUsageDto[];
    readonly truncated: boolean;
}
