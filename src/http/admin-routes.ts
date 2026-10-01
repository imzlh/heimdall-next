import { Hono } from "hono";
import type { Context } from "hono";
import type {
    CreateSourceInput,
    PluginDto,
    PresetDto,
    ProxyPoolInput,
    SourceDto,
    SourceProxySelection,
    UpdateSourceInput,
} from "@heimdall/admin-contracts";
import { StorageConflictError } from "@heimdall/storage";
import {
    parseSourceModelMap,
    type SourceModelMap,
} from "@heimdall/admin-contracts/source-model-map.ts";
import type { RequestStore } from "@heimdall/storage";
import type { MountableApp, ServerApp, ServerEnv } from "./app.ts";
import type { ModelsResponse } from "./public-routes.ts";
import { createRequestJournalRoutes } from "./request-journal.ts";
import { createSystemLogRoutes } from "./system-log-routes.ts";
import {
    createPluginPackageRoutes,
    type InstallPluginHandler,
} from "./plugin-package-routes.ts";
import type { SystemLog } from "@heimdall/core/observability/system-log.ts";
import { assertNoRouteConflicts, mountRouteGroup } from "./route-validation.ts";
import { createStatsRoutes } from "./stats-routes.ts";
import { resolveTimeZone } from "../stats/calendar.ts";
import type { SourceDraftProbeResult } from "@heimdall/admin-contracts/source-probe.ts";

const requestIdHeader = "x-heimdall-request-id";

/**
 * One info line per successful management mutation, so the console's system
 * log narrates what changed (添加渠道、更新设置…) without logging reads.
 */
function recordAction(
    systemLog: SystemLog | undefined,
    scope: string,
    message: string,
    detail?: string,
    level: "info" | "warn" = "info",
): void {
    systemLog?.record({ level, scope, message, detail });
}

