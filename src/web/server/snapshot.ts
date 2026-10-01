import type {
    ConsoleSnapshot,
    DashboardData,
    JournalRequest,
    ListedModel,
    ListedPreset,
    ListedSource,
    RuntimeSettingsEnvelope,
    UsageResponse,
} from "@heimdall/admin-contracts/console.ts";
import { projectListedPlugins } from "@heimdall/admin-contracts/plugin-catalog.ts";
import { readSourceCooldown } from "@heimdall/admin-contracts/source-health.ts";
import type { UsageDto } from "@heimdall/admin-contracts";
import {
    isUiJsonObject,
    type UiJsonObject,
    type UiJsonValue,
} from "@heimdall/admin-contracts/ui.ts";
import type {
    SourceProxySelection,
    SourceProxySummary,
} from "@heimdall/admin-contracts/proxies.ts";
import { readProxyPoolView } from "../shared/proxy-presentation.ts";
import {
    parseSourceModelMap,
    type SourceModelMap,
} from "@heimdall/admin-contracts/source-model-map.ts";
import {
    readMaintenanceStatus,
    readRetentionDays,
} from "../shared/retention-settings.ts";
import { readStatsOverview, readStatsSeries } from "../shared/stats.ts";
import type { AdminDispatch } from "./bridge.ts";
import { readBoundedBody } from "./request.ts";

export type { ConsoleSnapshot } from "@heimdall/admin-contracts/console.ts";

export interface ConsoleSnapshotOptions {
    readonly dispatch: AdminDispatch;
    readonly authorized: boolean;
    readonly adminAuthToken?: string;
    readonly origin?: string;
    /** Only the overview needs recent requests, usage and chart data. */
    readonly includeActivity?: boolean;
}

interface Resource {
    readonly data: Record<string, unknown>;
    readonly etag: string;
    readonly error: string;
    readonly unauthorized: boolean;
}

const EMPTY: Resource = { data: {}, etag: "", error: "", unauthorized: false };
const MAX_SNAPSHOT_BYTES = 4_194_304;

function sourceUiSnapshot(
    value: unknown,
    redact: (value: string) => string,
): UiJsonObject | undefined {
    if (!isUiJsonObject(value)) return undefined;
    const project = (entry: UiJsonValue): UiJsonValue => {
        if (typeof entry === "string") return redact(entry);
        if (Array.isArray(entry)) return entry.map(project);
        if (entry === null || typeof entry !== "object") return entry;
        return Object.fromEntries(
            Object.entries(entry).map(([key, item]) => [
                redact(key),
                project(item),
            ]),
        );
    };
    const snapshot = project(value);
    return isUiJsonObject(snapshot) ? snapshot : undefined;
}

