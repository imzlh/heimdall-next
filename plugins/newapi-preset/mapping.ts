import {
    DEFAULT_ENDPOINT,
    DEFAULT_SOURCE_ID,
    type NewApiPresetConfig,
    type OpenAICompatibleSourceConfig,
    validateNewApiPresetConfig,
} from "./schema.ts";

/**
 * Convert a NewAPI preset document into the source plugin's configuration
 * shape. The result is normalized, immutable by convention, and always has an
 * explicit source id and endpoint so hosts can persist it without applying
 * another set of defaults.
 */
export function toOpenAICompatibleSourceConfig(
    value: unknown,
): OpenAICompatibleSourceConfig {
    const normalized = validateNewApiPresetConfig(value);
    return {
        id: normalized.id ?? DEFAULT_SOURCE_ID,
        baseUrl: normalized.baseUrl,
        ...(normalized.apiKey === undefined
            ? {}
            : { apiKey: normalized.apiKey }),
        ...(normalized.modelMap === undefined
            ? {}
            : { modelMap: normalized.modelMap }),
        endpoint: normalized.endpoint ?? DEFAULT_ENDPOINT,
        ...(normalized.headers === undefined
            ? {}
            : { headers: normalized.headers }),
    };
}

/** Descriptive alias for hosts that treat presets as source factories. */
export const createOpenAICompatibleSourceConfig =
    toOpenAICompatibleSourceConfig;

/**
 * Resolve a client model through the preset's explicit mapping. An unmapped
 * model passes through unchanged, matching the OpenAI source contract.
 */
export function mapNewApiModel(
    config: Pick<NewApiPresetConfig, "modelMap">,
    clientModel: string | undefined,
): string {
    if (clientModel === undefined) return "";
    return config.modelMap?.[clientModel] ?? clientModel;
}

/** Compatibility alias used by source-oriented integrations. */
export const upstreamModel = mapNewApiModel;