/** Trimmed id fallback for narration that cannot resolve an entity name. */
function shortLabel(id: string): string {
    return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/** First readable name on a provider row carrying the given id. */
function nameFromRow(row: unknown, id: string): string | undefined {
    if (!isRecord(row)) return undefined;
    if (row.id !== id) return undefined;
    const name = row.name;
    return typeof name === "string" && name.trim() !== "" ? name : undefined;
}

/**
 * Narration prefers the human name, resolved through the detail provider when
 * the composition offers one and otherwise by scanning the list provider.
 * Lookup is best-effort: missing providers and failures degrade to a trimmed
 * id and never break the operation itself.
 */
async function narrateSourceLabel(
    options: AdminRouteOptions,
    context: AdminRouteContext,
    sourceId: string,
): Promise<string> {
    const detail = sourceDetailProvider(options);
    if (detail !== undefined) {
        try {
            const source = await resolveDetail(detail, context, sourceId);
            const name = nameFromRow(source, sourceId);
            if (name !== undefined) return name;
        } catch {
            // fall through to the list scan
        }
    }
    const list = sourceListProvider(options);
    if (typeof list === "function") {
        try {
            const sources = await resolveCollection(list, context);
            if (!(sources instanceof Response)) {
                for (const source of sources) {
                    const name = nameFromRow(source, sourceId);
                    if (name !== undefined) return name;
                }
            }
        } catch {
            // narration stays best-effort
        }
    }
    return shortLabel(sourceId);
}

async function narratePresetLabel(
    options: AdminRouteOptions,
    context: AdminRouteContext,
    presetId: string,
): Promise<string> {
    const detail = presetDetailProvider(options);
    if (detail !== undefined) {
        try {
            const preset = await resolveDetail(detail, context, presetId);
            const name = nameFromRow(preset, presetId);
            if (name !== undefined) return name;
        } catch {
            // fall through to the list scan
        }
    }
    const list = presetListProvider(options);
    if (typeof list === "function") {
        try {
            const presets = await resolveCollection(list, context);
            if (!(presets instanceof Response)) {
                for (const preset of presets) {
                    const name = nameFromRow(preset, presetId);
                    if (name !== undefined) return name;
                }
            }
        } catch {
            // narration stays best-effort
        }
    }
    return shortLabel(presetId);
}

export interface AdminRouteContext {
    readonly request: Request;
    readonly requestId: string;
}

type MaybePromise<T> = T | Promise<T>;
type Provider<T> = T | ((context: AdminRouteContext) => MaybePromise<T>);

type LegacyListHandler = (
    context: AdminRouteContext,
) => Response | Promise<Response>;
type LegacyDetailHandler = (
    context: AdminRouteContext,
    id: string,
) => Response | Promise<Response>;
type DetailProvider<T> =
    | Provider<T | null | undefined>
    | LegacyDetailHandler
    | ((
        context: AdminRouteContext,
        id: string,
    ) => MaybePromise<T | null | undefined>);

export interface SourceConfigSnapshot {
    readonly sourceId: string;
    readonly configured: boolean;
    /** Configuration is already redacted for the operator boundary. */
    readonly config?: unknown;
    readonly versionstamp?: string;
}

export interface AdminWriteResult {
    readonly data: unknown;
    readonly versionstamp?: string;
}

/** State-changing capabilities supplied by the composition root. */
export interface AdminManagementOptions {
    readonly probeSourceDraft?: (
        context: AdminRouteContext,
        input: CreateSourceInput,
    ) => MaybePromise<SourceDraftProbeResult>;
    readonly getProxies?: (
        context: AdminRouteContext,
    ) => MaybePromise<AdminWriteResult>;
    readonly saveProxies?: (
        context: AdminRouteContext,
        input: ProxyPoolInput,
        expectedVersionstamp?: string,
    ) => MaybePromise<AdminWriteResult>;
    readonly createSource?: (
        context: AdminRouteContext,
        input: CreateSourceInput,
    ) => MaybePromise<AdminWriteResult>;
    readonly updateSource?: (
        context: AdminRouteContext,
        sourceId: string,
        input: UpdateSourceInput,
        expectedVersionstamp?: string,
    ) => MaybePromise<AdminWriteResult>;
    readonly deleteSource?: (
        context: AdminRouteContext,
        sourceId: string,
        expectedVersionstamp?: string,
    ) => MaybePromise<AdminWriteResult>;
    readonly getSourceConfig?: (
        context: AdminRouteContext,
        sourceId: string,
    ) => MaybePromise<SourceConfigSnapshot | null>;
    readonly validateSourceConfig?: (
        context: AdminRouteContext,
        sourceId: string,
        config: unknown,
    ) => MaybePromise<unknown>;
    readonly saveSourceConfig?: (
        context: AdminRouteContext,
        sourceId: string,
        config: unknown,
        expectedVersionstamp?: string,
    ) => MaybePromise<AdminWriteResult>;
    readonly previewPreset?: (
        context: AdminRouteContext,
        presetId: string,
        config: unknown,
    ) => MaybePromise<unknown>;
    readonly applyPreset?: (
        context: AdminRouteContext,
        presetId: string,
        config: unknown,
        expectedVersionstamp?: string,
    ) => MaybePromise<AdminWriteResult>;
    readonly setPluginEnabled?: (
        context: AdminRouteContext,
        pluginId: string,
        enabled: boolean,
    ) => MaybePromise<unknown>;
    readonly uninstallPlugin?: (
        context: AdminRouteContext,
        pluginId: string,
    ) => MaybePromise<unknown>;
    readonly installPlugin?: InstallPluginHandler;
    readonly probeSource?: (
        context: AdminRouteContext,
        sourceId: string,
    ) => MaybePromise<{
        readonly sourceId: string;
        readonly ok: boolean;
        readonly message: string;
        readonly health: "ready" | "cooldown";
    }>;
    readonly clearSourceCooldown?: (
        context: AdminRouteContext,
        sourceId: string,
    ) => MaybePromise<
        import("@heimdall/admin-contracts/source-health.ts").SourceHealthResetDto
    >;
    readonly getSettings?: (
        context: AdminRouteContext,
    ) => MaybePromise<AdminWriteResult>;
    readonly saveSettings?: (
        context: AdminRouteContext,
        patch: {
            readonly proxyKey?: string;
            readonly limitPerMinute?: number;
            readonly probeIntervalMs?: number;
            readonly titleModel?: string;
            readonly requestRetentionDays?: number;
            readonly chatRetentionDays?: number;
        },
        expectedVersionstamp?: string,
    ) => MaybePromise<AdminWriteResult>;
}

/** Values used to populate the operator catalog at the HTTP boundary. */
export interface AdminCatalogOptions {
    readonly plugins?: Provider<readonly PluginDto[]>;
    readonly sources?: Provider<readonly SourceDto[]>;
    readonly presets?: Provider<readonly PresetDto[]>;
}

/**
 * Management route dependencies. The HTTP layer only sees serializable DTOs;
 * registries, KV handles, and runtime objects stay in the composition root.
 *
 * `plugins`, `sources`, and `presets` accept either a snapshot or a provider.
 * The `list*`/`get*` forms retain compatibility with the first route adapter,
 * whose callbacks returned a Response directly.
 */
export interface AdminRouteOptions {
    /** The live model catalog, protected by management authentication. */
    readonly models?: () => ModelsResponse | Promise<ModelsResponse>;
    /** Optional manifest-owned management routes mounted at the admin root. */
    readonly manifestRoutes?: MountableApp;
    readonly catalog?: AdminCatalogOptions;
    readonly plugins?: Provider<readonly PluginDto[]>;
    readonly sources?: Provider<readonly SourceDto[]>;
    readonly presets?: Provider<readonly PresetDto[]>;
    readonly listPlugins?:
        | LegacyListHandler
        | Provider<readonly PluginDto[]>;
    readonly getPlugin?: DetailProvider<PluginDto>;
    readonly listSources?:
        | LegacyListHandler
        | Provider<readonly SourceDto[]>;
    readonly getSource?: DetailProvider<SourceDto>;
    readonly listPresets?:
        | LegacyListHandler
        | Provider<readonly PresetDto[]>;
    readonly getPreset?: DetailProvider<PresetDto>;
    readonly management?: AdminManagementOptions;
    /** Read-only request journal. Omitted when history storage is not installed. */
    readonly requestJournal?: RequestStore;
    /** In-memory system event log. Omitted when the host does not expose one. */
    readonly systemLog?: SystemLog;
    /** IANA zone defining natural days in usage statistics; the process zone by default. */
    readonly statsTimeZone?: string;
}

/** Build the single-tenant operator route group. */
export function createAdminRoutes(
    options: AdminRouteOptions = {},
): ServerApp {
    const app = new Hono<ServerEnv>();

    app.get("/models", async (context) => {
        return context.json(
            await options.models?.() ?? {
                object: "list",
                data: [],
            },
        );
    });

    app.get("/plugins", async (context) => {
        return await collectionResponse(
            context,
            "plugins",
            pluginListProvider(options),
        );
    });

    // The installed alias keeps the operator API explicit about lifecycle
    // records while sharing the same serializable plugin DTO collection.
    app.get("/plugins/installed", async (context) => {
        return await collectionResponse(
            context,
            "plugins",
            pluginListProvider(options),
        );
    });

    // The plugin namespace is the only core-owned parameterized route. Plugin
    // implementations may expose their own manifest routes separately.
    app.get("/plugin/:id", async (context) => {
        const id = context.req.param("id");
        return await detailResponse(
            context,
            "plugin",
            id,
            pluginDetailProvider(options),
            pluginListProvider(options),
        );
    });

    app.get("/sources", async (context) => {
        const id = context.req.query("id");
        if (id !== undefined && id.length > 0) {
            return await detailResponse(
                context,
                "source",
                id,
                sourceDetailProvider(options),
                sourceListProvider(options),
            );
        }
        return await collectionResponse(
            context,
            "sources",
            sourceListProvider(options),
        );
    });

    app.get("/presets", async (context) => {
        const id = context.req.query("id");
        if (id !== undefined && id.length > 0) {
            return await detailResponse(
                context,
                "preset",
                id,
                presetDetailProvider(options),
                presetListProvider(options),
            );
        }
        return await collectionResponse(
            context,
            "presets",
            presetListProvider(options),
        );
    });

    app.get("/status", async (context) => {
        const adminContext = toAdminContext(context);
        const plugins = await resolveCollection(
            pluginListProvider(options),
            adminContext,
        );
        const sources = await resolveCollection(
            sourceListProvider(options),
            adminContext,
        );
        const presets = await resolveCollection(
            presetListProvider(options),
            adminContext,
        );
        if (plugins instanceof Response) {
            return withRequestId(plugins, adminContext.requestId);
        }
        if (sources instanceof Response) {
            return withRequestId(sources, adminContext.requestId);
        }
        if (presets instanceof Response) {
            return withRequestId(presets, adminContext.requestId);
        }
        return json(context, {
            status: "ok",
            plugins,
            sources,
            presets,
        }, adminContext.requestId);
    });

    // State-changing management capabilities use fixed paths and request-body
    // identifiers. The core route table stays explicit; `/plugin/:id` above
    // remains the only parameterized path owned by the host.
    app.post("/sources", async (context) => {
        const adminContext = toAdminContext(context);
        const input = parseCreateSource(await readJsonBody(context));
        const handler = options.management?.createSource;
        if (handler === undefined) return unavailable(adminContext.requestId);
        const result = await invokeManagement(() =>
            handler(adminContext, input)
        );
        recordAction(
            options.systemLog,
            "渠道",
            `添加渠道「${input.name}」`,
            `id=${input.id} · 插件=${input.sourcePluginId}${
                input.presetId ? ` · 预设=${input.presetId}` : ""
            }`,
        );
        return writeJson(
            result.data,
            adminContext.requestId,
            result.versionstamp,
            201,
        );
    });

    app.patch("/sources", async (context) => {
        const adminContext = toAdminContext(context);
        const sourceId = requiredQuery(context, "id");
        const input = parseUpdateSource(await readJsonBody(context));
        const handler = options.management?.updateSource;
        if (handler === undefined) return unavailable(adminContext.requestId);
        const result = await invokeManagement(() =>
            handler(adminContext, sourceId, input, expectedVersion(context))
        );
        recordAction(
            options.systemLog,
            "渠道",
            input.name !== undefined
                ? `更新渠道「${input.name}」`
                : `更新渠道 ${await narrateSourceLabel(
                    options,
                    adminContext,
                    sourceId,
                )}`,
            `id=${sourceId} · 字段=${Object.keys(input).join(" / ")}`,
        );
        return writeJson(
            result.data,
            adminContext.requestId,
            result.versionstamp,
        );
    });

    app.delete("/sources", async (context) => {
        const adminContext = toAdminContext(context);
        const sourceId = requiredQuery(context, "id");
        const handler = options.management?.deleteSource;
        if (handler === undefined) return unavailable(adminContext.requestId);
        // Resolve the display name before the source is gone.
        const label = await narrateSourceLabel(options, adminContext, sourceId);
        const result = await invokeManagement(() =>
            handler(adminContext, sourceId, expectedVersion(context))
        );
        recordAction(
            options.systemLog,
            "渠道",
            `删除渠道 ${label}`,
            `id=${sourceId}`,
        );
        return writeJson(
            result.data,
            adminContext.requestId,
            result.versionstamp,
        );
    });

    app.get("/source-config", async (context) => {
        const adminContext = toAdminContext(context);
        const sourceId = requiredQuery(context, "id");
        const handler = options.management?.getSourceConfig;
        if (handler === undefined) return unavailable(adminContext.requestId);
        const result = await invokeManagement(() =>
            handler(adminContext, sourceId)
        );
        if (result === null) return notFound(context, "source", sourceId);
        return json(context, { source: result }, adminContext.requestId);
    });

    app.post("/source-config/validate", async (context) => {
        const adminContext = toAdminContext(context);
        const body = await readJsonBody(context);
        const sourceId = requiredString(
            body.sourceId ?? context.req.query("id"),
            "sourceId",
        );
        const handler = options.management?.validateSourceConfig;
        if (handler === undefined) return unavailable(adminContext.requestId);
        const config = await invokeManagement(() =>
            handler(adminContext, sourceId, body.config)
        );
        return json(context, { sourceId, config }, adminContext.requestId);
    });

    app.put("/source-config", async (context) => {
        const adminContext = toAdminContext(context);
        const body = await readJsonBody(context);
        const sourceId = requiredString(
            body.sourceId ?? context.req.query("id"),
            "sourceId",
        );
        const handler = options.management?.saveSourceConfig;
        if (handler === undefined) return unavailable(adminContext.requestId);
        const result = await invokeManagement(() =>
            handler(
                adminContext,
                sourceId,
                body.config,
                expectedVersion(context),
            )
        );
        recordAction(
            options.systemLog,
            "渠道",
            `保存渠道配置 ${await narrateSourceLabel(
                options,
                adminContext,
                sourceId,
            )}`,
            `id=${sourceId}`,
        );
        return writeJson(
            result.data,
            adminContext.requestId,
            result.versionstamp,
        );
    });

    app.post("/preset-preview", async (context) => {
        const adminContext = toAdminContext(context);
        const body = await readJsonBody(context);
        const presetId = requiredString(body.presetId, "presetId");
        const handler = options.management?.previewPreset;
        if (handler === undefined) return unavailable(adminContext.requestId);
        const result = await invokeManagement(() =>
            handler(adminContext, presetId, body.config)
        );
        return json(context, { presetId, result }, adminContext.requestId);
    });

    app.post("/preset-apply", async (context) => {
        const adminContext = toAdminContext(context);
        const body = await readJsonBody(context);
        const presetId = requiredString(body.presetId, "presetId");
        const handler = options.management?.applyPreset;
        if (handler === undefined) return unavailable(adminContext.requestId);
        const result = await invokeManagement(() =>
            handler(
                adminContext,
                presetId,
                body.config,
                expectedVersion(context),
            )
        );
        recordAction(
            options.systemLog,
            "预设",
            `应用预设 ${await narratePresetLabel(
                options,
                adminContext,
                presetId,
            )}`,
            `id=${presetId}`,
        );
        return writeJson(
            result.data,
            adminContext.requestId,
            result.versionstamp,
        );
    });

    app.get("/proxies", async (context) => {
        const adminContext = toAdminContext(context);
        const handler = options.management?.getProxies;
        if (handler === undefined) return unavailable(adminContext.requestId);
        const result = await invokeManagement(() => handler(adminContext));
        return writeJson(
            result.data,
            adminContext.requestId,
            result.versionstamp,
        );
    });

    app.put("/proxies", async (context) => {
        const adminContext = toAdminContext(context);
        const body = await readJsonBody(context);
        const handler = options.management?.saveProxies;
        if (handler === undefined) return unavailable(adminContext.requestId);
        // The injected capability validates and normalizes the complete pool.
        const result = await invokeManagement(() =>
            handler(
                adminContext,
                body as unknown as ProxyPoolInput,
                expectedVersion(context),
            )
        );
        recordAction(
            options.systemLog,
            "代理",
            "更新代理池",
            Array.isArray(body.entries)
                ? `共 ${body.entries.length} 个代理`
                : undefined,
        );
        return writeJson(
            result.data,
            adminContext.requestId,
            result.versionstamp,
        );
    });

    app.get("/settings", async (context) => {
        const adminContext = toAdminContext(context);
        const handler = options.management?.getSettings;
        if (handler === undefined) return unavailable(adminContext.requestId);
        const result = await invokeManagement(() => handler(adminContext));
        return writeJson(
            result.data,
            adminContext.requestId,
            result.versionstamp,
        );
    });

    app.put("/settings", async (context) => {
        const adminContext = toAdminContext(context);
        const body = await readJsonBody(context);
        const handler = options.management?.saveSettings;
        if (handler === undefined) return unavailable(adminContext.requestId);
        const patch: {
            proxyKey?: string;
            limitPerMinute?: number;
            probeIntervalMs?: number;
            titleModel?: string;
            requestRetentionDays?: number;
            chatRetentionDays?: number;
        } = {};
        if (body.proxyKey !== undefined) {
            if (typeof body.proxyKey !== "string") {
                throw new AdminRouteError(
                    400,
                    "invalid_request",
                    "proxyKey must be a string",
                );
            }
            patch.proxyKey = body.proxyKey;
        }
        if (body.limitPerMinute !== undefined) {
            if (typeof body.limitPerMinute !== "number") {
                throw new AdminRouteError(
                    400,
                    "invalid_request",
                    "limitPerMinute must be a number",
                );
            }
            patch.limitPerMinute = body.limitPerMinute;
        }
        if (body.probeIntervalMs !== undefined) {
            if (typeof body.probeIntervalMs !== "number") {
                throw new AdminRouteError(
                    400,
                    "invalid_request",
                    "probeIntervalMs must be a number",
                );
            }
            patch.probeIntervalMs = body.probeIntervalMs;
        }
        if (body.titleModel !== undefined) {
            if (typeof body.titleModel !== "string") {
                throw new AdminRouteError(
                    400,
                    "invalid_request",
                    "titleModel must be a string",
                );
            }
            patch.titleModel = body.titleModel;
        }
        for (
            const key of ["requestRetentionDays", "chatRetentionDays"] as const
        ) {
            if (body[key] === undefined) continue;
            const value = body[key];
            if (
                typeof value !== "number" || !Number.isInteger(value) ||
                value < 0 || value > 3650
            ) {
                throw new AdminRouteError(
                    400,
                    "invalid_request",
                    `${key} must be an integer from 0 to 3650`,
                );
            }
            patch[key] = value;
        }
        const result = await invokeManagement(() =>
            handler(adminContext, patch, expectedVersion(context))
        );
        recordAction(
            options.systemLog,
            "设置",
            "更新网关设置",
            Object.keys(patch).join(" / "),
        );
        return writeJson(
            result.data,
            adminContext.requestId,
            result.versionstamp,
        );
    });

    app.post("/plugin-state", async (context) => {
        const adminContext = toAdminContext(context);
        const body = await readJsonBody(context);
        const pluginId = requiredString(body.pluginId, "pluginId");
        if (typeof body.enabled !== "boolean") {
            throw new AdminRouteError(
                400,
                "invalid_request",
                "enabled must be a boolean",
            );
        }
        const enabled = body.enabled;
        const handler = options.management?.setPluginEnabled;
        if (handler === undefined) return unavailable(adminContext.requestId);
        const result = await invokeManagement(() =>
            handler(adminContext, pluginId, enabled)
        );
        recordAction(
            options.systemLog,
            "插件",
            `${enabled ? "启用插件" : "停用插件"} ${pluginId}`,
        );
        return json(context, { plugin: result }, adminContext.requestId);
    });

    app.post("/source-draft-probe", async (context) => {
        const adminContext = toAdminContext(context);
        const input = parseCreateSource(await readJsonBody(context));
        const handler = options.management?.probeSourceDraft;
        if (!handler) return unavailable(adminContext.requestId);
        const result = await invokeManagement(() =>
            handler(adminContext, input)
        );
        return json(context, { probe: result }, adminContext.requestId);
    });

    app.post("/source-probe", async (context) => {
        const adminContext = toAdminContext(context);
        const body = await readJsonBody(context);
        const sourceId = requiredString(body.sourceId, "sourceId");
        const handler = options.management?.probeSource;
        if (handler === undefined) return unavailable(adminContext.requestId);
        const result = await invokeManagement(() =>
            handler(adminContext, sourceId)
        );
        recordAction(
            options.systemLog,
            "渠道",
            `探测渠道 ${await narrateSourceLabel(
                options,
                adminContext,
                sourceId,
            )}`,
            result.ok ? "成功" : result.message,
            result.ok ? "info" : "warn",
        );
        return json(context, { probe: result }, adminContext.requestId);
    });

    app.post("/source-health/reset", async (context) => {
        const adminContext = toAdminContext(context);
        const body = await readJsonBody(context);
        const sourceId = requiredString(body.sourceId, "sourceId");
        const handler = options.management?.clearSourceCooldown;
        if (!handler) return unavailable(adminContext.requestId);
        const result = await invokeManagement(() =>
            handler(adminContext, sourceId)
        );
        if (result.cleared) {
            recordAction(
                options.systemLog,
                "渠道",
                `手动解除渠道冷却 ${await narrateSourceLabel(
                    options,
                    adminContext,
                    sourceId,
                )}`,
                "仅恢复调度资格，未验证上游",
            );
        }
        return json(context, { source: result }, adminContext.requestId);
    });

    app.delete("/plugin", async (context) => {
        const adminContext = toAdminContext(context);
        const body = await readJsonBody(context);
        const pluginId = requiredString(body.pluginId, "pluginId");
        const handler = options.management?.uninstallPlugin;
        if (handler === undefined) return unavailable(adminContext.requestId);
        const result = await invokeManagement(() =>
            handler(adminContext, pluginId)
        );
        recordAction(options.systemLog, "插件", `卸载插件 ${pluginId}`);
        return json(context, { removed: result }, adminContext.requestId);
    });

    if (options.requestJournal !== undefined) {
        const clock = {
            timeZone: resolveTimeZone(options.statsTimeZone),
            now: () => new Date(),
        };
        mountRouteGroup(
            app,
            "/",
            createRequestJournalRoutes(options.requestJournal, clock),
        );
        mountRouteGroup(
            app,
            "/",
            createStatsRoutes(options.requestJournal, clock),
        );
    }

    const installPlugin = options.management?.installPlugin;
    if (installPlugin !== undefined) {
        mountRouteGroup(
            app,
            "/",
            createPluginPackageRoutes(async (context, input) => {
                const result = await installPlugin(context, input);
                recordAction(
                    options.systemLog,
                    "插件",
                    "已安装本地插件包，等待启用",
                );
                return result;
            }),
        );
    }

    if (options.manifestRoutes !== undefined) {
        mountRouteGroup(app, "/", options.manifestRoutes);
    }

    if (options.systemLog !== undefined) {
        mountRouteGroup(app, "/", createSystemLogRoutes(options.systemLog));
    }

    assertNoRouteConflicts(app, "admin");

    return app;
}

function pluginListProvider(
    options: AdminRouteOptions,
): Provider<readonly PluginDto[]> | LegacyListHandler {
    return options.listPlugins ?? options.plugins ?? options.catalog?.plugins ??
        [];
}

function pluginDetailProvider(
    options: AdminRouteOptions,
): DetailProvider<PluginDto> | undefined {
    return options.getPlugin;
}

function sourceListProvider(
    options: AdminRouteOptions,
): Provider<readonly SourceDto[]> | LegacyListHandler {
    return options.listSources ?? options.sources ?? options.catalog?.sources ??
        [];
}

function sourceDetailProvider(
    options: AdminRouteOptions,
): DetailProvider<SourceDto> | undefined {
    return options.getSource;
}

function presetListProvider(
    options: AdminRouteOptions,
): Provider<readonly PresetDto[]> | LegacyListHandler {
    return options.listPresets ?? options.presets ?? options.catalog?.presets ??
        [];
}

function presetDetailProvider(
    options: AdminRouteOptions,
): DetailProvider<PresetDto> | undefined {
    return options.getPreset;
}

async function collectionResponse<T>(
    context: Context<ServerEnv>,
    key: "plugins" | "sources" | "presets",
    provider: Provider<readonly T[]> | LegacyListHandler,
): Promise<Response> {
    const adminContext = toAdminContext(context);
    const resolved = await resolveCollection(provider, adminContext);
    if (resolved instanceof Response) {
        return withRequestId(resolved, adminContext.requestId);
    }
    return json(context, { [key]: resolved }, adminContext.requestId);
}

async function detailResponse<T extends { readonly id: string }>(
    context: Context<ServerEnv>,
    key: "plugin" | "source" | "preset",
    id: string,
    detailProvider: DetailProvider<T> | undefined,
    listProvider: Provider<readonly T[]> | LegacyListHandler,
): Promise<Response> {
    const adminContext = toAdminContext(context);
    let resolved: T | null | undefined | Response;
    if (detailProvider !== undefined) {
        resolved = await resolveDetail(detailProvider, adminContext, id);
    } else {
        const listed = await resolveCollection(listProvider, adminContext);
        resolved = listed instanceof Response
            ? listed
            : listed.find((item) => item.id === id);
    }
    if (resolved instanceof Response) {
        return withRequestId(resolved, adminContext.requestId);
    }
    if (resolved === undefined || resolved === null) {
        return json(
            context,
            {
                error: {
                    code: "not_found",
                    message: `${key} not found: ${id}`,
                    request_id: adminContext.requestId,
                },
            },
            adminContext.requestId,
            404,
        );
    }
    return json(context, { [key]: resolved }, adminContext.requestId);
}

async function resolveCollection<T>(
    provider: Provider<readonly T[]> | LegacyListHandler,
    context: AdminRouteContext,
): Promise<readonly T[] | Response> {
    const result = await invokeProvider(provider, context);
    if (result instanceof Response) return result;
    if (Array.isArray(result)) return result as readonly T[];
    if (isRecord(result)) {
        for (const key of ["plugins", "sources", "presets"] as const) {
            const value = result[key];
            if (Array.isArray(value)) return value as readonly T[];
        }
    }
    throw new TypeError("admin collection provider must return an array");
}

async function resolveDetail<T>(
    provider: DetailProvider<T>,
    context: AdminRouteContext,
    id: string,
): Promise<T | null | undefined | Response> {
    const result = typeof provider === "function"
        ? await (provider as unknown as (
            context: AdminRouteContext,
            id: string,
        ) => MaybePromise<T | null | undefined>)(context, id)
        : provider;
    if (result instanceof Response) return result;
    if (result === null || result === undefined) return result;
    if (isRecord(result)) {
        for (const key of ["plugin", "source", "preset"] as const) {
            if (key in result) return result[key] as T | null | undefined;
        }
    }
    return result as T;
}

async function invokeProvider<T>(
    provider: Provider<T> | LegacyListHandler,
    context: AdminRouteContext,
): Promise<T | Response> {
    if (typeof provider !== "function") return provider;
    return await (provider as unknown as (
        context: AdminRouteContext,
    ) => MaybePromise<T | Response>)(context);
}

function toAdminContext(context: Context<ServerEnv>): AdminRouteContext {
    return {
        request: context.req.raw,
        requestId: context.get("requestId") ||
            context.req.header("x-request-id")?.trim() || crypto.randomUUID(),
    };
}

function json(
    _context: Context<ServerEnv>,
    payload: unknown,
    requestId: string,
    status = 200,
): Response {
    return Response.json(payload, {
        status,
        headers: { [requestIdHeader]: requestId },
    });
}

function writeJson(
    payload: unknown,
    requestId: string,
    versionstamp: string | undefined,
    status = 200,
): Response {
    const headers: Record<string, string> = {
        [requestIdHeader]: requestId,
    };
    if (versionstamp !== undefined) headers.etag = versionstamp;
    return Response.json(payload, { status, headers });
}

class AdminRouteError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.name = "AdminRouteError";
        this.status = status;
        this.code = code;
    }
}

