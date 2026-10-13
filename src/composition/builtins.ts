import type {
    ApiPlugin,
    InferenceSource,
    MiddlewarePlugin,
    PluginManifest,
    PresetPlugin,
    ProtocolPlugin,
    SourcePluginFactory,
    ToolPlugin,
    ToolPluginFactory,
} from "@heimdall/contracts";
import type {
    CreateSourceInput,
    PluginDto,
    PresetDto,
    SourceDto,
    UpdateSourceInput,
} from "@heimdall/admin-contracts";
import type { MaintenanceStatusView } from "@heimdall/admin-contracts/console.ts";
import {
    isUiJsonObject,
    type UiJsonObject,
} from "@heimdall/admin-contracts/ui.ts";
import type {
    ConfigStore,
    StorageKey,
    VersionedValue,
    WriteOptions,
} from "@heimdall/storage";
import { StorageConflictError } from "@heimdall/storage";
import type {
    AdminCatalogOptions,
    AdminManagementOptions,
    AdminRouteContext,
    AdminWriteResult,
    SourceConfigSnapshot,
} from "../http/admin-routes.ts";
import { type MiddlewareRegistry, SourceRegistry } from "@heimdall/kernel";
import {
    type PluginHost,
    PluginLifecycleError,
    validatePluginManifest,
} from "@heimdall/plugin-host";
import {
    createManagedPlugins,
    type ManagedPlugins,
} from "./managed-plugins.ts";
import { ToolConfigurations } from "./tool-configuration.ts";
import { probeSource } from "./probe-loop.ts";
import { probeSourceDraft } from "./source-draft-probe.ts";
import { createProxyPool } from "./proxy-pool.ts";
import { SourceProxyBindings } from "./source-proxy.ts";
import { BuiltinMiddlewarePlugins } from "./middleware-plugins.ts";
import { SourceHealthPersistence } from "./source-health-runtime.ts";
import { parseSourceHealthPolicy } from "@heimdall/contracts/source-health.ts";
import {
    applySourceSettings,
    type SourceConfigurationIssue,
    type StoredSourceConfig,
} from "./source-records.ts";
import {
    publicSourceModels,
    sourceModelSettings,
} from "./source-model-mapping.ts";
import { parseSourceModelMap } from "@heimdall/admin-contracts/source-model-map.ts";
import type { SourceMiddleware } from "@heimdall/admin-contracts/source-middleware.ts";
import {
    hydrateRuntimeSettings,
    redactRuntimeSettings,
    type RuntimeSettingsHandle,
    saveRuntimeSettings,
} from "./runtime-settings.ts";

import {
    mergeSourceConfig,
    redactSourceConfig,
    sourceFactoryFromModule,
    withSourcePersistence,
} from "./source-factories.ts";

type SourceFactory = SourcePluginFactory;

interface StoredPluginState {
    readonly enabled: boolean;
}

interface EnvBootstrapSpec {
    readonly manifestId: string;
    readonly baseUrlEnv: string;
    readonly apiKeyEnv: string;
    readonly sourceIdEnv: string;
    readonly defaultSourceId: string;
    readonly requireBaseUrl: boolean;
    readonly versionEnv?: string;
}

export interface BuiltinCompositionOptions {
    readonly configStore?: ConfigStore;
    readonly pluginRoot?: URL;
    readonly env?: (name: string) => string | undefined;
    /** Replace the default durable host when an embedding server supplies an isolated runtime. */
    readonly pluginHost?: PluginHost;
    /** Live gate settings. Stored values replace this handle during load. */
    readonly runtimeSettings?: RuntimeSettingsHandle;
    readonly maintenanceStatus?: () => MaintenanceStatusView | undefined;
}

/**
 * Optional built-in composition for the production entry point.
 *
 * `createServer()` remains a pure empty microkernel. This loader is only used
 * by the executable entry point and tolerates a missing `plugins/` directory,
 * which is useful for stripped-down deployments and tests.
 */
export interface BuiltinComposition {
    readonly apis: readonly ApiPlugin[];
    readonly protocols: readonly ProtocolPlugin[];
    /** Resolve enabled tool capabilities at the beginning of each chat turn. */
    readonly toolPlugins: () => readonly ToolPlugin[];
    readonly sources: SourceRegistry;
    /** Live enabled HIP middleware, selected through host source bindings. */
    readonly middleware: MiddlewareRegistry;
    readonly sourceMiddleware: () => ReadonlyMap<string, readonly string[]>;
    /** Live source-to-plugin ownership for UI slots, without source credentials. */
    readonly sourcePluginIds: () => Promise<Readonly<Record<string, string>>>;
    readonly catalog: AdminCatalogOptions;
    readonly management: AdminManagementOptions;
    /** Durable host for verified third-party plugin records. */
    readonly pluginHost: PluginHost;
    readonly close: () => Promise<void>;
}

