import type {
    DashboardData,
    ListedSource,
} from "@heimdall/admin-contracts/console.ts";
import type { UiContext, UiTone } from "@heimdall/admin-contracts/ui.ts";
import { sourceState } from "./catalog-presentation.ts";

/** Deliberate projection: plugins receive counts, never entire API responses. */
export function dashboardUiContext(
    dashboard: DashboardData,
    theme: UiContext["theme"] = "system",
): UiContext {
    if (dashboard.authRequired) return { locale: "zh", theme, data: {} };
    const { sources, plugins } = dashboard.status;
    return {
        locale: "zh",
        theme,
        data: {
            service: {
                state: dashboard.health.status === "ok" ? "正常" : "需要检查",
            },
            sources: {
                total: sources.length,
                enabled:
                    sources.filter((source) => source.enabled === true).length,
            },
            models: { total: dashboard.models.length },
            plugins: {
                total: plugins.length,
                enabled:
                    plugins.filter((plugin) => plugin.enabled === true).length,
                failed: plugins.filter((plugin) => Boolean(plugin.lastError))
                    .length,
            },
        },
    };
}

/** A source slot sees only its own source's public status, not other sources. */
const SOURCE_TONE_TO_UI: Record<string, UiTone> = {
    green: "success",
    amber: "warning",
    red: "danger",
    muted: "neutral",
};

export function sourceUiContext(
    context: UiContext,
    source: ListedSource,
    sourcePluginId: string | undefined = source.sourcePluginId,
): UiContext {
    const state = sourceState(source);
    return {
        locale: "zh",
        theme: context.theme,
        ...(source.id ? { sourceId: source.id } : {}),
        ...(sourcePluginId ? { sourcePluginId } : {}),
        data: {
            source: {
                enabled: source.enabled === true,
                state: state.label,
                stateTone: SOURCE_TONE_TO_UI[state.tone] ?? "neutral",
                priority: Number.isSafeInteger(source.priority)
                    ? source.priority!
                    : 0,
                modelCount: Array.isArray(source.models)
                    ? source.models.length
                    : 0,
                capabilityCount: Array.isArray(source.capabilities)
                    ? source.capabilities.length
                    : 0,
                probeStatus: source.probe?.ok === true
                    ? "最近探测通过"
                    : source.probe?.ok === false
                    ? "最近探测失败"
                    : "尚无探测结果",
            },
        },
    };
}