function unavailable(requestId: string): Response {
    return Response.json({
        error: {
            code: "management_unavailable",
            message: "management capability is not installed",
            request_id: requestId,
        },
    }, { status: 501, headers: { [requestIdHeader]: requestId } });
}

async function invokeManagement<T>(
    operation: () => MaybePromise<T>,
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof AdminRouteError) throw error;
        if (error instanceof StorageConflictError) {
            throw new AdminRouteError(
                409,
                "conflict",
                error.message || "resource changed",
            );
        }
        if (error instanceof TypeError) {
            throw new AdminRouteError(
                400,
                "invalid_config",
                error.message || "management input is invalid",
            );
        }
        throw error;
    }
}

function notFound(
    context: Context<ServerEnv>,
    kind: string,
    id: string,
): Response {
    const requestId = toAdminContext(context).requestId;
    return json(
        context,
        { error: { code: "not_found", message: `${kind} not found: ${id}` } },
        requestId,
        404,
    );
}

function requiredQuery(context: Context<ServerEnv>, name: string): string {
    return requiredString(context.req.query(name), name);
}

function requiredString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new AdminRouteError(
            400,
            "invalid_request",
            `${name} is required`,
        );
    }
    return value.trim();
}

function boundedString(value: unknown, name: string, maximum: number): string {
    const result = requiredString(value, name);
    if (result.length > maximum) {
        throw new AdminRouteError(
            400,
            "invalid_request",
            `${name} must not exceed ${maximum} characters`,
        );
    }
    return result;
}