export async function loadBuiltinComposition(
    options: BuiltinCompositionOptions = {},
): Promise<BuiltinComposition> {
    const env = options.env ?? ((name) => Deno.env.get(name));
    const store = options.configStore ?? new MemoryConfigStore();
    const proxyBindings = new SourceProxyBindings(await createProxyPool(store));
    await proxyBindings.restore(store);
    const root = options.pluginRoot ??
        new URL("../../plugins/", import.meta.url);
    const protocols: ProtocolPlugin[] = [];
    const apis: ApiPlugin[] = [];
    const sources = new SourceRegistry();
    const sourceFactories = new Map<string, SourceFactory>();
    const presets: PresetPlugin[] = [];
    const toolPlugins = new Map<string, ToolPlugin>();
    const middlewarePlugins = new BuiltinMiddlewarePlugins();
    const sourceErrors = new Map<string, SourceConfigurationIssue>();
    const manifests = new Map<string, PluginManifest>();
    const pluginErrors = new Map<string, string>();
    const pluginStates = new Map<string, boolean>();
    const toolConfigurations = new ToolConfigurations(
        store,
        env,
        toolPlugins,
        pluginErrors,
        (plugin) => managedPlugins?.assertToolsAvailable(plugin),
    );
    const managedPlugins: ManagedPlugins | undefined =
        options.pluginHost === undefined
            ? createManagedPlugins(
                store,
                () => toolConfigurations.registeredTools(),
                () => [...manifests.keys()],
                () =>
                    [...manifests.values()].map((manifest) => ({
                        manifest,
                        enabled: !pluginErrors.has(manifest.id) &&
                            pluginStates.get(manifest.id) !== false && (
                                protocols.some((plugin) =>
                                    plugin.manifest.id === manifest.id
                                ) ||
                                apis.some((plugin) =>
                                    plugin.manifest.id === manifest.id
                                ) ||
                                sourceFactories.has(manifest.id) ||
                                toolPlugins.has(manifest.id) ||
                                middlewarePlugins.registry.get(manifest.id) !==
                                    undefined ||
                                presets.some((plugin) =>
                                    plugin.manifest.id === manifest.id
                                )
                            ),
                    })),
            )
            : undefined;
    const pluginHost = options.pluginHost ?? managedPlugins!.host;

    if (await directoryExists(root)) {
        const entries = [...(await collectDirectories(root))].sort();
        for (const name of entries) {
            const directory = new URL(`${name}/`, root);
            const moduleUrl = new URL("mod.ts", directory);
            if (!await fileExists(moduleUrl)) continue;
            const manifestUrl = new URL("manifest.json", directory);
            if (!await fileExists(manifestUrl)) continue;
            const declaredManifest = await readManifest(directory, undefined);
            if (declaredManifest === undefined) continue;
            if (
                declaredManifest !== undefined &&
                declaredManifest.trust !== "trusted"
            ) {
                pluginErrors.set(
                    declaredManifest.id,
                    "untrusted plugins must be installed through PluginHost",
                );
                manifests.set(declaredManifest.id, declaredManifest);
                continue;
            }
            try {
                const module = await import(moduleUrl.href) as Record<
                    string,
                    unknown
                >;
                const manifest = declaredManifest ??
                    await readManifest(directory, module);
                if (manifest !== undefined) {
                    manifests.set(manifest.id, manifest);
                }
                const protocol = asProtocol(module.default);
                if (manifest?.kind === "middleware") {
                    const plugin = module.default as
                        | MiddlewarePlugin
                        | undefined;
                    if (!isRecord(plugin) || !isRecord(plugin.manifest)) {
                        throw new TypeError(
                            "middleware plugin must expose a default descriptor",
                        );
                    }
                    assertManifestMatches(plugin.manifest, manifest);
                    middlewarePlugins.add(plugin);
                }
                if (
                    manifest?.kind === "api" && isRecord(module.default) &&
                    typeof module.default.handle === "function"
                ) {
                    const api = module.default as unknown as ApiPlugin;
                    assertManifestMatches(api.manifest, manifest);
                    apis.push({
                        ...api,
                        handle: (context) =>
                            api.handle({
                                ...context,
                                resolveProxy: (selection) =>
                                    proxyBindings.pool.resolve(
                                        proxyBindings.pool.validateSelection(
                                            selection,
                                        ),
                                    ),
                            }),
                    });
                }
                if (protocol !== undefined) {
                    assertManifestMatches(protocol.manifest, manifest);
                    protocols.push(protocol);
                    manifests.set(protocol.manifest.id, protocol.manifest);
                }
                const preset = asPreset(module.default) ??
                    asPreset(module.newApiPreset);
                if (preset !== undefined) {
                    assertManifestMatches(preset.manifest, manifest);
                    presets.push(preset);
                    manifests.set(preset.manifest.id, preset.manifest);
                }
                const source = sourceFactoryFromModule(module);
                if (source !== undefined) {
                    assertManifestMatches(source.manifest, manifest);
                    sourceFactories.set(
                        source.manifest.id,
                        proxyBindings.wrap(
                            withSourcePersistence(source, store),
                        ),
                    );
                }
                if (manifest?.kind === "tool") {
                    const factory = asToolPluginFactory(module.toolPlugin);
                    if (factory === undefined) {
                        throw new TypeError(
                            "tool plugin must expose a toolPlugin factory",
                        );
                    }
                    assertManifestMatches(factory.manifest, manifest);
                    const plugin = await toolConfigurations.load(
                        factory,
                        manifest,
                    );
                    assertManifestMatches(plugin.manifest, manifest);
                    toolPlugins.set(manifest.id, plugin);
                }
            } catch (error) {
                const manifest = await readManifest(directory, undefined);
                if (manifest !== undefined) {
                    manifests.set(manifest.id, manifest);
                    pluginErrors.set(manifest.id, safeMessage(error));
                }
            }
        }
    }

    await restorePluginStates(store, pluginStates);
    middlewarePlugins.restore(pluginStates);
    await pluginHost.restore?.();
    await middlewarePlugins.restoreBindings(store);
    await restoreSources(
        store,
        sourceFactories,
        sources,
        env,
        pluginStates,
        middlewarePlugins,
        sourceErrors,
    );
    const healthPersistence = new SourceHealthPersistence(store, sources);
    await healthPersistence.restore();
    if (options.runtimeSettings !== undefined) {
        await hydrateRuntimeSettings(store, options.runtimeSettings);
    }
    const catalog = createCatalog(
        manifests,
        protocols,
        sourceFactories,
        presets,
        sources,
        pluginErrors,
        pluginStates,
        pluginHost,
        store,
        toolPlugins,
        toolConfigurations,
        middlewarePlugins,
        proxyBindings,
        sourceErrors,
    );
    const management = createManagement(
        store,
        sourceFactories,
        sources,
        presets,
        catalog,
        pluginStates,
        pluginHost,
        toolPlugins,
        middlewarePlugins,
        proxyBindings,
        sourceErrors,
        options.runtimeSettings,
        options.maintenanceStatus,
        healthPersistence,
    );
    return {
        protocols,
        apis,
        toolPlugins: () =>
            [...toolPlugins.values(), ...(managedPlugins?.tools() ?? [])]
                .filter((plugin) =>
                    pluginStates.get(plugin.manifest.id) !== false
                ),
        sources,
        middleware: middlewarePlugins.registry,
        sourceMiddleware: () =>
            middlewarePlugins.sourceSnapshot((id) =>
                sources.get(id) !== undefined
            ),
        sourcePluginIds: () => readSourcePluginIds(store, sourceFactories),
        catalog,
        management: {
            ...management,
            getToolConfig: (_context, id) => toolConfigurations.get(id),
            saveToolConfig: (_context, id, config, revision) =>
                toolConfigurations.save(id, config, revision),
            ...(managedPlugins === undefined ? {} : {
                installPlugin: (
                    _context: AdminRouteContext,
                    input: unknown,
                ) => managedPlugins!.install(input),
                upgradePlugin: (_context, id, input, revision) =>
                    managedPlugins!.upgrade(id, input, revision),
                rollbackPlugin: (_context, id, revision) =>
                    managedPlugins!.host.rollback!(id, revision),
            }),
        },
        pluginHost,
        close: async () => {
            try {
                await healthPersistence.close();
            } finally {
                await pluginHost.close?.();
            }
        },
    };
}

async function readSourcePluginIds(
    store: ConfigStore,
    sourceFactories: ReadonlyMap<string, SourceFactory>,
): Promise<Readonly<Record<string, string>>> {
    const ownership = new Map<string, string>();
    const sourceStore = store.namespace("heimdall", "source-config");
    for await (const entry of sourceStore.list<StoredSourceConfig>()) {
        if (entry.value.deleted) continue;
        const factory = sourceFactories.get(entry.value.sourcePluginId);
        if (factory === undefined) continue;
        try {
            // Use the factory's normalized id, including defaults and presets.
            const source = factory.create(entry.value.config);
            ownership.set(source.id, factory.manifest.id);
        } catch {
            // Match the catalog: invalid source records have no visible slot.
        }
    }
    return Object.fromEntries(ownership);
}