/** Read-only SSR adapter. A failed resource does not erase successful panels. */
export async function loadConsoleSnapshot(
    options: ConsoleSnapshotOptions,
): Promise<ConsoleSnapshot> {
    const origin = options.origin ?? "http://localhost";
    const redact = (value: string): string => {
        const secret = options.adminAuthToken?.trim();
        return secret ? value.replaceAll(secret, "[已隐藏]") : value;
    };
    const read = async (path: string): Promise<Resource> => {
        try {
            const headers = new Headers({ accept: "application/json" });
            if (path !== "/health" && options.adminAuthToken !== undefined) {
                headers.set(
                    "authorization",
                    `Bearer ${options.adminAuthToken.trim()}`,
                );
            }
            const response = await options.dispatch(
                new Request(new URL(path, origin), {
                    headers,
                    redirect: "manual",
                }),
            );
            if (!response.ok) {
                await response.body?.cancel();
                const requestId = response.headers.get("x-heimdall-request-id");
                return {
                    ...EMPTY,
                    unauthorized: response.status === 401,
                    error: redact(
                        `读取失败（HTTP ${response.status}）${
                            requestId ? ` · ${requestId}` : ""
                        }`,
                    ),
                };
            }
            const text = await readBoundedBody(
                response.body,
                MAX_SNAPSHOT_BYTES,
                response.headers.get("content-length"),
            );
            const data: unknown = JSON.parse(text);
            if (!isRecord(data)) {
                throw new TypeError("invalid management response");
            }
            return {
                ...EMPTY,
                data,
                etag: redact(response.headers.get("etag") ?? ""),
            };
        } catch {
            return { ...EMPTY, error: "暂时无法读取数据。" };
        }
    };
    const protectedRead = (path: string): Promise<Resource> =>
        options.authorized ? read(path) : Promise.resolve(EMPTY);
    const activityRead = (path: string): Promise<Resource> =>
        options.includeActivity === false
            ? Promise.resolve(EMPTY)
            : protectedRead(path);
    const [
        health,
        models,
        status,
        requests,
        usage,
        settings,
        proxies,
        overview,
        series,
    ] = await Promise
        .all([
            read("/health"),
            protectedRead("/api/admin/models"),
            protectedRead("/api/admin/status"),
            activityRead("/api/admin/requests?limit=20"),
            activityRead("/api/admin/usage"),
            protectedRead("/api/admin/settings"),
            protectedRead("/api/admin/proxies"),
            activityRead("/api/admin/stats"),
            activityRead("/api/admin/stats/series?days=7"),
        ]);
    const text = (value: unknown): string | undefined =>
        typeof value === "string" ? redact(value) : undefined;
    // Keep the row's token counts through the snapshot so the overview table
    // shows the same input/output figures the request history does.
    const journalUsage = (value: unknown): UsageDto | undefined => {
        const usage = record(value);
        if (usage === undefined) return undefined;
        const num = (input: unknown): number | undefined =>
            typeof input === "number" && Number.isFinite(input)
                ? input
                : undefined;
        return {
            requestId: text(usage.requestId) ?? "",
            updatedAt: text(usage.updatedAt) ?? "",
            inputTokens: num(usage.inputTokens),
            outputTokens: num(usage.outputTokens),
            reasoningTokens: num(usage.reasoningTokens),
            cachedInputTokens: num(usage.cachedInputTokens),
            cacheWriteTokens: num(usage.cacheWriteTokens),
            totalTokens: num(usage.totalTokens),
            extensions: record(usage.extensions),
        };
    };
    const dashboard: DashboardData = {
        health: { status: text(health.data.status) ?? "unavailable" },
        models: records(models.data.data).map((model): ListedModel => ({
            id: text(model.id),
            owned_by: text(model.owned_by),
        })),
        status: {
            sources: records(status.data.sources).map(
                (source): ListedSource => {
                    const probe = record(source.probe);
                    const ui = sourceUiSnapshot(source.ui, redact);
                    return {
                        id: text(source.id),
                        name: text(source.name),
                        priority: typeof source.priority === "number" &&
                                Number.isSafeInteger(source.priority)
                            ? source.priority
                            : undefined,
                        sourcePluginId: text(source.sourcePluginId),
                        enabled: bool(source.enabled),
                        instanceEnabled: bool(source.instanceEnabled),
                        pluginEnabled: bool(source.pluginEnabled),
                        versionstamp: text(source.versionstamp),
                        proxy: sourceProxySelection(source.proxy, redact),
                        modelMap: readModelMap(source.modelMap, redact),
                        proxySummary: sourceProxySummary(
                            source.proxySummary,
                            redact,
                        ),
                        health: text(source.health),
                        cooldown: readSourceCooldown(source.cooldown),
                        models: strings(source.models, redact),
                        capabilities: strings(source.capabilities, redact),
                        ...(ui === undefined ? {} : { ui }),
                        ...(probe === undefined ? {} : {
                            probe: {
                                ok: bool(probe.ok),
                                message: text(probe.message),
                            },
                        }),
                    };
                },
            ),
            plugins: projectListedPlugins(status.data.plugins, redact),
            managed: [],
            presets: records(status.data.presets).filter(hasId).map((
                preset,
            ): ListedPreset => ({
                id: redact(preset.id),
                name: text(preset.name),
                sourcePluginId: text(preset.sourcePluginId),
                version: typeof preset.version === "number"
                    ? preset.version
                    : text(preset.version),
            })),
        },
        authRequired: !options.authorized ||
            [
                models,
                status,
                requests,
                usage,
                settings,
                proxies,
                overview,
                series,
            ].some((item) => item.unauthorized),
        errors: {
            health: health.error,
            models: models.error,
            status: status.error,
            presets: "",
            source: "",
        },
    };
    const journal = records(requests.data.requests)
        .filter((
            value,
        ): value is Record<string, unknown> & { requestId: string } =>
            typeof value.requestId === "string"
        )
        .map((entry): JournalRequest => ({
            requestId: redact(entry.requestId),
            model: text(entry.model),
            operation: text(entry.operation),
            status: text(entry.status),
            receivedAt: text(entry.receivedAt),
            completedAt: text(entry.completedAt),
            firstTokenAt: text(entry.firstTokenAt),
            streaming: bool(entry.streaming),
            usage: journalUsage(entry.usage),
        }));
    const totals = record(usage.data.usage);
    const usageData: UsageResponse = {
        usage: totals === undefined
            ? null
            : { totalTokens: finite(totals.totalTokens, 0) },
        days: records(usage.data.days).flatMap((entry) => {
            const day = text(entry.day);
            return day === undefined ? [] : [{
                day,
                requestCount: finite(entry.requestCount, 0),
                totalTokens: finite(entry.totalTokens, 0),
                ...(entry.inputTokens === undefined
                    ? {}
                    : { inputTokens: finite(entry.inputTokens, 0) }),
                ...(entry.outputTokens === undefined
                    ? {}
                    : { outputTokens: finite(entry.outputTokens, 0) }),
            }];
        }),
    };
    const publicSettings = record(settings.data.settings);
    const requestRetentionDays = readRetentionDays(
        publicSettings?.requestRetentionDays,
    );
    const chatRetentionDays = readRetentionDays(
        publicSettings?.chatRetentionDays,
    );
    const maintenance = readMaintenanceStatus(
        settings.data.maintenance,
        redact,
    );
    const settingsData: RuntimeSettingsEnvelope | null =
        publicSettings === undefined ? null : {
            settings: {
                proxyKeyConfigured: publicSettings.proxyKeyConfigured === true,
                limitPerMinute: finite(publicSettings.limitPerMinute, 120),
                probeIntervalMs: finite(
                    publicSettings.probeIntervalMs,
                    300_000,
                ),
                titleModel: typeof publicSettings.titleModel === "string"
                    ? publicSettings.titleModel
                    : "",
                ...(requestRetentionDays === undefined
                    ? {}
                    : { requestRetentionDays }),
                ...(chatRetentionDays === undefined
                    ? {}
                    : { chatRetentionDays }),
            },
            etag: settings.etag,
            ...(maintenance ? { maintenance } : {}),
        };
    let proxiesData: ConsoleSnapshot["proxies"] = null;
    let proxiesError = proxies.error;
    if (options.authorized && !proxies.error) {
        try {
            const pool = readProxyPoolView(proxies.data.pool);
            proxiesData = {
                pool: {
                    defaultProxyId: pool.defaultProxyId === null
                        ? null
                        : redact(pool.defaultProxyId),
                    entries: pool.entries.map((entry) => ({
                        id: redact(entry.id),
                        name: redact(entry.name),
                        url: redact(entry.url),
                        enabled: entry.enabled,
                        authConfigured: entry.authConfigured,
                    })),
                },
                etag: proxies.etag,
            };
        } catch {
            proxiesError = "暂时无法读取代理池。";
        }
    }
    const stats: NonNullable<ConsoleSnapshot["stats"]> = {
        overview: null,
        series: null,
        errors: { overview: overview.error, series: series.error },
    };
    if (options.authorized && options.includeActivity !== false) {
        if (!overview.error) {
            try {
                stats.overview = readStatsOverview(overview.data, redact);
            } catch {
                stats.errors.overview = "暂时无法读取统计总览。";
            }
        }
        if (!series.error) {
            try {
                stats.series = readStatsSeries(series.data, redact);
            } catch {
                stats.errors.series = "暂时无法读取统计趋势。";
            }
        }
    }
    return {
        dashboard,
        requests: journal,
        usage: usageData,
        settings: settingsData,
        proxies: proxiesData,
        stats,
        errors: {
            requests: requests.error,
            usage: usage.error,
            settings: settings.error,
            proxies: proxiesError,
        },
    };
}