function parseCreateSource(body: Record<string, unknown>): CreateSourceInput {
    if (
        typeof body.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            .test(body.id)
    ) {
        throw new AdminRouteError(
            400,
            "invalid_request",
            "id must be a UUID v4",
        );
    }
    const name = boundedString(body.name, "name", 120);
    if (
        typeof body.priority !== "number" ||
        !Number.isSafeInteger(body.priority)
    ) {
        throw new AdminRouteError(
            400,
            "invalid_request",
            "priority must be a safe integer",
        );
    }
    const sourcePluginId = boundedString(
        body.sourcePluginId,
        "sourcePluginId",
        128,
    );
    const presetId = body.presetId === undefined
        ? undefined
        : boundedString(body.presetId, "presetId", 128);
    if (!isRecord(body.config)) {
        throw new AdminRouteError(
            400,
            "invalid_request",
            "config must be an object",
        );
    }
    return {
        id: body.id,
        name,
        priority: body.priority,
        ...(body.proxy === undefined
            ? {}
            : { proxy: parseSourceProxy(body.proxy) }),
        ...(body.modelMap === undefined
            ? {}
            : { modelMap: parseModelMap(body.modelMap) }),
        sourcePluginId,
        ...(presetId === undefined ? {} : { presetId }),
        config: body.config,
    };
}

