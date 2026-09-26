/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { type ConsoleProps, useConsoleState } from "./state.ts";
export type { ConsoleProps } from "./state.ts";
import { uiContributionKey } from "@heimdall/admin-contracts/ui.ts";
import { useEffect, useRef, useState } from "hono/jsx/dom";
import { syncPluginNavigation } from "./plugin-navigation.ts";
import { ActivityPanel } from "./activity.tsx";
import { SourceCreateDialog } from "./source-create-dialog.tsx";
import { AuthPanel } from "./auth.tsx";
import { ChannelsPanel, OverviewPanel } from "./dashboard.tsx";
import { ClientSlots } from "./extensions/slots.tsx";
import { SourceConfigPanel } from "./forms/source-config-panel.tsx";
import { RuntimeSettingsPanel } from "./settings.tsx";
import { ProxyPoolPanel } from "./proxy-pool.tsx";
import type { ProxyPoolView } from "@heimdall/admin-contracts/proxies.ts";
import { describeError, loadProxyPool } from "./api/admin.ts";
import { Icon } from "../shared/icons.tsx";
import { type ConsolePage, consolePageInfo } from "../shared/page-info.ts";
import { dashboardUiContext, sourceUiContext } from "../shared/ui-context.ts";
import {
    sourceConfigSchema,
    sourcePluginIdFor,
} from "../shared/source-schemas.ts";
import { ToastStack, useToasts } from "./toasts.tsx";

const CONSOLE_PAGES: readonly ConsolePage[] = [
    "overview",
    "channels",
    "settings",
    "plugin",
];

function parseConsoleView(url: URL): ConsolePage | undefined {
    const view = url.searchParams.get("view") ?? "overview";
    return (CONSOLE_PAGES as readonly string[]).includes(view)
        ? view as ConsolePage
        : undefined;
}