function createCatalog(
    manifests: Map<string, PluginManifest>,
    protocols: readonly ProtocolPlugin[],
    sourceFactories: Map<string, SourceFactory>,
    presets: readonly PresetPlugin[],
    sources: SourceRegistry,
    pluginErrors: Map<string, string>,
    pluginStates: Map<string, boolean>,
    pluginHost: PluginHost,
    store: ConfigStore,
    toolPlugins: ReadonlyMap<string, ToolPlugin>,
    toolConfigurations: ToolConfigurations,
    middlewarePlugins: BuiltinMiddlewarePlugins,
    proxyBindings: SourceProxyBindings,
    sourceErrors: Map<string, SourceConfigurationIssue>,
): AdminCatalogOptions {
    const sourceStore = store.namespace("heimdall", "source-config");
    return {
        plugins: async () => {
            const enabledProtocols = new Set(
                protocols.map((item) => item.manifest.id),
            );
            const builtin = [...manifests.values()].sort(byId).map((
                manifest,
            ): PluginDto => ({
                id: manifest.id,
                name: manifest.name,
                version: manifest.version,
                kind: manifest.kind,
                description: manifest.description,
                dependencies: manifest.dependencies,
                capabilities: manifest.capabilities,
                ...(toolConfigurations.canConfigure(manifest.id)
                    ? { canConfigure: true }
                    : {}),
                canToggle: sourceFactories.has(manifest.id) ||
                    toolPlugins.has(manifest.id) ||
                    middlewarePlugins.has(manifest.id),
                managed: false,
                enabled: manifest.kind === "protocol"
                    ? enabledProtocols.has(manifest.id)
                    : manifest.kind === "source"
                    ? sourceFactories.has(manifest.id) &&
                        pluginStates.get(manifest.id) !== false
                    : manifest.kind === "tool"
                    ? toolPlugins.has(manifest.id) &&
                        pluginStates.get(manifest.id) !== false
                    : manifest.kind === "middleware"
                    ? middlewarePlugins.registry.get(manifest.id) !== undefined
                    : true,
                trust: manifest.trust,
                ...(pluginErrors.has(manifest.id)
                    ? { lastError: pluginErrors.get(manifest.id) }
                    : {}),
            }));
            const records = await pluginHost.list();
            const result = new Map(
                builtin.map((plugin) => [plugin.id, plugin]),
            );
            for (const record of records) {
                if (result.has(record.manifest.id)) continue;
                result.set(record.manifest.id, {
                    id: record.manifest.id,
                    name: record.manifest.name,
                    version: record.manifest.version,
                    kind: record.manifest.kind,
                    description: record.manifest.description,
                    dependencies: record.manifest.dependencies,
                    capabilities: record.manifest.capabilities,
                    canToggle: true,
                    managed: true,
                    revision: record.revision,
                    rollbackVersion: record.rollback?.version,
                    enabled: record.enabled,
                    trust: record.manifest.trust,
                    ...(record.digest === undefined
                        ? {}
                        : { digest: record.digest }),
                    ...(record.lastError === undefined
                        ? {}
                        : { lastError: record.lastError }),
                });
            }
            return [...result.values()].sort((left, right) =>
                left.id.localeCompare(right.id)
            );
        },
        sources: async () => {
            const result = new Map<string, SourceDto>();
            const dto = (
                source: InferenceSource,
                enabled: boolean,
                record?: StoredSourceConfig,
                versionstamp?: string,
            ): SourceDto => {
                const active = sources.get(source.id);
                const issue = sourceErrors.get(source.id);
                const middlewareError = middlewarePlugins.sourceError(
                    source.id,
                );
                const configurationError = issue?.message ?? middlewareError;
                const configurationErrorField = issue?.field ??
                    (middlewareError === undefined ? undefined : "middleware");
                const ui = sourceUiSnapshot(active);
                const probe = active === undefined
                    ? undefined
                    : sources.probeOf(source.id);
                const declared = source.capabilities.flatMap((capability) => [
                    ...(capability.models ?? []),
                ]);
                const discovered = active === undefined
                    ? []
                    : sources.discoveredModels(source.id);
                const models = [...new Set([...declared, ...discovered])]
                    .filter((id) => id.trim().length > 0)
                    .sort();
                return {
                    id: source.id,
                    healthPolicy: sourceHealthPolicyView(record?.healthPolicy),
                    effectiveHealthPolicy: sources.healthPolicy(source.id),
                    proxy: record?.proxy ?? { mode: "inherit" },
                    proxySummary: proxyBindings.summary(record?.proxy),
                    ...(record === undefined ? {} : {
                        sourcePluginId: record.sourcePluginId,
                        instanceEnabled: record.enabled !== false,
                        pluginEnabled:
                            pluginStates.get(record.sourcePluginId) !== false,
                        versionstamp,
                        ...(record.name === undefined
                            ? {}
                            : { name: record.name }),
                        ...(record.priority === undefined
                            ? {}
                            : { priority: record.priority }),
                        modelMap: sourceModelMapView(record.modelMap),
                        ...(record.middleware === undefined ? {} : {
                            middleware: middlewarePlugins.sourceSelection(
                                source.id,
                            ),
                        }),
                    }),
                    enabled: enabled && configurationError === undefined,
                    ...(configurationError === undefined
                        ? {}
                        : { configurationError, configurationErrorField }),
                    models,
                    capabilities: [
                        ...new Set(
                            source.capabilities.map((capability) =>
                                capability.operation
                            ),
                        ),
                    ],
                    ...(active && sources.healthOf(source.id) === "cooldown"
                        ? sources.healthSnapshot(source.id)
                        : {}),
                    ...(probe === undefined ? {} : { probe }),
                    ...(ui === undefined ? {} : { ui }),
                };
            };
            for (const source of sources.list()) {
                result.set(
                    source.id,
                    dto(source, true),
                );
            }
            for await (const entry of sourceStore.list<StoredSourceConfig>()) {
                if (entry.value.deleted) continue;
                const sourceId = String(entry.key.at(-1) ?? "");
                const factory = sourceFactories.get(entry.value.sourcePluginId);
                if (sourceId.length === 0 || factory === undefined) continue;
                try {
                    const configured = sources.get(sourceId) ??
                        applySourceSettings(
                            factory.create(entry.value.config),
                            entry.value,
                        );
                    result.set(
                        sourceId,
                        dto(
                            configured,
                            entry.value.enabled !== false &&
                                pluginStates.get(entry.value.sourcePluginId) !==
                                    false,
                            entry.value,
                            entry.versionstamp,
                        ),
                    );
                } catch {
                    // Quarantined records remain manageable even when their
                    // provider cannot be constructed for capability discovery.
                    if (!sourceErrors.has(sourceId)) {
                        let field: SourceConfigurationIssue["field"] = "config";
                        try {
                            sourceModelSettings(
                                entry.value.config,
                                entry.value.modelMap,
                            );
                        } catch {
                            field = "modelMap";
                        }
                        sourceErrors.set(
                            sourceId,
                            sourceConfigurationIssue(field),
                        );
                    }
                    result.set(
                        sourceId,
                        dto(
                            {
                                id: sourceId,
                                capabilities: [],
                                execute() {
                                    throw new Error(
                                        "quarantined source cannot execute",
                                    );
                                },
                            },
                            false,
                            entry.value,
                            entry.versionstamp,
                        ),
                    );
                }
            }
            return [...result.values()].sort((left, right) =>
                left.id.localeCompare(right.id)
            );
        },
        presets: () =>
            presets.map((preset): PresetDto => ({
                id: preset.manifest.id,
                name: preset.manifest.name,
                version: preset.manifest.version,
                sourcePluginId: preset.sourcePluginId,
                description: preset.manifest.capabilities?.join(", "),
            })),
    };
}

function sourceConfigurationIssue(
    field: SourceConfigurationIssue["field"],
): SourceConfigurationIssue {
    return {
        field,
        message: field === "healthPolicy"
            ? "渠道健康策略配置损坏，已停止路由；请在基础配置中修复冷却时间。"
            : field === "modelMap"
            ? "渠道模型映射配置损坏，已停止路由；请在基础配置中修复模型映射。"
            : "渠道源参数无效，已停止路由；请在渠道配置中修复源参数。",
    };
}

