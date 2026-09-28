import type {
    ProxyPoolView,
    SourceProxySelection,
    SourceProxySummary,
} from "./proxies.ts";
import type { StatsOverviewDto, StatsSeriesDto } from "./mod.ts";

/** Serializable console view data shared by SSR and hono/jsx/dom islands. */
export interface ServiceHealth {
    status?: string;
}

export interface ListedModel {
    id?: string;
    owned_by?: string;
}

export interface ListedSource {
    id?: string;
    name?: string;
    priority?: number;
    sourcePluginId?: string;
    enabled?: boolean;
    instanceEnabled?: boolean;
    pluginEnabled?: boolean;
    versionstamp?: string;
    health?: string;
    models?: unknown[];
    capabilities?: unknown[];
    probe?: { ok?: boolean; message?: string };
    proxy?: SourceProxySelection;
    proxySummary?: SourceProxySummary;
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
    /** Installed through the plugin host rather than shipped in the service. */
    managed?: boolean;
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
}

export interface RuntimeSettingsEnvelope {
    settings: RuntimeSettingsView;
    etag: string;
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
