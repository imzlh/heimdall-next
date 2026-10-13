import type {
    ProxyPoolView,
    SourceProxySelection,
    SourceProxySummary,
} from "./proxies.ts";
import type { StatsOverviewDto, StatsSeriesDto } from "./mod.ts";
import type { UiJsonObject } from "./ui.ts";

/** Serializable console view data shared by SSR and hono/jsx/dom islands. */
export interface ServiceHealth {
    status?: string;
}

export interface ListedModel {
    id?: string;
    owned_by?: string;
}

export interface ListedSource {
    healthPolicy?: import("./source-health.ts").SourceHealthPolicy | null;
    effectiveHealthPolicy?:
        import("./source-health.ts").EffectiveSourceHealthPolicy;
    id?: string;
    configurationError?: string;
    configurationErrorField?:
        | "modelMap"
        | "config"
        | "middleware"
        | "healthPolicy";
    name?: string;
    priority?: number;
    sourcePluginId?: string;
    enabled?: boolean;
    instanceEnabled?: boolean;
    pluginEnabled?: boolean;
    versionstamp?: string;
    health?: string;
    cooldown?: import("./source-health.ts").SourceCooldownDto;
    models?: unknown[];
    capabilities?: unknown[];
    ui?: UiJsonObject;
    probe?: { ok?: boolean; message?: string };
    proxy?: SourceProxySelection;
    proxySummary?: SourceProxySummary;
    modelMap?: import("./source-model-map.ts").SourceModelMap;
    middleware?: import("./source-middleware.ts").SourceMiddleware;
}

export interface ListedPlugin {
    id: string;
    name?: string;
    description?: string;
    capabilities?: readonly string[];
    dependencies?: readonly string[];
    kind?: string;
    version?: string;
    trust?: string;
    enabled?: boolean;
    lastError?: string;
    /** Host-supplied operation support; never inferred from plugin kind or trust. */
    canToggle?: boolean;
    /** Host-owned configuration is available through the management API. */
    canConfigure?: boolean;
    /** Installed through the plugin host rather than shipped in the service. */
    managed?: boolean;
    revision?: string;
    rollbackVersion?: string;
}

export interface ListedPreset {
    id: string;
    name?: string;
    sourcePluginId?: string;
    version?: string | number;
}

export interface DashboardErrors {
    health: string;
    models: string;
    status: string;
    presets: string;
    source: string;
}

export interface DashboardData {
    health: ServiceHealth;
    models: ListedModel[];
    status: {
        sources: ListedSource[];
        plugins: ListedPlugin[];
        managed: unknown[];
        presets: ListedPreset[];
    };
    authRequired: boolean;
    errors: DashboardErrors;
}

export interface JournalRequest {
    requestId: string;
    model?: string;
    operation?: string;
    status?: string;
    receivedAt?: string;
    completedAt?: string;
    /** When the first content frame arrived; TTFT is the gap from `receivedAt`. */
    firstTokenAt?: string;
    /** True when the turn streamed (SSE); a single duration is shown otherwise. */
    streaming?: boolean;
    usage?: import("./mod.ts").UsageDto | null;
}

export interface UsageSnapshot {
    totalTokens: number;
}

export interface UsageDay {
    day: string;
    requestCount: number;
    totalTokens: number;
    inputTokens?: number;
    outputTokens?: number;
}

export interface UsageResponse {
    usage?: UsageSnapshot | null;
    days?: UsageDay[];
}

export interface RuntimeSettingsView {
    proxyKeyConfigured: boolean;
    limitPerMinute: number;
    probeIntervalMs: number;
    /** Cheap model id for chat auto-titling; "" means disabled. */
    titleModel: string;
    /** Retain completed request records for this many days; 0 keeps them forever. */
    requestRetentionDays?: number;
    /** Retain conversations by last activity; 0 keeps them forever. */
    chatRetentionDays?: number;
}

export interface MaintenanceStatusView {
    /** Whether history expiration is enabled; orphan attachment cleanup always runs. */
    enabled: boolean;
    running: boolean;
    lastRunAt: string | null;
    nextRunAt: string | null;
    prunedRequests: number;
    prunedConversations: number;
    prunedAssets: number;
    lastError: string | null;
}

export interface RuntimeSettingsEnvelope {
    settings: RuntimeSettingsView;
    etag: string;
    maintenance?: MaintenanceStatusView;
}

export interface ConsoleSnapshot {
    dashboard: DashboardData;
    requests: JournalRequest[];
    journal?: JournalSnapshot;
    usage: UsageResponse;
    settings: RuntimeSettingsEnvelope | null;
    proxies?: { pool: ProxyPoolView; etag: string } | null;
    /** The log page's system-log tab; absent unless that page is rendered. */
    systemLog?: SystemLogSnapshot;
    stats?: {
        overview: StatsOverviewDto | null;
        series: StatsSeriesDto | null;
        errors: { overview: string; series: string };
    };
    errors: {
        requests: string;
        usage: string;
        settings: string;
        proxies?: string;
    };
}

/** The log page's SSR data; request bodies are fetched only for a selected row. */
export interface JournalSnapshot {
    requests: readonly import("./mod.ts").RequestSummaryDto[];
    nextCursor: string | null;
    error: string;
    q?: string;
    status?: import("./mod.ts").RequestStatusDto;
    cursor?: string | null;
    selectedId?: string;
    detail?: import("./journal.ts").RequestJournalDetailResponse;
    detailError?: string;
}

/** The log page's system-log tab data, mirrored to the browser island. */
export interface SystemLogSnapshot {
    entries: readonly import("./system-log.ts").SystemLogEntryDto[];
    nextAfterSeq: number;
    dropped: number;
    capacity: number;
    error: string;
    level?: import("./system-log.ts").SystemLogLevel;
}
