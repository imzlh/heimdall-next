import type { JournalRequest } from "@heimdall/admin-contracts/console.ts";
export type {
    DashboardData,
    DashboardErrors,
    JournalRequest,
    ListedModel,
    ListedPlugin,
    ListedPreset,
    ListedSource,
    RuntimeSettingsEnvelope,
    RuntimeSettingsView,
    ServiceHealth,
    UsageDay,
    UsageResponse,
    UsageSnapshot,
} from "@heimdall/admin-contracts/console.ts";

export interface JournalResponse {
    requests?: JournalRequest[];
}
export type SourceCompatMode = "full" | "chat" | "embeddings" | "images";

/** Plugin schemas define the input keys; the server validates each plugin's values. */
export type SourceConfigInput = Record<string, unknown>;

/** Config document as stored by the management API. Values are checked at the UI boundary. */
export type LoadedSourceConfig = Record<string, unknown>;

export interface ManagedSourceRecord {
    sourceId?: string;
    versionstamp?: string;
    config?: LoadedSourceConfig;
}

export interface SourceConfigEnvelope {
    source?: ManagedSourceRecord;
    etag: string;
}

export interface SourceProbeResult {
    probe: {
        sourceId: string;
        ok: boolean;
        message: string;
        health: "ready" | "cooldown";
    };
}