function parseUpdateSource(body: Record<string, unknown>): UpdateSourceInput {
    if (
        Object.keys(body).some((key) =>
            !["name", "priority", "enabled", "proxy", "modelMap"].includes(key)
        )
    ) {
        throw new AdminRouteError(
            400,
            "invalid_request",
            "only name, priority, enabled, proxy and modelMap can be updated",
        );
    }
    if (Object.keys(body).length === 0) {
        throw new AdminRouteError(
            400,
            "invalid_request",
            "at least one channel setting is required",
        );
    }
    const input: {
        name?: string;
        priority?: number;
        enabled?: boolean;
        proxy?: SourceProxySelection;
        modelMap?: SourceModelMap;
    } = {};
    if (Object.hasOwn(body, "proxy")) {
        input.proxy = parseSourceProxy(body.proxy);
    }
    if (Object.hasOwn(body, "modelMap")) {
        input.modelMap = parseModelMap(body.modelMap);
    }
    if (Object.hasOwn(body, "name")) {
        input.name = boundedString(body.name, "name", 120);
    }
    if (Object.hasOwn(body, "priority")) {
        if (
            typeof body.priority !== "number" ||
            !Number.isSafeInteger(body.priority)
        ) {
            throw new AdminRouteError(
                400,
                "invalid_request",
                "priority must be a safe integer",
            );
        }
        input.priority = body.priority;
    }
    if (Object.hasOwn(body, "enabled")) {
        if (typeof body.enabled !== "boolean") {
            throw new AdminRouteError(
                400,
                "invalid_request",
                "enabled must be a boolean",
            );
        }
        input.enabled = body.enabled;
    }
    return input;
}

