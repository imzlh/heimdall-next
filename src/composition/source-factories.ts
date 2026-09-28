import type {
    InferenceSource,
    PluginManifest,
    SourcePluginFactory,
} from "@heimdall/contracts";
import { stableJson } from "@heimdall/hip";
import { type ConfigStore, StorageConflictError } from "@heimdall/storage";

/** New sources use the public factory contract; legacy exports remain supported. */
export function sourceFactoryFromModule(
    module: Record<string, unknown>,
): SourcePluginFactory | undefined {
    const plugin = module.sourcePlugin;
    if (
        record(plugin) && record(plugin.manifest) &&
        plugin.manifest.kind === "source" &&
        typeof plugin.create === "function" &&
        typeof plugin.validate === "function"
    ) {
        return plugin as unknown as SourcePluginFactory;
    }
    for (const name of ["OpenAICompatible", "Anthropic"]) {
        const create = module[`create${name}Source`];
        const validate = module[`validate${name}SourceConfig`];
        if (
            record(module.sourceManifest) && typeof create === "function" &&
            typeof validate === "function"
        ) {
            return {
                manifest: module.sourceManifest as unknown as PluginManifest,
                create: (config, options) =>
                    create(config, options) as InferenceSource,
                validate: (config) => validate(config),
            };
        }
    }
    return undefined;
}

/** Refreshes may update their original record only; operator edits always win. */
export function withSourcePersistence(
    factory: SourcePluginFactory,
    store: ConfigStore,
): SourcePluginFactory {
    const sources = store.namespace("heimdall", "source-config");
    return {
        ...factory,
        create(config, options) {
            return factory.create(config, {
                ...options,
                onConfigUpdate: options?.onConfigUpdate ??
                    (async (updated, previous) => {
                        if (
                            !record(previous) || typeof previous.id !== "string"
                        ) {
                            return;
                        }
                        const current = await sources.get<
                            Record<string, unknown>
                        >([
                            previous.id,
                        ]);
                        if (
                            !current ||
                            current.value.sourcePluginId !==
                                factory.manifest.id ||
                            stableJson(current.value.config) !==
                                stableJson(previous)
                        ) return;
                        const next = factory.validate(updated);
                        if (!record(next) || next.id !== previous.id) {
                            throw new TypeError(
                                "source refresh must preserve its identity",
                            );
                        }
                        try {
                            await sources.set([previous.id], {
                                ...current.value,
                                config: next,
                            }, {
                                expectedVersionstamp: current.versionstamp,
                            });
                        } catch (error) {
                            if (!(error instanceof StorageConflictError)) {
                                throw error;
                            }
                        }
                    }),
            });
        },
    };
}

export function redactSourceConfig(
    config: unknown,
    factory?: SourcePluginFactory,
): unknown {
    if (factory?.redact) return factory.redact(config);
    if (!record(config)) return {};
    const result: Record<string, unknown> = { ...config };
    for (const key of ["apiKey", "accessToken", "refreshToken"]) {
        if (typeof result[key] === "string") {
            result[`${key}Configured`] = result[key].length > 0;
            delete result[key];
        }
    }
    return result;
}

export function mergeSourceConfig(
    input: unknown,
    previous: unknown,
    factory: SourcePluginFactory,
): unknown {
    if (factory.mergeConfig) return factory.mergeConfig(input, previous);
    if (
        !record(input) || !record(previous) || previous.apiKey === undefined ||
        "apiKey" in input
    ) return input;
    return { ...input, apiKey: previous.apiKey };
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