function readModelMap(
    value: unknown,
    redact: (value: string) => string,
): SourceModelMap {
    try {
        return parseSourceModelMap(
            Object.fromEntries(
                Object.entries(parseSourceModelMap(value)).map((
                    [alias, target],
                ) => [redact(alias), redact(target)]),
            ),
        );
    } catch {
        return {};
    }
}

function sourceProxySelection(
    value: unknown,
    redact: (value: string) => string,
): SourceProxySelection | undefined {
    const selection = record(value);
    if (selection?.mode === "inherit" || selection?.mode === "direct") {
        return { mode: selection.mode };
    }
    if (selection?.mode === "proxy" && typeof selection.proxyId === "string") {
        return { mode: "proxy", proxyId: redact(selection.proxyId) };
    }
    return undefined;
}

function sourceProxySummary(
    value: unknown,
    redact: (value: string) => string,
): SourceProxySummary | undefined {
    const summary = record(value);
    if (
        !summary ||
        (summary.mode !== "direct" && summary.mode !== "proxy" &&
            summary.mode !== "unavailable") ||
        (summary.selectedBy !== "global" && summary.selectedBy !== "source")
    ) return undefined;
    return {
        mode: summary.mode,
        selectedBy: summary.selectedBy,
        ...(typeof summary.proxyId === "string"
            ? { proxyId: redact(summary.proxyId) }
            : {}),
        ...(typeof summary.name === "string"
            ? { name: redact(summary.name) }
            : {}),
        ...(summary.reason === "missing" || summary.reason === "disabled"
            ? { reason: summary.reason }
            : {}),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(
    value: unknown,
    transform: (text: string) => string,
): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string").map(
            transform,
        )
        : [];
}

function bool(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function finite(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : fallback;
}

function hasId(
    value: Record<string, unknown>,
): value is Record<string, unknown> & { id: string } {
    return typeof value.id === "string";
}