function sourceModelMapView(value: unknown) {
    try {
        return parseSourceModelMap(value);
    } catch {
        return {};
    }
}

function sourceHealthPolicyView(value: unknown) {
    try {
        return parseSourceHealthPolicy(value);
    } catch {
        return null;
    }
}

function sourceUiSnapshot(
    source: InferenceSource | undefined,
): UiJsonObject | undefined {
    try {
        const snapshot = source?.uiSnapshot?.();
        if (!isUiJsonObject(snapshot)) return undefined;
        // Detach plugin-owned objects and validate the actual serialized result.
        const copy: unknown = JSON.parse(JSON.stringify(snapshot));
        return isUiJsonObject(copy) ? copy : undefined;
    } catch {
        // Optional plugin UI state must not make the source catalog unavailable.
        return undefined;
    }
}

function createManagement(
    store: ConfigStore,
    sourceFactories: Map<string, SourceFactory>,
    sources: SourceRegistry,
    presets: readonly PresetPlugin[],
    catalog: AdminCatalogOptions,
    pluginStates: Map<string, boolean>,
    pluginHost: PluginHost,
    toolPlugins: ReadonlyMap<string, ToolPlugin>,
    middlewarePlugins: BuiltinMiddlewarePlugins,
    proxyBindings: SourceProxyBindings,
    sourceErrors: Map<string, SourceConfigurationIssue>,
    runtimeSettings?: RuntimeSettingsHandle,
    maintenanceStatus?: () => MaintenanceStatusView | undefined,
    healthPersistence?: SourceHealthPersistence,
): AdminManagementOptions {
    const sourceStore = store.namespace("heimdall", "source-config");
    const pluginStateStore = store.namespace("heimdall", "plugin-state");
    const findFactory = (sourceId: string): SourceFactory => {
        const factory = [...sourceFactories.values()].find((item) =>
            item.manifest.id === sourceId || item.manifest.id.endsWith(sourceId)
        );
        if (factory === undefined) {
            throw new ManagementError(
                404,
                "source_not_found",
                `source not found: ${sourceId}`,
            );
        }
        return factory;
    };
    const getRecord = async (sourceId: string) =>
        await sourceStore.get<StoredSourceConfig>([sourceId]);
    const healthSelection = (value: unknown) => {
        try {
            return parseSourceHealthPolicy(value);
        } catch {
            throw new ManagementError(
                400,
                "invalid_source_health_policy",
                "冷却时间必须为 0 至 86400000 毫秒的整数。",
            );
        }
    };

    const middlewareSelection = (value: unknown): SourceMiddleware => {
        try {
            return middlewarePlugins.validateSelection(value);
        } catch (error) {
            throw new ManagementError(
                400,
                "invalid_source_middleware",
                error instanceof Error ? error.message : "渠道中间件无效。",
            );
        }
    };

    const requireRecord = async (sourceId: string) => {
        const record = await getRecord(sourceId);
        if (record === null || record.value.deleted) {
            throw new ManagementError(
                404,
                "source_not_found",
                "channel not found",
            );
        }
        return record;
    };

    // Registry updates follow durable writes in the same order, including
    // plugin switches affecting several instances. Failed writes release the queue.
    let sourceWrites: Promise<unknown> = Promise.resolve();
    const sourceWrite = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = sourceWrites.then(operation);
        sourceWrites = result.catch(() => undefined);
        return result;
    };

    const saveForFactory = async (
        factory: SourceFactory,
        _context: AdminRouteContext,
        sourceId: string,
        input: unknown,
        expectedVersionstamp?: string,
    ): Promise<AdminWriteResult> => {
        const current = await getRecord(sourceId);
        if (current?.value.deleted) {
            throw new ManagementError(
                404,
                "source_not_found",
                "channel was deleted; create a new channel",
            );
        }
        if (sourceErrors.get(sourceId)?.field === "modelMap") {
            throw new ManagementError(
                409,
                "source_model_map_invalid",
                "请先在基础配置中修复模型映射，再修改源参数。",
            );
        }
        if (sourceErrors.get(sourceId)?.field === "healthPolicy") {
            throw new ManagementError(
                409,
                "source_health_policy_invalid",
                "请先在基础配置中修复健康策略，再修改源参数。",
            );
        }
        const settings = sourceModelSettings(input, current?.value.modelMap);
        const merged = mergeSourceConfig(
            settings.config,
            current?.value.config,
            factory,
        );
        const config = factory.validate(withSourceId(merged, sourceId));
        const value: StoredSourceConfig = {
            ...(current?.value.name === undefined
                ? {}
                : { name: current.value.name }),
            ...(current?.value.priority === undefined
                ? {}
                : { priority: current.value.priority }),
            ...(current?.value.proxy === undefined
                ? {}
                : { proxy: current.value.proxy }),
            ...(current?.value.middleware === undefined
                ? {}
                : { middleware: current.value.middleware }),
            ...(current?.value.healthPolicy === undefined
                ? {}
                : { healthPolicy: current.value.healthPolicy }),
            sourcePluginId: factory.manifest.id,
            config,
            enabled: current?.value.enabled !== false,
            instanceStateVersion: 1,
            modelMap: settings.modelMap,
        };
        const source = applySourceSettings(
            factory.create(config),
            value,
        );
        const versionstamp = await sourceStore.set(
            [sourceId],
            value,
            {
                expectedVersionstamp: expectedVersionstamp ??
                    current?.versionstamp ?? null,
            },
        );
        proxyBindings.set(sourceId, value.proxy);
        middlewarePlugins.setSource(sourceId, value.middleware);
        sources.setHealthPolicy(sourceId, value.healthPolicy);
        await healthPersistence?.bind(sourceId, value);
        sourceErrors.delete(sourceId);
        if (
            value.enabled !== false &&
            middlewarePlugins.sourceError(sourceId) === undefined &&
            pluginStates.get(factory.manifest.id) !== false
        ) {
            sources.upsert(source);
        } else sources.unregister(sourceId);
        return {
            data: {
                source: {
                    sourceId,
                    configured: true,
                    config: redactSourceConfig(config, factory),
                    versionstamp,
                },
            },
            versionstamp,
        };
    };

    const saveSourceConfig = async (
        context: AdminRouteContext,
        sourceId: string,
        input: unknown,
        expectedVersionstamp?: string,
    ): Promise<AdminWriteResult> => {
        const current = await getRecord(sourceId);
        const factory = current === null
            ? findFactory(sourceId)
            : sourceFactories.get(current.value.sourcePluginId) ??
                findFactory(sourceId);
        return await saveForFactory(
            factory,
            context,
            sourceId,
            input,
            expectedVersionstamp,
        );
    };

    return {
        getProxies: () => {
            const snapshot = proxyBindings.pool.view();
            return {
                data: { pool: snapshot.pool },
                versionstamp: snapshot.versionstamp,
            };
        },
        saveProxies: (_context, input, expectedVersionstamp) =>
            sourceWrite(async () => {
                const saved = await proxyBindings.pool.save(
                    input,
                    expectedVersionstamp,
                );
                return {
                    data: { pool: saved.pool },
                    versionstamp: saved.versionstamp,
                };
            }),
        createSource: (context, input: CreateSourceInput) =>
            sourceWrite(async () => {
                if (
                    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
                        .test(input.id) ||
                    typeof input.name !== "string" || !input.name.trim() ||
                    input.name.trim().length > 120 ||
                    !Number.isSafeInteger(input.priority)
                ) {
                    throw new ManagementError(
                        400,
                        "invalid_source",
                        "invalid channel identity, name or priority",
                    );
                }
                if (
                    await getRecord(input.id) !== null ||
                    sources.get(input.id) !== undefined
                ) {
                    throw new ManagementError(
                        409,
                        "source_exists",
                        "this channel draft has already been saved",
                    );
                }
                const factory = sourceFactories.get(input.sourcePluginId);
                if (!factory) {
                    throw new ManagementError(
                        404,
                        "source_not_found",
                        "source plugin is not available",
                    );
                }
                const submitted = sourceModelSettings(
                    input.config,
                    input.modelMap,
                );
                const middleware = middlewareSelection(input.middleware);
                const healthPolicy = healthSelection(input.healthPolicy);
                let raw = submitted.config;
                if (input.presetId !== undefined) {
                    const preset = presets.find((item) =>
                        item.manifest.id === input.presetId
                    );
                    if (!preset) {
                        throw new ManagementError(
                            404,
                            "preset_not_found",
                            "preset is not available",
                        );
                    }
                    if (preset.sourcePluginId !== input.sourcePluginId) {
                        throw new ManagementError(
                            400,
                            "preset_source_mismatch",
                            "preset does not belong to this source plugin",
                        );
                    }
                    const application = preset.apply(submitted.config);
                    if (application.sourcePluginId !== input.sourcePluginId) {
                        throw new ManagementError(
                            400,
                            "preset_source_mismatch",
                            "preset returned a different source plugin",
                        );
                    }
                    raw = application.config;
                }
                const settings = sourceModelSettings(raw, submitted.modelMap);
                const config = factory.validate(
                    withSourceId(settings.config, input.id),
                );
                const value: StoredSourceConfig = {
                    sourcePluginId: factory.manifest.id,
                    name: input.name.trim(),
                    priority: input.priority,
                    proxy: proxyBindings.pool.validateSelection(input.proxy),
                    config,
                    enabled: true,
                    instanceStateVersion: 1,
                    modelMap: settings.modelMap,
                    middleware,
                    healthPolicy,
                };
                const source = applySourceSettings(
                    factory.create(config),
                    value,
                );
                if (source.id !== input.id) {
                    throw new ManagementError(
                        400,
                        "source_identity_mismatch",
                        "source plugin did not preserve the channel identity",
                    );
                }
                let versionstamp: string;
                try {
                    versionstamp = await sourceStore.set([input.id], value, {
                        expectedVersionstamp: null,
                    });
                } catch (error) {
                    if (error instanceof StorageConflictError) {
                        throw new ManagementError(
                            409,
                            "source_exists",
                            "this channel draft has already been saved",
                        );
                    }
                    throw error;
                }
                proxyBindings.set(input.id, value.proxy);
                middlewarePlugins.setSource(input.id, value.middleware);
                sources.setHealthPolicy(input.id, value.healthPolicy);
                await healthPersistence?.bind(input.id, value);
                if (pluginStates.get(factory.manifest.id) !== false) {
                    sources.register(source);
                }
                const listed = await resolveProvider(catalog.sources, context);
                return {
                    data: {
                        source: listed.find((item) => item.id === input.id),
                    },
                    versionstamp,
                };
            }),
        updateSource: (
            context,
            sourceId,
            input: UpdateSourceInput,
            expectedVersionstamp,
        ) => sourceWrite(async () => {
            if (
                !input || Object.keys(input).length === 0 ||
                Object.keys(input).some((key) =>
                    ![
                        "name",
                        "priority",
                        "enabled",
                        "proxy",
                        "modelMap",
                        "middleware",
                        "healthPolicy",
                    ]
                        .includes(key)
                ) ||
                (Object.hasOwn(input, "name") &&
                    (typeof input.name !== "string" || !input.name.trim() ||
                        input.name.trim().length > 120)) ||
                (Object.hasOwn(input, "priority") &&
                    !Number.isSafeInteger(input.priority)) ||
                (Object.hasOwn(input, "enabled") &&
                    typeof input.enabled !== "boolean")
            ) {
                throw new ManagementError(
                    400,
                    "invalid_source",
                    "invalid channel settings",
                );
            }
            const current = await requireRecord(sourceId);
            let value: StoredSourceConfig = {
                ...current.value,
                instanceStateVersion: 1,
                ...(input.name === undefined
                    ? {}
                    : { name: input.name.trim() }),
                ...(input.priority === undefined
                    ? {}
                    : { priority: input.priority }),
                ...(input.enabled === undefined
                    ? {}
                    : { enabled: input.enabled }),
                ...(input.proxy === undefined ? {} : {
                    proxy: proxyBindings.pool.validateSelection(input.proxy),
                }),
                ...(Object.hasOwn(input, "modelMap")
                    ? {
                        modelMap: parseSourceModelMap(input.modelMap),
                    }
                    : {}),
                ...(Object.hasOwn(input, "middleware")
                    ? {
                        middleware: middlewareSelection(input.middleware),
                    }
                    : {}),
                ...(Object.hasOwn(input, "healthPolicy")
                    ? { healthPolicy: healthSelection(input.healthPolicy) }
                    : {}),
            };
            const factory = sourceFactories.get(value.sourcePluginId);
            if (factory === undefined) {
                throw new ManagementError(
                    409,
                    "source_plugin_unavailable",
                    "source plugin is unavailable",
                );
            }
            let nextIssue = sourceErrors.get(sourceId);
            const repairsModelMap = Object.hasOwn(input, "modelMap");
            if (repairsModelMap) {
                // Only an explicit host mapping edit may replace a damaged
                // mapping, including the legacy provider-config location.
                const settings = sourceModelSettings(
                    value.config,
                    value.modelMap,
                );
                value = {
                    ...value,
                    config: settings.config,
                    modelMap: settings.modelMap,
                };
                nextIssue = undefined;
                try {
                    factory.validate(value.config);
                } catch {
                    nextIssue = sourceConfigurationIssue("config");
                }
            }
            // Repairing one field must not accidentally lift another quarantine.
            nextIssue = undefined;
            try {
                parseSourceHealthPolicy(value.healthPolicy);
            } catch {
                nextIssue = sourceConfigurationIssue("healthPolicy");
            }
            try {
                sourceModelSettings(value.config, value.modelMap);
            } catch {
                nextIssue ??= sourceConfigurationIssue("modelMap");
            }
            try {
                factory.validate(value.config);
            } catch {
                nextIssue ??= sourceConfigurationIssue("config");
            }
            const active = sources.get(sourceId);
            const eligible = value.enabled !== false &&
                nextIssue === undefined &&
                (Object.hasOwn(input, "middleware") ||
                    middlewarePlugins.sourceError(sourceId) === undefined) &&
                pluginStates.get(value.sourcePluginId) !== false;
            // Metadata edits keep the running provider instance and any live
            // contexts. Only a newly enabled instance needs a fresh factory.
            const source = !eligible
                ? undefined
                : active === undefined
                ? applySourceSettings(
                    factory.create(value.config),
                    value,
                )
                : value.priority !== current.value.priority ||
                        Object.hasOwn(input, "modelMap")
                ? applySourceSettings(active, value)
                : active;
            const versionstamp = await sourceStore.set([sourceId], value, {
                expectedVersionstamp: expectedVersionstamp ??
                    current.versionstamp,
            });
            proxyBindings.set(sourceId, value.proxy);
            middlewarePlugins.setSource(sourceId, value.middleware);
            if (nextIssue?.field !== "healthPolicy") {
                sources.setHealthPolicy(sourceId, value.healthPolicy);
            }
            await healthPersistence?.bind(sourceId, value);
            if (nextIssue === undefined) sourceErrors.delete(sourceId);
            else sourceErrors.set(sourceId, nextIssue);
            if (source === undefined) sources.unregister(sourceId);
            else if (source !== active) {
                sources.upsert(source, {
                    preserveDiscovery: true,
                    ...(active && Object.hasOwn(input, "modelMap")
                        ? {
                            discoveredModels: publicSourceModels(
                                sources.discoveredModels(sourceId).map((
                                    model,
                                ) => Object.hasOwn(
                                        current.value.modelMap ?? {},
                                        model,
                                    )
                                    ? current.value.modelMap![model]!
                                    : model
                                ),
                                value.modelMap ?? {},
                            ),
                        }
                        : {}),
                });
            }
            const listed = await resolveProvider(catalog.sources, context);
            return {
                data: { source: listed.find((item) => item.id === sourceId) },
                versionstamp,
            };
        }),
        deleteSource: (_context, sourceId, expectedVersionstamp) =>
            sourceWrite(async () => {
                const current = await requireRecord(sourceId);
                // Scrub the entire config in one CAS write. The remaining marker
                // prevents an environment-defined channel from reappearing on restart.
                const versionstamp = await sourceStore.set<StoredSourceConfig>([
                    sourceId,
                ], {
                    sourcePluginId: current.value.sourcePluginId,
                    config: null,
                    enabled: false,
                    deleted: true,
                    instanceStateVersion: 1,
                }, {
                    expectedVersionstamp: expectedVersionstamp ??
                        current.versionstamp,
                });
                sources.unregister(sourceId);
                sources.setHealthPolicy(sourceId, null);
                await healthPersistence?.flush(sourceId);
                proxyBindings.delete(sourceId);
                middlewarePlugins.setSource(sourceId, null);
                sourceErrors.delete(sourceId);
                return { data: { sourceId, deleted: true }, versionstamp };
            }),
        getSourceConfig: async (
            _context,
            sourceId,
        ): Promise<SourceConfigSnapshot | null> => {
            const record = await getRecord(sourceId);
            if (record?.value.deleted) return null;
            if (record === null) {
                findFactory(sourceId);
                return { sourceId, configured: false };
            }
            const factory = sourceFactories.get(record.value.sourcePluginId) ??
                findFactory(sourceId);
            return {
                sourceId,
                configured: true,
                config: redactSourceConfig(record.value.config, factory),
                versionstamp: record.versionstamp,
            };
        },
        validateSourceConfig: async (_context, sourceId, input) => {
            const record = await getRecord(sourceId);
            if (record?.value.deleted) {
                throw new ManagementError(
                    404,
                    "source_not_found",
                    "channel not found",
                );
            }
            const factory = record === null
                ? findFactory(sourceId)
                : sourceFactories.get(record.value.sourcePluginId) ??
                    findFactory(sourceId);
            const settings = sourceModelSettings(input, record?.value.modelMap);
            return redactSourceConfig(
                factory.validate(
                    withSourceId(
                        mergeSourceConfig(
                            settings.config,
                            record?.value.config,
                            factory,
                        ),
                        sourceId,
                    ),
                ),
                factory,
            );
        },
        saveSourceConfig: (...args) =>
            sourceWrite(() => saveSourceConfig(...args)),
        previewPreset: (_context, presetId, input) => {
            const preset = presets.find((item) =>
                item.manifest.id === presetId
            );
            if (preset === undefined) {
                throw new ManagementError(
                    404,
                    "preset_not_found",
                    `preset not found: ${presetId}`,
                );
            }
            const application = preset.apply(input);
            return preset.redact?.(application) ??
                redactSourceConfig(
                    application.config,
                    sourceFactories.get(application.sourcePluginId),
                );
        },
        applyPreset: (
            context,
            presetId,
            input,
            expectedVersionstamp,
        ) => sourceWrite(async () => {
            const preset = presets.find((item) =>
                item.manifest.id === presetId
            );
            if (preset === undefined) {
                throw new ManagementError(
                    404,
                    "preset_not_found",
                    `preset not found: ${presetId}`,
                );
            }
            const application = preset.apply(input);
            const sourceId = isRecord(application.config) &&
                    typeof application.config.id === "string"
                ? application.config.id
                : "newapi";
            const factory = sourceFactories.get(preset.sourcePluginId);
            if (factory === undefined) {
                throw new ManagementError(
                    404,
                    "source_not_found",
                    `source plugin not found: ${preset.sourcePluginId}`,
                );
            }
            return await saveForFactory(
                factory,
                context,
                sourceId,
                application.config,
                expectedVersionstamp,
            );
        }),
        setPluginEnabled: (context, pluginId, enabled) =>
            sourceWrite(async () => {
                const pluginCatalog = await resolveProvider(
                    catalog.plugins,
                    context,
                );
                if (!enabled) {
                    const dependents = pluginCatalog?.filter((plugin) =>
                        plugin.enabled &&
                        plugin.dependencies?.includes(pluginId)
                    ) ?? [];
                    if (dependents.length) {
                        throw new ManagementError(
                            409,
                            "plugin_dependency_in_use",
                            `请先停用依赖插件：${
                                dependents.map((plugin) =>
                                    plugin.name
                                ).join(
                                    "、",
                                )
                            }`,
                        );
                    }
                } else {
                    const plugin = pluginCatalog?.find((plugin) =>
                        plugin.id === pluginId
                    );
                    const missing = plugin?.dependencies?.filter((id) =>
                        !pluginCatalog?.some((candidate) =>
                            candidate.id === id && candidate.enabled
                        )
                    ) ?? [];
                    if (missing.length) {
                        throw new ManagementError(
                            409,
                            "plugin_dependency_unavailable",
                            `请先启用依赖插件：${missing.join("、")}`,
                        );
                    }
                }
                const installed = await pluginHost.get(pluginId);
                if (installed !== undefined) {
                    try {
                        return enabled
                            ? await pluginHost.enable(pluginId)
                            : await pluginHost.disable(pluginId);
                    } catch (error) {
                        throw pluginManagementError(error, pluginId);
                    }
                }
                if (toolPlugins.has(pluginId)) {
                    await pluginStateStore.set([pluginId], { enabled });
                    pluginStates.set(pluginId, enabled);
                    return await resolveProvider(catalog.plugins, context);
                }
                if (middlewarePlugins.has(pluginId)) {
                    await pluginStateStore.set([pluginId], { enabled });
                    pluginStates.set(pluginId, enabled);
                    middlewarePlugins.setEnabled(pluginId, enabled);
                    return await resolveProvider(catalog.plugins, context);
                }
                const source = [...sourceFactories.values()].find((item) =>
                    item.manifest.id === pluginId
                );
                if (source !== undefined) {
                    await pluginStateStore.set([pluginId], { enabled });
                    pluginStates.set(pluginId, enabled);
                    for await (
                        const entry of sourceStore.list<StoredSourceConfig>()
                    ) {
                        if (entry.value.sourcePluginId !== pluginId) continue;
                        if (entry.value.deleted) continue;
                        const sourceId = String(entry.key.at(-1) ?? "");
                        if (
                            !enabled || entry.value.enabled === false ||
                            middlewarePlugins.sourceError(sourceId) !==
                                undefined ||
                            sourceErrors.has(sourceId)
                        ) {
                            sources.unregister(sourceId);
                        } else {sources.upsert(
                                applySourceSettings(
                                    source.create(entry.value.config),
                                    entry.value,
                                ),
                            );}
                    }
                    return await resolveProvider(catalog.plugins, context);
                }
                throw new ManagementError(
                    409,
                    "plugin_immutable",
                    "built-in protocol and preset plugins are immutable",
                );
            }),
        uninstallPlugin: (_context, pluginId) =>
            sourceWrite(async () => {
                if (await pluginHost.get(pluginId) !== undefined) {
                    try {
                        return await pluginHost.uninstall(pluginId);
                    } catch (error) {
                        throw pluginManagementError(error, pluginId);
                    }
                }
                throw new ManagementError(
                    409,
                    "plugin_immutable",
                    "built-in plugins cannot be uninstalled",
                );
            }),
        probeSourceDraft: (context, input) =>
            probeSourceDraft(input, context.request.signal, {
                factories: sourceFactories,
                presets,
                enabled: (id) => pluginStates.get(id) !== false,
                proxies: proxyBindings.pool,
            }),
        clearSourceCooldown: (_context, sourceId) =>
            sourceWrite(async () => {
                if (!sources.get(sourceId)) {
                    throw new ManagementError(
                        404,
                        "source_not_found",
                        "source is missing or disabled",
                    );
                }
                const cleared = sources.healthOf(sourceId) === "cooldown";
                const result = {
                    sourceId,
                    cleared,
                    ...sources.clearCooldown(sourceId),
                };
                await healthPersistence?.flush(sourceId);
                return result;
            }),
        probeSource: async (context, sourceId) => {
            const source = sources.get(sourceId);
            if (source === undefined || source.probe === undefined) {
                throw new ManagementError(
                    404,
                    "source_not_found",
                    `source not found: ${sourceId}`,
                );
            }
            const result = await probeSource(sources, sourceId, {
                signal: context.request.signal,
            });
            if (!result) {
                throw new ManagementError(
                    409,
                    "source_changed",
                    "source changed during probe; refresh and retry",
                );
            }
            return {
                sourceId,
                ok: result.ok,
                message: result.message,
                health: sources.healthOf(sourceId),
            };
        },
        ...(runtimeSettings === undefined ? {} : {
            getSettings: () => ({
                data: {
                    settings: redactRuntimeSettings(runtimeSettings.get()),
                    ...(maintenanceStatus?.()
                        ? { maintenance: maintenanceStatus() }
                        : {}),
                },
                versionstamp: runtimeSettings.versionstamp(),
            }),
            saveSettings: (_context, patch, expectedVersionstamp) =>
                saveRuntimeSettings(
                    store,
                    runtimeSettings,
                    patch,
                    expectedVersionstamp,
                ).then((saved) => ({
                    data: {
                        settings: saved.settings,
                        ...(maintenanceStatus?.()
                            ? { maintenance: maintenanceStatus() }
                            : {}),
                    },
                    versionstamp: saved.versionstamp,
                })),
        }),
    };
}

