import type {
    JsonValue,
    PluginManifest,
    PresetApplication,
    PresetPlugin,
} from "@heimdall/contracts";
import {
    type ChatHubSourceConfig,
    redactChatHubSourceConfig,
    validateChatHubSourceConfig,
} from "../chathub-source/config.ts";
import { CHATHUB_SOURCE_PLUGIN_ID } from "./identity.ts";
import manifest from "./manifest.json" with { type: "json" };

export * from "./identity.ts";

export const chatHubPresetManifest = manifest as unknown as PluginManifest;

const fields = new Set([
    "id",
    "oid",
    "tid",
    "accessToken",
    "refreshToken",
    "accountEmail",
    "expiresAt",
    "models",
    "endpoint",
    "licenseType",
    "scenario",
    "locale",
    "timezone",
    "softThinking",
]);

/** Validate only this preset's closed input shape; provider rules remain source-owned. */
export function validateChatHubPresetConfig(
    input: unknown,
): ChatHubSourceConfig {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("ChatHub preset config must be an object");
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("ChatHub preset config must be a plain object");
    }
    const config: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== "string" || !fields.has(key)) {
            throw new TypeError(
                "ChatHub preset config has an unsupported property",
            );
        }
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (!("value" in descriptor) || !descriptor.enumerable) {
            throw new TypeError(
                "ChatHub preset config must contain JSON values",
            );
        }
        const value = descriptor.value;
        if (key === "models" && Array.isArray(value)) {
            config.models = copyModels(value);
        } else if (typeof value === "string") {
            config[key] = value;
        } else {
            throw new TypeError("ChatHub preset " + key + " must be a string");
        }
    }
    // The host chooses the draft ID. Never fall back to the source's default ID.
    if (
        typeof config.id !== "string" || !config.id.trim() ||
        config.id.length > 256
    ) {
        throw new TypeError("ChatHub preset requires an explicit source id");
    }
    return validateChatHubSourceConfig(config);
}

function copyModels(models: unknown[]): string[] {
    if (
        Object.getPrototypeOf(models) !== Array.prototype ||
        models.length < 1 || models.length > 100 ||
        Reflect.ownKeys(models).length !== models.length + 1
    ) {
        throw new TypeError(
            "ChatHub preset models must be a JSON string array",
        );
    }
    const copy: string[] = [];
    for (let index = 0; index < models.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(models, index);
        if (
            !descriptor || !("value" in descriptor) || !descriptor.enumerable ||
            typeof descriptor.value !== "string"
        ) {
            throw new TypeError(
                "ChatHub preset models must be a JSON string array",
            );
        }
        copy.push(descriptor.value);
    }
    return copy;
}

export function redactChatHubPresetApplication(
    application: PresetApplication,
): JsonValue {
    if (application.sourcePluginId !== CHATHUB_SOURCE_PLUGIN_ID) {
        throw new TypeError(
            "ChatHub preset application has an invalid source plugin",
        );
    }
    return redactChatHubSourceConfig(
        validateChatHubPresetConfig(application.config),
    ) as JsonValue;
}

/** Authorization happens through the API plugin; applying a preset performs no I/O. */
export const chatHubPreset: PresetPlugin = {
    manifest: chatHubPresetManifest,
    sourcePluginId: CHATHUB_SOURCE_PLUGIN_ID,
    apply(input: unknown): PresetApplication {
        return {
            sourcePluginId: CHATHUB_SOURCE_PLUGIN_ID,
            config: validateChatHubPresetConfig(input) as unknown as JsonValue,
        };
    },
    redact: redactChatHubPresetApplication,
};

export default chatHubPreset;
