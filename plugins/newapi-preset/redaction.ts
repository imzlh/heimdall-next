import type { JsonValue, PresetApplication } from "@heimdall/contracts";
import {
    isSensitiveHeaderName,
    type OpenAICompatibleSourceConfig,
} from "./schema.ts";

/** Return the admin-safe representation of a generated source configuration. */
export function redactNewApiSourceConfig(
    value: OpenAICompatibleSourceConfig,
): JsonValue {
    const safeHeaders: Record<string, JsonValue> = {};
    for (const [name, headerValue] of Object.entries(value.headers ?? {})) {
        // Keep a second defensive filter here even though schema validation
        // rejects credential-like names. Redaction must stay safe if called with a
        // hand-built PresetApplication by an embedding host.
        if (isSensitiveHeaderName(name)) continue;
        safeHeaders[name] = headerValue;
    }

    return {
        id: value.id,
        baseUrl: value.baseUrl,
        endpoint: value.endpoint,
        ...(value.modelMap === undefined ? {} : { modelMap: value.modelMap }),
        ...(Object.keys(safeHeaders).length === 0
            ? {}
            : { headers: safeHeaders }),
        apiKeyConfigured: typeof value.apiKey === "string" &&
            value.apiKey.trim().length > 0,
    };
}

/** Redact a preset application without ever serializing its apiKey. */
export function redactNewApiPresetApplication(
    application: PresetApplication,
): JsonValue {
    const config = application.config;
    if (!isRecord(config)) {
        return { apiKeyConfigured: false };
    }
    return redactNewApiSourceConfig({
        id: stringValue(config.id, "newapi"),
        baseUrl: stringValue(config.baseUrl, ""),
        endpoint: stringValue(config.endpoint, "/chat/completions"),
        ...(typeof config.apiKey === "string" ? { apiKey: config.apiKey } : {}),
        ...(isRecord(config.modelMap)
            ? { modelMap: stringRecord(config.modelMap) }
            : {}),
        ...(isRecord(config.headers)
            ? { headers: stringRecord(config.headers) }
            : {}),
    });
}

function stringValue(value: JsonValue | undefined, fallback: string): string {
    return typeof value === "string" ? value : fallback;
}

function stringRecord(
    value: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === "string") result[key] = item;
    }
    return result;
}

function isRecord(
    value: unknown,
): value is Readonly<Record<string, JsonValue>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
