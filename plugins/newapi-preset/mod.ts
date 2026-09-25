import type {
    JsonValue,
    PluginManifest,
    PresetApplication,
    PresetPlugin,
} from "@heimdall/contracts";
import manifest from "./manifest.json" with { type: "json" };

export * from "./schema.ts";
export * from "./mapping.ts";
export * from "./redaction.ts";

import {
    NEW_API_SOURCE_PLUGIN_ID,
    type OpenAICompatibleSourceConfig,
} from "./schema.ts";
import { toOpenAICompatibleSourceConfig } from "./mapping.ts";
import { redactNewApiPresetApplication } from "./redaction.ts";

export const newApiPresetManifest = manifest as unknown as PluginManifest;

/** Pure NewAPI configuration factory. It never performs network or storage I/O. */
export const newApiPreset: PresetPlugin = {
    manifest: newApiPresetManifest,
    sourcePluginId: NEW_API_SOURCE_PLUGIN_ID,
    apply(input: unknown): PresetApplication {
        const config = toOpenAICompatibleSourceConfig(input);
        return {
            sourcePluginId: NEW_API_SOURCE_PLUGIN_ID,
            config: config as unknown as JsonValue,
        };
    },
    redact(application: PresetApplication): JsonValue {
        return redactNewApiPresetApplication(application);
    },
};

/** Default export for plugin loaders that import a module value directly. */
export default newApiPreset;

/** Public aliases retained for hosts that used the old entry-point names. */
export type { OpenAICompatibleSourceConfig };
export const SOURCE_PLUGIN_ID = NEW_API_SOURCE_PLUGIN_ID;
