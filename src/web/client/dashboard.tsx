/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import type { DashboardData, ListedSource } from "./api/admin.ts";
import { updateSource } from "./api/admin.ts";
import type { Child } from "hono/jsx";
import { PluginsPanel } from "./plugins.tsx";
import { ModelDirectory, SourceCard } from "./catalog.tsx";
import {
    SourceManagementDialog,
    sourceManagementError,
} from "./source-management.tsx";
import { sourceInstanceEnabled } from "../shared/catalog-presentation.ts";
import { Icon } from "../shared/icons.tsx";

interface ChannelsProps {
    dashboard: DashboardData;
    onAdd?: () => void;
    onConfigure: (id: string) => void;
    onRefresh: () => Promise<void>;
    sourceStatus?: (source: ListedSource) => Child;
    canConfigure?: (id: string) => boolean;
}

function ErrorMessage({ message }: { message: string }) {
    return message ? <p class="form-error" role="alert">{message}</p> : null;
}

export function OverviewPanel({ dashboard, onRefresh, widgets }: {
    dashboard: DashboardData;
    onRefresh: () => Promise<void>;
    widgets?: Child;
}) {
    if (dashboard.authRequired) return null;
    const { sources, plugins } = dashboard.status;
    const healthy = dashboard.health.status === "ok";
    const activeSources = sources.filter((source) => source.enabled).length;
    const activePlugins =
        plugins.filter((plugin) => plugin.enabled && !plugin.lastError).length;
    return (
        <>
            <section class="stats-grid" aria-label="实例概况">
                <article class="stat-card">
                    <h2>服务健康</h2>
                    <strong>{healthy ? "正常" : "需要检查"}</strong>
                    <p>{healthy ? "服务正在接受请求" : "请检查服务状态"}</p>
                    <ErrorMessage message={dashboard.errors.health} />
                </article>
                <article class="stat-card">
                    <h2>已启用渠道</h2>
                    <strong>{activeSources}</strong>
                    <p>共 {sources.length} 个渠道</p>
                </article>
                <article class="stat-card">
                    <h2>可用模型</h2>
                    <strong>{dashboard.models.length}</strong>
                    <p>当前可调用</p>
                </article>
                <article class="stat-card">
                    <h2>运行中插件</h2>
                    <strong>{activePlugins}</strong>
                    <p>共 {plugins.length} 个插件</p>
                </article>
            </section>
            {widgets}
            <section
                class="catalog-section"
                aria-labelledby="source-overview-title"
            >
                <div class="panel-heading">
                    <div>
                        <h2 id="source-overview-title">渠道状态</h2>
                        <p>上游连接与最近探测</p>
                    </div>
                    <a class="section-link" href="/admin?view=channels">
                        管理渠道 <span aria-hidden="true">→</span>
                    </a>
                </div>
                <ErrorMessage message={dashboard.errors.source} />
                {sources.length
                    ? (
                        <div class="source-cards source-cards-compact">
                            {sources.slice(0, 3).map((source, index) => (
                                <SourceCard
                                    key={source.id ?? index}
                                    source={source}
                                />
                            ))}
                        </div>
                    )
                    : (
                        <div class="panel empty-state">
                            <p>
                                尚未配置渠道，从预设或自定义参数开始连接上游。
                            </p>
                            <a class="section-link" href="/admin?view=channels">
                                配置第一个渠道 →
                            </a>
                        </div>
                    )}
                {sources.length > 3 && (
                    <p class="section-hint">
                        显示 3 个渠道，<a href="/admin?view=channels">
                            查看全部 {sources.length} 个
                        </a>
                    </p>
                )}
            </section>
            <PluginsPanel
                plugins={plugins}
                loadError={dashboard.errors.status}
                onRefresh={onRefresh}
            />
            <ModelDirectory
                models={dashboard.models}
                error={dashboard.errors.models}
            />
        </>
    );
}

