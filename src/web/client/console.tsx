/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx/dom */
import { type ConsoleProps, useConsoleState } from "./state.ts";
export type { ConsoleProps } from "./state.ts";
import { uiContributionKey } from "@heimdall/admin-contracts/ui.ts";
import { useEffect, useState } from "hono/jsx/dom";
import { syncPluginNavigation } from "./plugin-navigation.ts";
import { ActivityPanel } from "./activity.tsx";
import { SourceCreateDialog } from "./source-create-dialog.tsx";
import { AuthPanel } from "./auth.tsx";
import { ChannelsPanel, OverviewPanel } from "./dashboard.tsx";
import { ClientSlots } from "./extensions/slots.tsx";
import { SourceConfigPanel } from "./forms/source-config-panel.tsx";
import { RuntimeSettingsPanel } from "./settings.tsx";
import { Icon } from "../shared/icons.tsx";
import { consolePageInfo } from "../shared/page-info.ts";
import { dashboardUiContext, sourceUiContext } from "../shared/ui-context.ts";
import {
    sourceConfigSchema,
    sourcePluginIdFor,
} from "../shared/source-schemas.ts";

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
    const [createdName, setCreatedName] = useState("");
    const [toastClosing, setToastClosing] = useState(false);
    function finishToast() {
        setCreatedName("");
        setToastClosing(false);
    }
    useEffect(() => {
        if (!createdName) return;
        if (toastClosing) {
            const reduced = globalThis.matchMedia?.(
                "(prefers-reduced-motion: reduce)",
            ).matches;
            const timer = setTimeout(finishToast, reduced ? 0 : 180);
            return () => clearTimeout(timer);
        }
        const timer = setTimeout(() => setToastClosing(true), 4000);
        return () => clearTimeout(timer);
    }, [createdName, toastClosing]);
    const activeContributions = dashboard.authRequired
        ? []
        : contributions.filter((item) =>
            dashboard.status.plugins.some((plugin) =>
                plugin.id === item.pluginId && plugin.enabled
            )
        );
    const activePlugin = activeContributions.filter((item) =>
        item.slot === "nav.tab" && uiContributionKey(item) === tab
    );
    const pageInfo = consolePageInfo(page, activePlugin[0]?.title);
    useEffect(() => {
        syncPluginNavigation(
            activeContributions,
            page === "plugin" ? tab ?? "" : page,
            document,
        );
    }, [activeContributions, page, tab]);
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
                        {page === "channels" && !dashboard.authRequired && (
                            <button
                                type="button"
                                class="primary-button"
                                onClick={() => {
                                    setCreatedName("");
                                    setToastClosing(false);
                                    setAdding(true);
                                }}
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
                {page === "overview" && (
                    <>
                        <OverviewPanel
                            dashboard={dashboard}
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
                {page === "channels" && !dashboard.authRequired && (
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
                            onAdd={() => setAdding(true)}
                            onConfigure={(id) => setSource({ id })}
                            onRefresh={refresh}
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
                {page === "settings" && !dashboard.authRequired && (
                    <>
                        <RuntimeSettingsPanel
                            initial={initialPanels?.settings}
                            initialError={initialPanels?.errors.settings}
                            onClose={() =>
                                globalThis.location.assign(
                                    "/admin?view=overview",
                                )}
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
                {page === "plugin" && (
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
                    schemas={schemas}
                    presetPages={presetPages}
                    policy={policy}
                    onClose={() => setAdding(false)}
                    onSaved={(draft) => {
                        setAdding(false);
                        setToastClosing(false);
                        setCreatedName(draft.name);
                        void refresh();
                    }}
                />
            )}
            {createdName && (
                <div
                    class={`source-created-toast${
                        toastClosing ? " is-closing" : ""
                    }`}
                    role="status"
                    onAnimationEnd={(event) => {
                        if (
                            event.target === event.currentTarget &&
                            event.animationName === "source-toast-out"
                        ) finishToast();
                    }}
                >
                    <span>已添加渠道「{createdName}」</span>
                    <button
                        type="button"
                        class="icon-button"
                        aria-label="关闭通知"
                        title="关闭通知"
                        onClick={() => setToastClosing(true)}
                    >
                        <Icon name="close" />
                    </button>
                </div>
            )}
        </div>
    );
}
