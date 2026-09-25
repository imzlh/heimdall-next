import type { Context } from "hono";
import type {
    ListedPlugin,
    ListedPreset,
} from "@heimdall/admin-contracts/console.ts";
import type { SourceConfigSchema } from "@heimdall/admin-contracts/forms.ts";
import {
    safeUiAssetPath,
    type UiContribution,
    type UiPolicy,
} from "@heimdall/admin-contracts/ui.ts";
import {
    parseUiCatalog,
    UI_CATALOG_LIMITS,
    type UiCatalog,
} from "@heimdall/admin-contracts/ui-catalog.ts";
import type { AdminDispatch } from "./bridge.ts";
import type { WebSession } from "./session.ts";
import {
    assertSameOrigin,
    readBoundedBody,
    requestError,
    WebRequestError,
} from "./request.ts";

type Provider<T> = T | (() => T | Promise<T>);

export interface UiCatalogOptions {
    readonly dispatch: AdminDispatch;
    readonly adminAuthToken?: string;
    /** JSON declarations are resolved again for every catalog read. */
    readonly contributions?: Provider<readonly UiContribution[]>;
    readonly schemas?: Provider<Readonly<Record<string, SourceConfigSchema>>>;
    readonly sourcePlugins?: Provider<Readonly<Record<string, string>>>;
    readonly presetPages?: Provider<Readonly<Record<string, string>>>;
    /** Only an exact host allowlist entry grants permission to execute a module. */
    readonly policy?: UiPolicy;
}

async function resolve<T>(
    provider: Provider<T> | undefined,
    empty: T,
): Promise<T> {
    return (typeof provider === "function"
        ? await (provider as () => T | Promise<T>)()
        : provider) ?? empty;
}

/** Live presentation metadata; this never imports or installs plugin modules. */
export function createUiCatalogLoader(options: UiCatalogOptions) {
    const sourcePlugins = () => resolve(options.sourcePlugins, {});
    const declarations = () => resolve(options.contributions, []);
    const loadMetadata = async (): Promise<{
        plugins: readonly ListedPlugin[];
        presets: readonly ListedPreset[];
    }> => {
        const headers = new Headers({ accept: "application/json" });
        if (options.adminAuthToken !== undefined) {
            headers.set(
                "authorization",
                `Bearer ${options.adminAuthToken.trim()}`,
            );
        }
        const response = await options.dispatch(
            new Request("http://localhost/admin/status", {
                headers,
                redirect: "manual",
            }),
        );
        if (!response.ok) {
            await response.body?.cancel();
            throw new WebRequestError(
                502,
                "catalog_unavailable",
                "暂时无法读取插件目录。",
            );
        }
        const value: unknown = JSON.parse(
            await readBoundedBody(
                response.body,
                UI_CATALOG_LIMITS.bytes,
                response.headers.get("content-length"),
            ),
        );
        if (
            value === null || typeof value !== "object" ||
            !Array.isArray((value as Record<string, unknown>).plugins) ||
            !Array.isArray((value as Record<string, unknown>).presets)
        ) {
            throw new WebRequestError(
                502,
                "catalog_unavailable",
                "插件目录格式无效。",
            );
        }
        const status = value as { plugins: unknown[]; presets: unknown[] };
        const plugins = status.plugins.filter(
            (item): item is ListedPlugin =>
                item !== null && typeof item === "object" &&
                typeof (item as Record<string, unknown>).id === "string" &&
                typeof (item as Record<string, unknown>).enabled === "boolean",
        );
        const presets = status.presets.filter(
            (item): item is ListedPreset =>
                item !== null && typeof item === "object" &&
                typeof (item as Record<string, unknown>).id === "string" &&
                typeof (item as Record<string, unknown>).sourcePluginId ===
                    "string",
        );
        return { plugins, presets };
    };
    const load = async (
        plugins?: readonly ListedPlugin[],
        presets?: readonly ListedPreset[],
    ): Promise<UiCatalog> => {
        const [contributions, schemas, sourcePluginIds, presetPages, current] =
            await Promise.all([
                declarations(),
                resolve(options.schemas, {}),
                sourcePlugins(),
                resolve(options.presetPages, {}),
                plugins !== undefined && presets !== undefined
                    ? { plugins, presets }
                    : loadMetadata(),
            ]);
        const enabled = new Set(
            current.plugins.filter((plugin) => plugin.enabled === true)
                .map((plugin) => plugin.id),
        );
        const enabledSources = new Set(
            current.plugins.filter((plugin) =>
                plugin.enabled === true && plugin.kind === "source"
            ).map((plugin) => plugin.id),
        );
        const enabledPresets = new Set(
            current.plugins.filter((plugin) =>
                plugin.enabled === true && plugin.kind === "preset"
            ).map((plugin) => plugin.id),
        );
        const availablePresets = new Set(
            current.presets.filter((preset) =>
                enabledPresets.has(preset.id) &&
                preset.sourcePluginId !== undefined &&
                enabledSources.has(preset.sourcePluginId)
            ).map((preset) => preset.id),
        );
        const trusted = options.policy?.trustedModules ?? {};
        const approvedPages = Object.fromEntries(
            Object.entries(Object.getOwnPropertyDescriptors(presetPages))
                .flatMap(([id, descriptor]) => {
                    const path: unknown = "value" in descriptor
                        ? descriptor.value
                        : undefined;
                    return descriptor.enumerable && availablePresets.has(id) &&
                            safeUiAssetPath(path, "js") &&
                            Object.hasOwn(trusted, `${id}:setup`) &&
                            trusted[`${id}:setup`] === path
                        ? [[id, path]]
                        : [];
                }),
        );
        const parsed = parseUiCatalog({
            contributions,
            schemas,
            sourcePluginIds,
            presetPages: approvedPages,
        });
        return {
            ...parsed,
            contributions: parsed.contributions.filter((item) =>
                enabled.has(item.pluginId)
            ),
        };
    };
    return {
        load,
        sourcePlugins,
        contributions: async () => (await load()).contributions,
    };
}

/** Cookie-authenticated web metadata port; existing bearer APIs stay unchanged. */
export function createUiCatalogRoute(
    session: WebSession,
    load: () => Promise<UiCatalog>,
) {
    return async (context: Context): Promise<Response> => {
        try {
            assertSameOrigin(context.req.raw);
            if (!await session.authorized(context)) {
                throw new WebRequestError(
                    401,
                    "unauthorized",
                    "请先登录后台。",
                );
            }
            return Response.json(await load(), {
                headers: {
                    "cache-control": "no-store",
                    "x-content-type-options": "nosniff",
                },
            });
        } catch (error) {
            return requestError(error);
        }
    };
}
