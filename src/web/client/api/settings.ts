import { payloadRecord, performRequest } from "./transport.ts";
import type { RuntimeSettingsEnvelope } from "./types.ts";
import {
    readMaintenanceStatus,
    readRetentionDays,
} from "../../shared/retention-settings.ts";

export async function loadRuntimeSettings(): Promise<RuntimeSettingsEnvelope> {
    const result = await performRequest("/api/admin/settings");
    return readRuntimeSettings(result.data, result.etag);
}

export async function saveRuntimeSettings(
    patch: {
        proxyKey?: string;
        limitPerMinute?: number;
        probeIntervalMs?: number;
        titleModel?: string;
        requestRetentionDays?: number;
        chatRetentionDays?: number;
    },
    versionstamp = "",
): Promise<RuntimeSettingsEnvelope> {
    const headers: Record<string, string> = {};
    if (versionstamp) headers["If-Match"] = versionstamp;
    const result = await performRequest("/api/admin/settings", {
        method: "PUT",
        headers,
        body: JSON.stringify(patch),
    });
    return readRuntimeSettings(result.data, result.etag, patch);
}

function readRuntimeSettings(
    data: unknown,
    etag: string,
    fallback: {
        limitPerMinute?: number;
        probeIntervalMs?: number;
        titleModel?: string;
        requestRetentionDays?: number;
        chatRetentionDays?: number;
    } = {},
): RuntimeSettingsEnvelope {
    const body = payloadRecord(data);
    const settings = payloadRecord(body?.settings);
    const requestRetentionDays = readRetentionDays(
        settings?.requestRetentionDays ?? fallback.requestRetentionDays,
    );
    const chatRetentionDays = readRetentionDays(
        settings?.chatRetentionDays ?? fallback.chatRetentionDays,
    );
    const maintenance = readMaintenanceStatus(body?.maintenance);
    return {
        settings: {
            proxyKeyConfigured: settings?.proxyKeyConfigured === true,
            limitPerMinute: typeof settings?.limitPerMinute === "number"
                ? settings.limitPerMinute
                : fallback.limitPerMinute ?? 120,
            probeIntervalMs: typeof settings?.probeIntervalMs === "number"
                ? settings.probeIntervalMs
                : fallback.probeIntervalMs ?? 300_000,
            titleModel: typeof settings?.titleModel === "string"
                ? settings.titleModel
                : fallback.titleModel ?? "",
            ...(requestRetentionDays === undefined
                ? {}
                : { requestRetentionDays }),
            ...(chatRetentionDays === undefined ? {} : { chatRetentionDays }),
        },
        etag,
        ...(maintenance ? { maintenance } : {}),
    };
}