async function restoreSources(
    store: ConfigStore,
    factories: Map<string, SourceFactory>,
    sources: SourceRegistry,
    env: (name: string) => string | undefined,
    pluginStates: Map<string, boolean>,
    middlewarePlugins: BuiltinMiddlewarePlugins,
    sourceErrors: Map<string, SourceConfigurationIssue>,
): Promise<void> {
    const sourceStore = store.namespace("heimdall", "source-config");
    for await (const entry of sourceStore.list<StoredSourceConfig>()) {
        if (entry.value.deleted) continue;
        const sourceId = String(entry.key.at(-1) ?? "");
        const factory = factories.get(entry.value.sourcePluginId);
        if (factory === undefined) continue;
        let value: StoredSourceConfig = entry.value.instanceStateVersion === 1
            ? entry.value
            : {
                ...entry.value,
                // Old plugin switches wrote enabled=false to every child.
                // Only migrate that legacy combination; explicit v1 instance
                // switches and legacy disabled children of enabled plugins stay off.
                enabled: entry.value.enabled !== false ||
                    pluginStates.get(entry.value.sourcePluginId) === false,
                instanceStateVersion: 1,
            };
        let field: SourceConfigurationIssue["field"] = "healthPolicy";
        try {
            sources.setHealthPolicy(sourceId, value.healthPolicy);
            field = "modelMap";
            const settings = sourceModelSettings(value.config, value.modelMap);
            if (
                isRecord(value.config) &&
                Object.hasOwn(value.config, "modelMap")
            ) {
                value = {
                    ...value,
                    config: settings.config,
                    modelMap: settings.modelMap,
                };
            }
            field = "config";
            // Validate disabled records without starting a provider. They stay
            // visible and cannot crash startup when an operator later enables them.
            factory.validate(value.config);
            if (value !== entry.value) {
                await sourceStore.set([sourceId], value, {
                    expectedVersionstamp: entry.versionstamp,
                });
            }
            if (
                value.enabled === false ||
                pluginStates.get(value.sourcePluginId) === false ||
                middlewarePlugins.sourceError(sourceId) !== undefined
            ) continue;
            sources.upsert(
                applySourceSettings(
                    factory.create(value.config),
                    value,
                ),
            );
            pluginStates.set(
                entry.value.sourcePluginId,
                pluginStates.get(entry.value.sourcePluginId) ?? true,
            );
        } catch {
            sources.unregister(sourceId);
            sourceErrors.set(sourceId, sourceConfigurationIssue(field));
        }
    }
    if (sources.list().length > 0) return;
    const bootstrap = async (spec: EnvBootstrapSpec): Promise<void> => {
        const factory = [...factories.values()].find((item) =>
            item.manifest.id === spec.manifestId
        );
        if (factory === undefined) return;
        if (pluginStates.get(factory.manifest.id) === false) return;
        const baseUrl = env(spec.baseUrlEnv)?.trim() || undefined;
        const apiKey = env(spec.apiKeyEnv)?.trim() || undefined;
        if (spec.requireBaseUrl && baseUrl === undefined) return;
        if (
            !spec.requireBaseUrl && baseUrl === undefined &&
            apiKey === undefined
        ) return;
        const sourceId = env(spec.sourceIdEnv)?.trim() || spec.defaultSourceId;
        // Stored instances, including disabled ones, always own their identity
        // and metadata; environment bootstrap must never overwrite them.
        if (await sourceStore.get([sourceId]) !== null) return;
        const version = spec.versionEnv === undefined
            ? undefined
            : env(spec.versionEnv)?.trim() || undefined;
        const config = factory.validate({
            id: sourceId,
            ...(baseUrl === undefined ? {} : { baseUrl }),
            ...(apiKey === undefined ? {} : { apiKey }),
            ...(version === undefined ? {} : { anthropicVersion: version }),
        });
        await sourceStore.set([sourceId], {
            sourcePluginId: factory.manifest.id,
            config,
            enabled: true,
            instanceStateVersion: 1,
        });
        pluginStates.set(factory.manifest.id, true);
        sources.register(factory.create(config));
    };
    await bootstrap({
        manifestId: "heimdall.source.openai-compatible",
        baseUrlEnv: "HEIMDALL_OPENAI_BASE_URL",
        apiKeyEnv: "HEIMDALL_OPENAI_API_KEY",
        sourceIdEnv: "HEIMDALL_OPENAI_SOURCE_ID",
        defaultSourceId: "openai-compatible",
        requireBaseUrl: true,
    });
    await bootstrap({
        manifestId: "heimdall.source.anthropic",
        baseUrlEnv: "HEIMDALL_ANTHROPIC_BASE_URL",
        apiKeyEnv: "HEIMDALL_ANTHROPIC_API_KEY",
        sourceIdEnv: "HEIMDALL_ANTHROPIC_SOURCE_ID",
        versionEnv: "HEIMDALL_ANTHROPIC_VERSION",
        defaultSourceId: "anthropic",
        requireBaseUrl: false,
    });
}

