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
import type { AdminDispatch } from "./bridge.ts";
import { readBoundedBody } from "./request.ts";

export type { ConsoleSnapshot } from "@heimdall/admin-contracts/console.ts";

export interface ConsoleSnapshotOptions {
    readonly dispatch: AdminDispatch;
    readonly authorized: boolean;
    readonly adminAuthToken?: string;
    readonly origin?: string;
}

interface Resource {
    readonly data: Record<string, unknown>;
    readonly etag: string;
    readonly error: string;
    readonly unauthorized: boolean;
}

const EMPTY: Resource = { data: {}, etag: "", error: "", unauthorized: false };
const MAX_SNAPSHOT_BYTES = 4_194_304;

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
    const [health, models, status, requests, usage, settings] = await Promise
        .all([
            read("/health"),
            protectedRead("/api/admin/models"),
            protectedRead("/api/admin/status"),
            protectedRead("/api/admin/requests?limit=20"),
            protectedRead("/api/admin/usage"),
            protectedRead("/api/admin/settings"),
        ]);
    const text = (value: unknown): string | undefined =>
        typeof value === "string" ? redact(value) : undefined;
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
                        health: text(source.health),
                        models: strings(source.models, redact),
                        capabilities: strings(source.capabilities, redact),
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
            [models, status, requests, usage, settings].some((item) =>
                item.unauthorized
            ),
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
            }];
        }),
    };
    const publicSettings = record(settings.data.settings);
    const settingsData: RuntimeSettingsEnvelope | null =
        publicSettings === undefined ? null : {
            settings: {
                proxyKeyConfigured: publicSettings.proxyKeyConfigured === true,
                limitPerMinute: finite(publicSettings.limitPerMinute, 120),
                probeIntervalMs: finite(
                    publicSettings.probeIntervalMs,
                    300_000,
                ),
            },
            etag: settings.etag,
        };
    return {
        dashboard,
        requests: journal,
        usage: usageData,
        settings: settingsData,
        errors: {
            requests: requests.error,
            usage: usage.error,
            settings: settings.error,
        },
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
