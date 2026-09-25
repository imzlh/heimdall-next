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
}

export interface UsageSnapshot {
    totalTokens: number;
}

export interface UsageDay {
    day: string;
    requestCount: number;
    totalTokens: number;
}

export interface UsageResponse {
    usage?: UsageSnapshot | null;
    days?: UsageDay[];
}

export interface RuntimeSettingsView {
    proxyKeyConfigured: boolean;
    limitPerMinute: number;
    probeIntervalMs: number;
}

export interface RuntimeSettingsEnvelope {
    settings: RuntimeSettingsView;
    etag: string;
}

export interface ConsoleSnapshot {
    dashboard: DashboardData;
    requests: JournalRequest[];
    usage: UsageResponse;
    settings: RuntimeSettingsEnvelope | null;
    errors: { requests: string; usage: string; settings: string };
}