async function restorePluginStates(
    store: ConfigStore,
    pluginStates: Map<string, boolean>,
): Promise<void> {
    const stateStore = store.namespace("heimdall", "plugin-state");
    for await (const entry of stateStore.list<StoredPluginState>()) {
        const pluginId = String(entry.key.at(-1) ?? "");
        if (
            pluginId.length === 0 || typeof entry.value?.enabled !== "boolean"
        ) {
            continue;
        }
        pluginStates.set(pluginId, entry.value.enabled);
    }
}

function asProtocol(value: unknown): ProtocolPlugin | undefined {
    if (!isRecord(value) || !isRecord(value.manifest)) return undefined;
    if (value.manifest.kind !== "protocol") return undefined;
    if (
        typeof value.parse !== "function" ||
        typeof value.serialize !== "function"
    ) return undefined;
    return value as unknown as ProtocolPlugin;
}

function asToolPluginFactory(value: unknown): ToolPluginFactory | undefined {
    if (!isRecord(value) || !isRecord(value.manifest)) return undefined;
    if (value.manifest.kind !== "tool" || typeof value.create !== "function") {
        return undefined;
    }
    return value as unknown as ToolPluginFactory;
}

function assertManifestMatches(
    implementation: PluginManifest,
    declared: PluginManifest | undefined,
): void {
    if (declared === undefined) return;
    if (
        implementation.id !== declared.id ||
        implementation.version !== declared.version ||
        implementation.kind !== declared.kind
    ) {
        throw new Error(
            `plugin implementation does not match manifest: ${declared.id}`,
        );
    }
}