export function Console(
    {
        initial,
        initialPanels,
        page = "overview",
        tab,
        contributions: initialContributions,
        sourcePluginIds: initialSourcePluginIds,
        schemas: initialSchemas,
        presetPages: initialPresetPages,
        policy,
        onAction,
        authenticated = false,
        onConnect,
        onLogout,
        loadUiCatalog,
    }: ConsoleProps,
) {
    const {
        contributions,
        schemas,
        presetPages,
        sourcePluginIds,
        dashboard,
        loading,
        refreshError,
        revision,
        authOpen,
        setAuthOpen,
        authBusy,
        authError,
        connected,
        source,
        setSource,
        adding,
        setAdding,
        theme,
        setTheme,
        refresh,
        connect,
        logout,
    } = useConsoleState({
        initial,
        authenticated,
        onConnect,
        onLogout,
        loadUiCatalog,
        contributions: initialContributions,
        sourcePluginIds: initialSourcePluginIds,
        schemas: initialSchemas,
        presetPages: initialPresetPages,
    });
    const { toasts, push, dismiss, remove } = useToasts();
    // Page switching stays inside the document (like the original console);
    // the SSR nav links keep working without JavaScript.
    const [activePage, setActivePage] = useState<ConsolePage>(page);
    const [activeTab, setActiveTab] = useState(tab);
    const [proxyPool, setProxyPool] = useState<ProxyPoolView | null>(
        initialPanels?.proxies?.pool ?? null,
    );
    const [proxyError, setProxyError] = useState(
        initialPanels?.errors.proxies ?? "",
    );
    const refreshRef = useRef(refresh);
    refreshRef.current = refresh;

    useEffect(() => {
        const onClick = (event: MouseEvent) => {
            if (
                event.defaultPrevented || event.button !== 0 ||
                event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
            ) return;
            const target = event.target as Element | null;
            const link = target?.closest?.("a") ?? null;
            if (
                !link ||
                !(link.getAttribute("class") ?? "").includes("admin-nav-link")
            ) return;
            const href = link.getAttribute("href") ?? "";
            const url = new URL(href, globalThis.location.href);
            if (url.origin !== new URL(globalThis.location.href).origin) return;
            if (url.pathname !== "/admin") return;
            const view = parseConsoleView(url);
            if (!view) return;
            event.preventDefault();
            globalThis.history.replaceState(
                null,
                "",
                url.pathname + url.search,
            );
            setActivePage(view);
            setActiveTab(url.searchParams.get("tab") ?? undefined);
        };
        document.addEventListener("click", onClick);
        return () => document.removeEventListener("click", onClick);
    }, []);

    const activeContributions = dashboard.authRequired
        ? []
        : contributions.filter((item) =>
            dashboard.status.plugins.some((plugin) =>
                plugin.id === item.pluginId && plugin.enabled
            )
        );
    const activePlugin = activeContributions.filter((item) =>
        item.slot === "nav.tab" && uiContributionKey(item) === activeTab
    );
    const pageInfo = consolePageInfo(activePage, activePlugin[0]?.title);
    // Mirror the client-side page onto the SSR nav links.
    useEffect(() => {
        const key = activePage === "plugin"
            ? activeTab ?? "plugin"
            : activePage;
        for (const link of document.querySelectorAll("a")) {
            const classes = (link.getAttribute("class") ?? "")
                .split(/\s+/)
                .filter(Boolean);
            if (!classes.includes("admin-nav-link")) continue;
            const href = link.getAttribute("href") ?? "";
            let url: URL;
            try {
                url = new URL(href, globalThis.location.href);
            } catch {
                continue;
            }
            const view = parseConsoleView(url);
            const linkKey = view === "plugin"
                ? url.searchParams.get("tab") ?? "plugin"
                : view;
            const isActive = url.pathname === "/admin" && linkKey === key;
            const next = new Set(classes);
            if (isActive) {
                next.add("active");
                link.setAttribute("aria-current", "page");
            } else {
                next.delete("active");
                link.removeAttribute("aria-current");
            }
            link.setAttribute("class", [...next].join(" "));
        }
    }, [activePage, activeTab]);
    useEffect(() => {
        syncPluginNavigation(
            activeContributions,
            activePage === "plugin" ? activeTab ?? "" : activePage,
            document,
        );
    }, [activeContributions, activePage, activeTab]);

    // "/" jumps to the channel search, "r" refreshes — original console habits.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (
                event.defaultPrevented || event.ctrlKey || event.metaKey ||
                event.altKey
            ) return;
            const target = event.target as HTMLElement | null;
            if (
                target?.closest(
                    "input, textarea, select, [contenteditable], dialog",
                )
            ) return;
            if (document.querySelector("dialog[open]")) return;
            if (event.key === "/") {
                event.preventDefault();
                globalThis.history.replaceState(
                    null,
                    "",
                    "/admin?view=channels",
                );
                setActivePage("channels");
                queueMicrotask(() =>
                    document.getElementById("channel-search")?.focus()
                );
            } else if (event.key === "r") {
                event.preventDefault();
                void refreshRef.current?.({ silent: true });
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, []);

    // Poll like the original console: every 30s, only while the tab is visible.
    useEffect(() => {
        if (dashboard.authRequired || activePage !== "overview") return;
        const tick = () => {
            if (document.visibilityState === "visible") {
                void refreshRef.current?.({ silent: true });
            }
        };
        const timer = globalThis.setInterval(tick, 30000);
        const onVisible = () => {
            if (document.visibilityState === "visible") tick();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            globalThis.clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [dashboard.authRequired, activePage]);

    useEffect(() => {
        if (dashboard.authRequired) {
            setProxyPool(null);
            setProxyError("");
            return;
        }
        // The settings panel owns its editable snapshot and conflict recovery.
        // Channel selectors follow fresh pool data without changing their choice.
        if (activePage !== "channels" && activePage !== "overview") return;
        if (revision === 0 && initialPanels?.proxies) return;
        let active = true;
        void loadProxyPool().then((result) => {
            if (!active) return;
            setProxyPool(result.pool);
            setProxyError("");
        }, (cause) => {
            if (!active) return;
            setProxyPool(null);
            setProxyError(`读取代理池失败：${describeError(cause)}`);
        });
        return () => {
            active = false;
        };
    }, [activePage, revision, dashboard.authRequired]);

    const context = dashboardUiContext(dashboard, theme);
    const pluginIdFor = (id: string) =>
        sourcePluginIds[id] ?? sourcePluginIdFor(id) ??
            (schemas[id] ? id : undefined);
    const schemaFor = (id: string) => {
        const pluginId = pluginIdFor(id);
        if (pluginId && schemas[pluginId]) return schemas[pluginId];
        const fallback = sourceConfigSchema(pluginId ?? id);
        return fallback.fields.length ? fallback : undefined;
    };

    return (
        <div class="console-content">
            <div class="console-toolbar">
                <span class="breadcrumb">
                    管理端 / {pageInfo.label}
                </span>
                <div class="topbar-actions">
                    <button
                        type="button"
                        class="icon-button"
                        onClick={() =>
                            setTheme(theme === "dark" ? "light" : "dark")}
                        aria-label={`切换到${
                            theme === "dark" ? "浅色" : "深色"
                        }主题`}
                        title={`切换到${
                            theme === "dark" ? "浅色" : "深色"
                        }主题`}
                    >
                        <Icon name={theme === "dark" ? "sun" : "moon"} />
                    </button>
                    <button
                        type="button"
                        class="icon-button"
                        disabled={authBusy}
                        aria-label="管理令牌"
                        title="管理令牌"
                        aria-expanded={authOpen || dashboard.authRequired}
                        onClick={() => setAuthOpen((value) => !value)}
                    >
                        <Icon name="key" />
                    </button>
                    {connected && (
                        <button
                            type="button"
                            class="icon-button"
                            disabled={authBusy}
                            aria-label="退出登录"
                            title="退出登录"
                            onClick={() => void logout()}
                        >
                            <Icon name="log-out" />
                        </button>
                    )}
                </div>
            </div>
            <div class="console-panels" aria-busy={loading ? "true" : "false"}>
                <div class="page-heading">
                    <div>
                        <p class="eyebrow">工作空间</p>
                        <h1>
                            {pageInfo.label}
                        </h1>
                        <p>
                            {pageInfo.description}
                        </p>
                    </div>
                    <div class="config-actions">
                        {activePage === "channels" && !dashboard.authRequired &&
                            (
                                <button
                                    type="button"
                                    class="primary-button"
                                    onClick={() => setAdding(true)}
                                >
                                    <Icon name="plus" />
                                    添加渠道
                                </button>
                            )}
                        <button
                            type="button"
                            class="icon-button"
                            disabled={loading}
                            aria-label={loading ? "刷新中…" : "刷新"}
                            title={loading ? "刷新中…" : "刷新"}
                            onClick={() => void refresh()}
                        >
                            <Icon name="refresh" />
                        </button>
                    </div>
                </div>
                {(authOpen || dashboard.authRequired) && (
                    <AuthPanel
                        busy={authBusy}
                        error={authError}
                        onConnect={connect}
                        onClose={dashboard.authRequired
                            ? undefined
                            : () => setAuthOpen(false)}
                    />
                )}
                {refreshError && (
                    <p class="form-error" role="alert">{refreshError}</p>
                )}
                {loading && !initial && revision === 0 && (
                    <p role="status" class="notice">正在加载实例数据…</p>
                )}
                {activePage === "overview" && (
                    <>
                        <OverviewPanel
                            dashboard={dashboard}
                            revision={revision}
                            initialActivity={initialPanels}
                            proxyPool={proxyPool}
                            onRefresh={refresh}
                            widgets={
                                <ClientSlots
                                    slot="dashboard.widget"
                                    contributions={activeContributions}
                                    context={context}
                                    policy={policy}
                                    onAction={onAction}
                                />
                            }
                        />
                        {!dashboard.authRequired && (
                            <ActivityPanel
                                revision={revision}
                                initial={initialPanels}
                            />
                        )}
                    </>
                )}
                {activePage === "channels" && !dashboard.authRequired && (
                    <>
                        {source && (
                            <SourceConfigPanel
                                key={`${source.id}:${source.presetId ?? ""}`}
                                sourceId={source.id}
                                sourcePluginId={pluginIdFor(source.id)}
                                schema={schemaFor(source.id)}
                                presetSchemas={schemas}
                                presetId={source.presetId}
                                presets={dashboard.status.presets}
                                onClose={() => setSource(null)}
                                onSaved={refresh}
                            />
                        )}
                        <ChannelsPanel
                            dashboard={dashboard}
                            proxyPool={proxyPool}
                            proxyError={proxyError}
                            onAdd={() => setAdding(true)}
                            onConfigure={(id) => setSource({ id })}
                            onRefresh={refresh}
                            onNotify={push}
                            canConfigure={(id) => Boolean(schemaFor(id))}
                            sourceStatus={(item) =>
                                item.id && (
                                    <ClientSlots
                                        slot="source.status"
                                        contributions={activeContributions}
                                        policy={policy}
                                        onAction={onAction}
                                        context={sourceUiContext(
                                            context,
                                            item,
                                            pluginIdFor(item.id),
                                        )}
                                    />
                                )}
                        />
                    </>
                )}
                {activePage === "settings" && !dashboard.authRequired && (
                    <>
                        <RuntimeSettingsPanel
                            initial={initialPanels?.settings}
                            initialError={initialPanels?.errors.settings}
                        />
                        <ProxyPoolPanel
                            initial={initialPanels?.proxies}
                            initialError={initialPanels?.errors.proxies}
                            onChanged={setProxyPool}
                        />
                        <ClientSlots
                            slot="settings.section"
                            contributions={activeContributions}
                            context={context}
                            policy={policy}
                            onAction={onAction}
                        />
                    </>
                )}
                {activePage === "plugin" && (
                    <>
                        {activePlugin.length
                            ? (
                                <ClientSlots
                                    slot="nav.tab"
                                    contributions={activePlugin}
                                    context={context}
                                    policy={policy}
                                    onAction={onAction}
                                />
                            )
                            : (
                                <section class="panel">
                                    <h2>插件页面不可用</h2>
                                    <p>当前实例未提供此页面。</p>
                                </section>
                            )}
                    </>
                )}
            </div>
            {adding && !dashboard.authRequired && (
                <SourceCreateDialog
                    dashboard={dashboard}
                    proxyPool={proxyPool}
                    schemas={schemas}
                    presetPages={presetPages}
                    policy={policy}
                    onClose={() => setAdding(false)}
                    onSaved={(draft) => {
                        setAdding(false);
                        push("ok", `已添加渠道「${draft.name}」`);
                        void refresh();
                    }}
                />
            )}
            <ToastStack toasts={toasts} dismiss={dismiss} remove={remove} />
        </div>
    );
}