export function ChannelsPanel(
    {
        dashboard,
        onAdd,
        onConfigure,
        onRefresh,
        sourceStatus,
        canConfigure = () => true,
    }: ChannelsProps,
) {
    const { sources, plugins } = dashboard.status;
    const [selected, setSelected] = useState<ListedSource | null>(null);
    const [pendingId, setPendingId] = useState("");
    const [actionError, setActionError] = useState("");
    const [message, setMessage] = useState("");
    const pending = useRef(false);
    const mounted = useRef(true);
    const heading = useRef<HTMLHeadingElement | null>(null);
    const focusListAfterClose = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    useEffect(() => {
        if (!selected && focusListAfterClose.current) {
            focusListAfterClose.current = false;
            heading.current?.focus();
        }
    }, [selected]);

    async function refreshAfterChange(result: string) {
        if (mounted.current) {
            setMessage(result);
            setActionError("");
        }
        try {
            await onRefresh();
        } catch (caught) {
            if (mounted.current) {
                setActionError(
                    `${result ? "操作已完成，列表刷新失败" : "刷新列表失败"}：${
                        sourceManagementError(caught)
                    }`,
                );
            }
        }
    }

    async function toggle(source: ListedSource) {
        if (pending.current || !source.id) return;
        pending.current = true;
        setPendingId(source.id);
        setActionError("");
        setMessage("");
        const enabled = !sourceInstanceEnabled(source);
        try {
            await updateSource(source.id, { enabled }, source.versionstamp);
            await refreshAfterChange(
                `已${enabled ? "启用" : "停用"} ${source.name || source.id}。`,
            );
        } catch (caught) {
            if (mounted.current) setActionError(sourceManagementError(caught));
        } finally {
            pending.current = false;
            if (mounted.current) setPendingId("");
        }
    }
    return (
        <>
            <section class="catalog-section" aria-labelledby="sources-title">
                <div class="panel-heading">
                    <div>
                        <h2 id="sources-title" ref={heading} tabIndex={-1}>
                            上游渠道
                        </h2>
                    </div>
                    <span class="panel-count">{sources.length} 个渠道</span>
                </div>
                <ErrorMessage
                    message={dashboard.errors.source || dashboard.errors.status}
                />
                <ErrorMessage message={actionError} />
                {message && (
                    <p class="notice source-management-notice" role="status">
                        {message}
                    </p>
                )}
                {actionError && (
                    <button
                        class="icon-button source-refresh-button"
                        type="button"
                        aria-label="刷新渠道列表"
                        title="刷新渠道列表"
                        disabled={Boolean(pendingId)}
                        onClick={() => void refreshAfterChange("")}
                    >
                        <Icon name="refresh" />
                    </button>
                )}
                {sources.length
                    ? (
                        <div class="source-cards">
                            {sources.map((source, index) => (
                                <SourceCard
                                    key={source.id ?? index}
                                    source={source}
                                    onConfigure={onConfigure}
                                    onManage={setSelected}
                                    onToggle={(item) => void toggle(item)}
                                    pending={Boolean(pendingId)}
                                    status={sourceStatus?.(source)}
                                    configurable={Boolean(
                                        source.id && canConfigure(source.id),
                                    )}
                                />
                            ))}
                        </div>
                    )
                    : (
                        <div class="panel empty-state">
                            <h3>连接第一个上游渠道</h3>
                            <p>
                                从预设或自定义参数开始，配置后即可查看健康状态。
                            </p>
                            <button
                                class="primary-button"
                                type="button"
                                disabled={!onAdd}
                                title={onAdd ? undefined : "交互加载后可用"}
                                onClick={onAdd}
                            >
                                <Icon name="plus" />
                                添加渠道
                            </button>
                        </div>
                    )}
            </section>
            <a class="section-link" href="/admin?view=overview#plugins">
                查看 {plugins.length} 个已注册插件及运行状态{" "}
                <span aria-hidden="true">→</span>
            </a>
            {selected && (
                <SourceManagementDialog
                    key={selected.id}
                    source={selected}
                    onClose={() => setSelected(null)}
                    onChanged={(kind, source) => {
                        focusListAfterClose.current = kind === "deleted";
                        void refreshAfterChange(
                            `已${kind === "saved" ? "保存" : "删除"} ${
                                source.name || source.id
                            }。`,
                        );
                    }}
                />
            )}
        </>
    );
}