function asPreset(value: unknown): PresetPlugin | undefined {
    if (!isRecord(value) || !isRecord(value.manifest)) return undefined;
    if (value.manifest.kind !== "preset" || typeof value.apply !== "function") {
        return undefined;
    }
    if (typeof value.sourcePluginId !== "string") return undefined;
    return value as unknown as PresetPlugin;
}

async function readManifest(
    directory: URL,
    module: Record<string, unknown> | undefined,
): Promise<PluginManifest | undefined> {
    const fromModule = module?.manifest ?? module?.sourceManifest ??
        module?.newApiPresetManifest;
    if (isRecord(fromModule) && typeof fromModule.id === "string") {
        return fromModule as unknown as PluginManifest;
    }
    const url = new URL("manifest.json", directory);
    if (!await fileExists(url)) return undefined;
    try {
        return validatePluginManifest(
            JSON.parse(await Deno.readTextFile(url)),
        );
    } catch {
        return undefined;
    }
}

function withSourceId(value: unknown, sourceId: string): unknown {
    if (!isRecord(value)) return value;
    return { ...value, id: sourceId };
}

function byId(left: PluginManifest, right: PluginManifest): number {
    return left.id.localeCompare(right.id);
}

function safeMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function directoryExists(url: URL): Promise<boolean> {
    try {
        return (await Deno.stat(url)).isDirectory;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
    }
}

