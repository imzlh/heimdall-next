import type { ToolConfigDto, UiJsonObject } from "@heimdall/admin-contracts";
import { parseSourceConfigSchema } from "@heimdall/admin-contracts/form-schema.ts";
import { isUiJsonObject } from "@heimdall/admin-contracts/ui.ts";
import type {
    JsonValue,
    PluginManifest,
    ToolPlugin,
    ToolPluginFactory,
} from "@heimdall/contracts";
import { type ConfigStore, StorageConflictError } from "@heimdall/storage";
import { createChatToolset } from "../chat/tools/toolset.ts";

interface StoredToolConfig {
    readonly config: JsonValue;
}

class ToolConfigurationError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

/** Durable settings are staged before publication; running turns retain their plugin snapshot. */
export class ToolConfigurations {
    readonly #store: ConfigStore;
    readonly #factories = new Map<string, ToolPluginFactory>();
    readonly #schemas = new Map<string, UiJsonObject>();
    readonly #reservations = new Map<string, ToolPlugin>();
    #saving: Promise<void> = Promise.resolve();

    constructor(
        store: ConfigStore,
        readonly env: (name: string) => string | undefined,
        readonly plugins: Map<string, ToolPlugin>,
        readonly errors: Map<string, string>,
        readonly validateManagedNames: (plugin: ToolPlugin) => void,
    ) {
        this.#store = store.namespace("heimdall", "tool-config");
    }

    canConfigure(id: string): boolean {
        return this.#factories.has(id);
    }

    /** Reserve both old and new names while persistence yields to managed lifecycle work. */
    registeredTools(): readonly ToolPlugin[] {
        const result = new Map(this.plugins);
        for (const [id, next] of this.#reservations) {
            const tools = new Map(
                result.get(id)?.tools.map((
                    tool,
                ) => [tool.definition.name, tool]),
            );
            for (const tool of next.tools) {
                tools.set(tool.definition.name, tool);
            }
            result.set(id, {
                manifest: next.manifest,
                tools: [...tools.values()],
            });
        }
        return [...result.values()];
    }

