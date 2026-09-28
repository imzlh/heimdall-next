import { payloadRecord, performRequest } from "./transport.ts";
import type { RuntimeSettingsEnvelope } from "./types.ts";

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
    } = {},
): RuntimeSettingsEnvelope {
    const body = payloadRecord(data);
    const settings = payloadRecord(body?.settings);
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
        },
        etag,
    };
}