async function fileExists(url: URL): Promise<boolean> {
    try {
        return (await Deno.stat(url)).isFile;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
    }
}

async function collectDirectories(root: URL): Promise<string[]> {
    const names: string[] = [];
    for await (const entry of Deno.readDir(root)) {
        if (entry.isDirectory) names.push(entry.name);
    }
    return names;
}

class ManagementError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.name = "ManagementError";
        this.status = status;
        this.code = code;
    }
}

function pluginManagementError(
    error: unknown,
    pluginId: string,
): ManagementError {
    if (error instanceof StorageConflictError) {
        return new ManagementError(
            409,
            "plugin_revision_conflict",
            "插件状态已变更，请刷新后重试",
        );
    }
    if (error instanceof PluginLifecycleError) {
        const status = error.code === "runtime_required" ? 501 : 409;
        return new ManagementError(
            status,
            `plugin_${error.code}`,
            `plugin ${pluginId}: ${error.message}`,
        );
    }
    if (error instanceof Error) {
        return new ManagementError(
            500,
            "plugin_lifecycle_failed",
            error.message,
        );
    }
    return new ManagementError(500, "plugin_lifecycle_failed", String(error));
}

class MemoryConfigStore implements ConfigStore {
    readonly #values: Map<string, { value: unknown; versionstamp: string }>;
    readonly #prefix:
        readonly (string | number | bigint | boolean | Uint8Array)[];

    constructor(
        prefix: readonly (string | number | bigint | boolean | Uint8Array)[] =
            [],
        values = new Map<string, { value: unknown; versionstamp: string }>(),
    ) {
        this.#prefix = [...prefix];
        this.#values = values;
    }

    namespace(
        ...path: (string | number | bigint | boolean | Uint8Array)[]
    ): ConfigStore {
        return new MemoryConfigStore([...this.#prefix, ...path], this.#values);
    }
    get<T = unknown>(
        path: StorageKey = [],
    ): Promise<VersionedValue<T> | null> {
        const item = this.#values.get(this.key(path));
        return Promise.resolve(
            item === undefined ? null : item as VersionedValue<T>,
        );
    }
    set<T>(
        path: StorageKey,
        value: T,
        options: WriteOptions = {},
    ): Promise<string> {
        const key = this.key(path);
        const previous = this.#values.get(key);
        if (
            options.expectedVersionstamp !== undefined &&
            options.expectedVersionstamp !== (previous?.versionstamp ?? null)
        ) {
            throw new StorageConflictError("configuration changed");
        }
        const versionstamp = crypto.randomUUID();
        this.#values.set(key, { value, versionstamp });
        return Promise.resolve(versionstamp);
    }
    delete(
        path: StorageKey,
        expectedVersionstamp?: string | null,
    ): Promise<void> {
        const key = this.key(path);
        if (
            expectedVersionstamp !== undefined &&
            expectedVersionstamp !==
                (this.#values.get(key)?.versionstamp ?? null)
        ) {
            throw new StorageConflictError("configuration changed");
        }
        this.#values.delete(key);
        return Promise.resolve();
    }
    async *list<T = unknown>(
        path: StorageKey = [],
    ): AsyncIterable<{ key: StorageKey; value: T; versionstamp: string }> {
        const prefix = this.key(path);
        for (const [key, value] of this.#values) {
            if (key.startsWith(`${prefix}/`)) {
                yield {
                    key: [key.slice(prefix.length + 1)],
                    value: value.value as T,
                    versionstamp: value.versionstamp,
                };
            }
        }
    }
    private key(path: StorageKey): string {
        return [...this.#prefix, ...path].map(String).join("/");
    }
}

async function resolveProvider<T>(
    provider: T | ((context: AdminRouteContext) => T | Promise<T>) | undefined,
    context: AdminRouteContext,
): Promise<T> {
    if (typeof provider === "function") {
        return await (provider as (
            context: AdminRouteContext,
        ) => T | Promise<T>)(context);
    }
    return provider as T;
}