    async load(
        factory: ToolPluginFactory,
        manifest: PluginManifest,
    ): Promise<ToolPlugin> {
        let config: JsonValue | undefined;
        if (
            typeof factory.validateConfig === "function" &&
            manifest.configSchema !== undefined
        ) {
            if (!isUiJsonObject(manifest.configSchema)) {
                throw new TypeError("Invalid tool configuration schema");
            }
            const schema = parseSourceConfigSchema(manifest.configSchema);
            if (schema.id !== manifest.id) {
                throw new TypeError(
                    "Tool configuration schema must use its manifest's plugin id",
                );
            }
            // Retain the factory even when its durable configuration cannot load,
            // so the operator can repair it through the same versioned endpoint.
            this.#factories.set(manifest.id, factory);
            this.#schemas.set(manifest.id, schema as unknown as UiJsonObject);
            const stored = await this.#store.get<StoredToolConfig>([
                manifest.id,
            ]);
            if (stored !== null) {
                try {
                    config = await this.#validate(
                        factory,
                        stored.value?.config,
                    );
                } catch {
                    throw new Error(
                        "Stored tool configuration is invalid; save a replacement configuration to repair it",
                    );
                }
            }
        }
        try {
            const plugin = factory.create({
                env: this.env,
                ...(config === undefined
                    ? {}
                    : { config: structuredClone(config) }),
            });
            this.#validatePlugin(plugin, manifest);
            return plugin;
        } catch (error) {
            if (this.canConfigure(manifest.id)) {
                throw new Error(
                    "Tool configuration could not be activated; save a replacement configuration to repair it",
                );
            }
            throw error;
        }
    }

    async get(id: string): Promise<ToolConfigDto> {
        const factory = this.#factory(id);
        const stored = await this.#store.get<StoredToolConfig>([id]);
        let config: UiJsonObject = {};
        try {
            config = this.#redact(factory, stored?.value?.config ?? {});
        } catch {
            // Malformed or unredactable records stay repairable without exposing
            // their raw content. Their revision remains available for replacement.
        }
        return {
            pluginId: id,
            config,
            configSchema: structuredClone(this.#schemas.get(id)!),
            revision: stored?.versionstamp ?? null,
        };
    }

    save(
        id: string,
        input: unknown,
        revision: string | null,
    ): Promise<ToolConfigDto> {
        const copy = structuredClone(input);
        const pending = this.#saving.then(() => this.#save(id, copy, revision));
        this.#saving = pending.then(() => {}, () => {});
        return pending;
    }

    async #save(
        id: string,
        input: unknown,
        revision: string | null,
    ): Promise<ToolConfigDto> {
        const factory = this.#factory(id);
        if (
            revision !== null &&
            (typeof revision !== "string" || !revision.trim())
        ) {
            throw new TypeError(
                "An explicit tool configuration revision is required",
            );
        }
        const stored = await this.#store.get<StoredToolConfig>([id]);
        if ((stored?.versionstamp ?? null) !== revision) {
            throw new StorageConflictError(
                "Tool configuration changed; reload before saving",
            );
        }
        if (!isUiJsonObject(input)) {
            throw new TypeError(
                "Tool configuration must be a bounded JSON object",
            );
        }
        let merged: unknown = input;
        if (factory.mergeConfig) {
            try {
                merged = await factory.mergeConfig(
                    structuredClone(input),
                    isUiJsonObject(stored?.value?.config)
                        ? structuredClone(stored.value.config)
                        : undefined,
                );
            } catch (error) {
                throw new TypeError(
                    error instanceof Error
                        ? error.message
                        : "Invalid tool configuration",
                );
            }
        }
        const config = await this.#validate(factory, merged);
        let plugin: ToolPlugin;
        try {
            plugin = factory.create({
                env: this.env,
                config: structuredClone(config),
            });
            this.#validatePlugin(plugin, factory.manifest);
        } catch (error) {
            throw new TypeError(
                error instanceof Error
                    ? error.message
                    : "Tool configuration cannot be activated",
            );
        }
        const response = {
            pluginId: id,
            config: this.#redact(factory, config),
            configSchema: structuredClone(this.#schemas.get(id)!),
        };
        this.#reservations.set(id, plugin);
        try {
            const nextRevision = await this.#store.set([id], { config }, {
                expectedVersionstamp: revision,
            });
            this.plugins.set(id, plugin);
            this.errors.delete(id);
            return { ...response, revision: nextRevision };
        } finally {
            this.#reservations.delete(id);
        }
    }

    #factory(id: string): ToolPluginFactory {
        const factory = this.#factories.get(id);
        if (!factory) {
            throw new ToolConfigurationError(
                404,
                "tool_configuration_not_found",
                "Configurable tool plugin not found",
            );
        }
        return factory;
    }

    async #validate(
        factory: ToolPluginFactory,
        input: unknown,
    ): Promise<JsonValue> {
        if (!isUiJsonObject(input)) {
            throw new TypeError(
                "Tool configuration must be a bounded JSON object",
            );
        }
        let config: JsonValue;
        try {
            config = await factory.validateConfig!(structuredClone(input));
        } catch (error) {
            throw new TypeError(
                error instanceof Error
                    ? error.message
                    : "Invalid tool configuration",
            );
        }
        if (!isUiJsonObject(config)) {
            throw new TypeError(
                "Validated tool configuration must be a bounded JSON object",
            );
        }
        return structuredClone(config) as JsonValue;
    }

    #redact(factory: ToolPluginFactory, config: JsonValue): UiJsonObject {
        const projected = factory.redactConfig
            ? factory.redactConfig(structuredClone(config))
            : config;
        if (!isUiJsonObject(projected)) {
            throw new TypeError("Tool configuration cannot be displayed");
        }
        return structuredClone(projected);
    }

    #validatePlugin(plugin: ToolPlugin, manifest: PluginManifest): void {
        if (
            plugin.manifest.id !== manifest.id ||
            plugin.manifest.version !== manifest.version ||
            plugin.manifest.apiVersion !== manifest.apiVersion ||
            plugin.manifest.kind !== "tool"
        ) {
            throw new TypeError(
                "Tool factory returned a different plugin manifest",
            );
        }
        createChatToolset([
            ...[...this.plugins.values()].filter((item) =>
                item.manifest.id !== manifest.id
            ),
            plugin,
        ]);
        this.validateManagedNames(plugin);
    }
}