function parseSourceProxy(input: unknown): SourceProxySelection {
    if (isRecord(input)) {
        const keys = Object.keys(input);
        if (
            (input.mode === "inherit" || input.mode === "direct") &&
            keys.length === 1
        ) {
            return { mode: input.mode };
        }
        if (
            input.mode === "proxy" && keys.length === 2 &&
            typeof input.proxyId === "string" &&
            /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.proxyId)
        ) {
            return { mode: "proxy", proxyId: input.proxyId };
        }
    }
    throw new AdminRouteError(
        400,
        "invalid_request",
        "invalid source proxy selection",
    );
}

function parseModelMap(input: unknown): SourceModelMap {
    try {
        return parseSourceModelMap(input);
    } catch (error) {
        throw new AdminRouteError(
            400,
            "invalid_source_model_map",
            error instanceof Error ? error.message : "模型映射无效。",
        );
    }
}

function expectedVersion(context: Context<ServerEnv>): string | undefined {
    const value = context.req.header("if-match")?.trim();
    if (value === undefined || value === "" || value === "*") return undefined;
    return value.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1)
        : value;
}

async function readJsonBody(
    context: Context<ServerEnv>,
): Promise<Record<string, unknown>> {
    const bytes = new Uint8Array(await context.req.raw.arrayBuffer());
    if (bytes.byteLength > 1_048_576) {
        throw new AdminRouteError(
            413,
            "payload_too_large",
            "request body is too large",
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new AdminRouteError(
            400,
            "invalid_json",
            "request body must be valid JSON",
        );
    }
    if (!isRecord(parsed)) {
        throw new AdminRouteError(
            400,
            "invalid_request",
            "request body must be an object",
        );
    }
    return parsed;
}

function withRequestId(response: Response, requestId: string): Response {
    if (response.headers.get(requestIdHeader) === requestId) return response;
    const headers = new Headers(response.headers);
    headers.set(requestIdHeader, requestId);
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
