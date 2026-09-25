import { AdminApiError, payloadRecord, request } from "./transport.ts";
import { projectListedPlugins } from "@heimdall/admin-contracts/plugin-catalog.ts";
import type {
    DashboardData,
    ListedModel,
    ListedPreset,
    ListedSource,
    ServiceHealth,
} from "./types.ts";

function field(value: unknown, key: string): unknown {
    return payloadRecord(value)?.[key];
}
function asArray<T>(value: unknown): T[] | null {
    return Array.isArray(value) ? value as T[] : null;
}

function settledError(result: PromiseSettledResult<unknown>): string {
    if (result.status !== "rejected") return "";
    const error: unknown = result.reason;
    if (error instanceof AdminApiError) {
        return `${error.message}${
            error.requestId ? ` (${error.requestId})` : ""
        }`;
    }
    return error instanceof Error ? error.message : String(error);
}

function isUnauthorized(result: PromiseSettledResult<unknown>): boolean {
    if (result.status !== "rejected") return false;
    const error: unknown = result.reason;
    return error instanceof AdminApiError && error.status === 401;
}

/** Load independent dashboard resources while keeping partial failures visible. */
export async function loadDashboard(): Promise<DashboardData> {
    const results = await Promise.allSettled([
        request("/health"),
        request("/api/admin/models"),
        request("/api/admin/status"),
        request("/api/admin/plugins"),
        request("/api/admin/sources"),
        request("/api/admin/presets"),
    ]);
    const [
        healthResult,
        modelsResult,
        statusResult,
        pluginsResult,
        sourcesResult,
        presetsResult,
    ] = results;

    const health =
        (healthResult.status === "fulfilled"
            ? payloadRecord(healthResult.value) ?? { status: "unavailable" }
            : { status: "unavailable" }) as ServiceHealth;
    const modelsPayload = modelsResult.status === "fulfilled" &&
            modelsResult.value
        ? modelsResult.value
        : { data: [] };
    const statusPayload = statusResult.status === "fulfilled" &&
            statusResult.value
        ? statusResult.value
        : {};
    const pluginPayload = pluginsResult.status === "fulfilled" &&
            pluginsResult.value
        ? pluginsResult.value
        : {};
    const presetsPayload = presetsResult.status === "fulfilled" &&
            presetsResult.value
        ? presetsResult.value
        : {};
    const sourcePayload = sourcesResult.status === "fulfilled"
        ? sourcesResult.value
        : {};
    const statusError = settledError(statusResult) ||
        settledError(pluginsResult);
    const sourceError = sourcesResult.status === "rejected"
        ? settledError(sourcesResult)
        : "";

    return {
        health,
        models: asArray<ListedModel>(field(modelsPayload, "data")) ?? [],
        status: {
            sources: asArray<ListedSource>(field(sourcePayload, "sources")) ??
                asArray<ListedSource>(field(statusPayload, "sources")) ??
                asArray<ListedSource>(field(pluginPayload, "sources")) ??
                [],
            plugins: projectListedPlugins(
                asArray<unknown>(field(pluginPayload, "plugins")) ??
                    field(statusPayload, "plugins"),
            ),
            managed: asArray<unknown>(field(pluginPayload, "managed")) ?? [],
            presets: asArray<ListedPreset>(field(presetsPayload, "presets")) ??
                [],
        },
        authRequired: [
            modelsResult,
            statusResult,
            pluginsResult,
            presetsResult,
            sourcesResult,
        ].some(isUnauthorized),
        errors: {
            health: settledError(healthResult),
            models: settledError(modelsResult),
            status: statusError,
            presets: settledError(presetsResult),
            source: sourceError,
        },
    };
}
