/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import type { DashboardData, ListedSource } from "./api/admin.ts";
import type { ProxyPoolView } from "@heimdall/admin-contracts/proxies.ts";
import type { ConsoleSnapshot } from "@heimdall/admin-contracts/console.ts";
import { updateSource } from "./api/admin.ts";
import type { Child } from "hono/jsx";
import { PluginsPanel } from "./plugins.tsx";
import { ModelDirectory, SourceCard } from "./catalog.tsx";
import {
    SourceManagementDialog,
    sourceManagementError,
} from "./source-management.tsx";
import {
    sourceAvailabilityText,
    sourceInstanceEnabled,
    sourceState,
} from "../shared/catalog-presentation.ts";
import { Icon } from "../shared/icons.tsx";
import { useStats } from "./use-stats.ts";
import { StatsPanels } from "../shared/stats-panels.tsx";

type ActivityInitial = Pick<
    ConsoleSnapshot,
    "usage" | "requests" | "errors" | "stats"
>;

interface ChannelsProps {
    dashboard: DashboardData;
    proxyPool?: ProxyPoolView | null;
    proxyError?: string;
    onAdd?: () => void;
    onConfigure: (id: string) => void;
    onRefresh: () => Promise<void>;
    onNotify?: (tone: "ok" | "warn" | "info", message: string) => void;
    sourceStatus?: (source: ListedSource) => Child;
    canConfigure?: (id: string) => boolean;
}

function ErrorMessage({ message }: { message: string }) {
    return message ? <p class="form-error" role="alert">{message}</p> : null;
}

export function OverviewPanel(
    { dashboard, revision, initialActivity, onRefresh, widgets, proxyPool }: {
        dashboard: DashboardData;
        revision: number;
        initialActivity?: ActivityInitial;
        proxyPool?: ProxyPoolView | null;
        onRefresh: () => Promise<void>;
        widgets?: Child;
    },
) {
    if (dashboard.authRequired) return null;
    return (
        <OverviewBody
            dashboard={dashboard}
            revision={revision}
            initialActivity={initialActivity}
            onRefresh={onRefresh}
            widgets={widgets}
            proxyPool={proxyPool}
        />
    );
}

function OverviewBody(
    { dashboard, revision, initialActivity, onRefresh, widgets, proxyPool }: {
        dashboard: DashboardData;
        revision: number;
        initialActivity?: ActivityInitial;
        proxyPool?: ProxyPoolView | null;
        onRefresh: () => Promise<void>;
        widgets?: Child;
    },
) {
    const { sources, plugins } = dashboard.status;
    const healthy = dashboard.health.status === "ok";
    const activeSources = sources.filter((source) => source.enabled).length;
    const activePlugins =
        plugins.filter((plugin) => plugin.enabled && !plugin.lastError).length;
    const troubled = sources.filter((source) => {
        const state = sourceState(source);
        return state.tone === "amber";
    }).length;
    const statistics = useStats(revision, initialActivity?.stats);
    return (
        <>
            <div class="overview-chips" aria-label="实例概况">
                <span
                    class={`overview-chip ${
                        healthy ? "chip-ok" : "chip-alert"
                    }`}
                >
                    {healthy ? "服务正常" : "服务异常"}
                </span>
                <span class="overview-chip">
                    渠道 {activeSources}/{sources.length}
                </span>
                {troubled > 0 && (
                    <span class="overview-chip chip-alert">
                        {troubled} 个渠道异常
                    </span>
                )}
                <span class="overview-chip">
                    模型 {dashboard.models.length}
                </span>
                <span class="overview-chip">
                    插件 {activePlugins}/{plugins.length}
                </span>
            </div>
            <StatsPanels stats={statistics} loading={statistics.loading} />
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
                        管理渠道 <Icon name="arrow-right" size={16} />
                    </a>
                </div>
                <ErrorMessage message={dashboard.errors.source} />
                {sources.length
                    ? (
                        <div class="source-cards source-cards-compact">
                            {sources.map((source, index) => (
                                <SourceCard
                                    key={source.id ?? index}
                                    source={source}
                                    proxyPool={proxyPool}
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
                                配置第一个渠道{" "}
                                <Icon name="arrow-right" size={16} />
                            </a>
                        </div>
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

type ChannelSortKey = "name" | "priority" | "state";
type ChannelSortDir = "asc" | "desc";

interface ChannelViewPrefs {
    query: string;
    status: string;
    type: string;
    sortKey: ChannelSortKey;
    sortDir: ChannelSortDir;
}

const CHANNEL_PREFS_KEY = "heimdall.console.channels";
const CHANNEL_STATUS_ORDER = [
    "探测异常",
    "冷却中",
    "可用",
    "已启用",
    "插件已停用",
    "已停用",
];
const CHANNEL_STATUS_OPTIONS = [
    "全部",
    "可用",
    "已启用",
    "冷却中",
    "探测异常",
    "已停用",
    "插件已停用",
];

function loadChannelPrefs(): ChannelViewPrefs {
    const fallback: ChannelViewPrefs = {
        query: "",
        status: "全部",
        type: "全部",
        sortKey: "priority",
        sortDir: "asc",
    };
    try {
        const raw = globalThis.localStorage?.getItem(CHANNEL_PREFS_KEY);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw) as Partial<ChannelViewPrefs>;
        return {
            query: typeof parsed.query === "string" ? parsed.query : "",
            status: typeof parsed.status === "string"
                ? parsed.status
                : fallback.status,
            type: typeof parsed.type === "string" ? parsed.type : fallback.type,
            sortKey: parsed.sortKey === "name" || parsed.sortKey === "state" ||
                    parsed.sortKey === "priority"
                ? parsed.sortKey
                : fallback.sortKey,
            sortDir: parsed.sortDir === "desc" ? "desc" : "asc",
        };
    } catch {
        return fallback;
    }
}

function saveChannelPrefs(prefs: ChannelViewPrefs) {
    try {
        globalThis.localStorage?.setItem(
            CHANNEL_PREFS_KEY,
            JSON.stringify(prefs),
        );
    } catch { /* Preference persistence is optional. */ }
}

function haystack(source: ListedSource): string {
    return [
        source.name,
        source.id,
        source.sourcePluginId,
        source.priority?.toString(),
        sourceState(source).label,
        sourceAvailabilityText(source),
    ].filter(Boolean).join(" ").toLowerCase();
}

function sortSources(
    sources: readonly ListedSource[],
    sortKey: ChannelSortKey,
    sortDir: ChannelSortDir,
): ListedSource[] {
    const direction = sortDir === "asc" ? 1 : -1;
    return [...sources].sort((a, b) => {
        if (sortKey === "name") {
            return direction * (a.name || a.id || "").localeCompare(
                b.name || b.id || "",
                "zh-Hans-CN",
            );
        }
        if (sortKey === "priority") {
            const left = a.priority ?? Number.POSITIVE_INFINITY;
            const right = b.priority ?? Number.POSITIVE_INFINITY;
            if (left !== right) return direction * (left - right);
            return (a.name || a.id || "").localeCompare(
                b.name || b.id || "",
                "zh-Hans-CN",
            );
        }
        const left = CHANNEL_STATUS_ORDER.indexOf(sourceState(a).label);
        const right = CHANNEL_STATUS_ORDER.indexOf(sourceState(b).label);
        if (left !== right) return direction * (left - right);
        return (a.name || a.id || "").localeCompare(
            b.name || b.id || "",
            "zh-Hans-CN",
        );
    });
}

function SortHeader(
    { label, sortKey, sort, onSort }: {
        label: string;
        sortKey: ChannelSortKey;
        sort: { key: ChannelSortKey; dir: ChannelSortDir };
        onSort: (key: ChannelSortKey) => void;
    },
) {
    const active = sort.key === sortKey;
    return (
        <th
            scope="col"
            aria-sort={active
                ? (sort.dir === "asc" ? "ascending" : "descending")
                : undefined}
        >
            <button
                type="button"
                class={`channel-sort${active ? " is-active" : ""}`}
                onClick={() => onSort(sortKey)}
                title={`按${label}排序`}
            >
                {label}
                <span class="channel-sort-arrow" aria-hidden="true">
                    {active ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}
                </span>
            </button>
        </th>
    );
}

export function ChannelsPanel(
    {
        dashboard,
        proxyPool,
        proxyError,
        onAdd,
        onConfigure,
        onRefresh,
        onNotify,
        sourceStatus,
        canConfigure = () => true,
    }: ChannelsProps,
) {
    const { sources, plugins } = dashboard.status;
    const [selected, setSelected] = useState<ListedSource | null>(null);
    const [pendingId, setPendingId] = useState("");
    const [actionError, setActionError] = useState("");
    const pending = useRef(false);
    const mounted = useRef(true);
    const heading = useRef<HTMLHeadingElement | null>(null);
    const focusListAfterClose = useRef(false);
    const [prefs, setPrefs] = useState<ChannelViewPrefs>(loadChannelPrefs);
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
    function updatePrefs(patch: Partial<ChannelViewPrefs>) {
        setPrefs((current) => {
            const next = { ...current, ...patch };
            saveChannelPrefs(next);
            return next;
        });
    }
    function setSort(sortKey: ChannelSortKey) {
        updatePrefs({
            sortKey,
            sortDir: prefs.sortKey === sortKey && prefs.sortDir === "asc"
                ? "desc"
                : "asc",
        });
    }

    const types = [
        ...new Set(
            sources
                .map((source) => source.sourcePluginId)
                .filter((value): value is string => Boolean(value)),
        ),
    ].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
    const query = prefs.query.trim().toLowerCase();
    const visible = sortSources(
        sources.filter((source) => {
            if (
                prefs.status !== "全部" &&
                sourceState(source).label !== prefs.status
            ) {
                return false;
            }
            if (prefs.type !== "全部" && source.sourcePluginId !== prefs.type) {
                return false;
            }
            if (query && !haystack(source).includes(query)) return false;
            return true;
        }),
        prefs.sortKey,
        prefs.sortDir,
    );

    async function refreshAfterChange(result: string) {
        if (mounted.current && result) onNotify?.("ok", result);
        try {
            await onRefresh();
        } catch (caught) {
            if (mounted.current) {
                onNotify?.(
                    "warn",
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
        const enabled = !sourceInstanceEnabled(source);
        try {
            await updateSource(source.id, { enabled }, source.versionstamp);
            await refreshAfterChange(
                `已${enabled ? "启用" : "停用"} ${source.name || source.id}。`,
            );
        } catch (caught) {
            if (mounted.current) {
                setActionError(sourceManagementError(caught));
                onNotify?.("warn", sourceManagementError(caught));
            }
        } finally {
            pending.current = false;
            if (mounted.current) setPendingId("");
        }
    }
    const sort = { key: prefs.sortKey, dir: prefs.sortDir };
    return (
        <>
            <section class="catalog-section" aria-labelledby="sources-title">
                <div class="panel-heading">
                    <div>
                        <h2 id="sources-title" ref={heading} tabIndex={-1}>
                            上游渠道
                        </h2>
                    </div>
                    <span class="panel-count">
                        显示 {visible.length} / {sources.length} 个渠道
                    </span>
                </div>
                <ErrorMessage
                    message={dashboard.errors.source || dashboard.errors.status}
                />
                <ErrorMessage message={actionError} />
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
                {proxyError && <ErrorMessage message={proxyError} />}
                <div class="channels-toolbar">
                    <div class="channels-search">
                        <Icon name="search" size={15} />
                        <input
                            id="channel-search"
                            type="search"
                            placeholder="搜索渠道名称、ID、类型或备注…"
                            aria-label="搜索渠道"
                            value={prefs.query}
                            onInput={(event) =>
                                updatePrefs({
                                    query: (event
                                        .currentTarget as HTMLInputElement)
                                        .value,
                                })}
                        />
                    </div>
                    <select
                        aria-label="按状态筛选"
                        value={prefs.status}
                        onChange={(event) =>
                            updatePrefs({
                                status:
                                    (event.currentTarget as HTMLSelectElement)
                                        .value,
                            })}
                    >
                        {CHANNEL_STATUS_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                                {option === "全部" ? "全部状态" : option}
                            </option>
                        ))}
                    </select>
                    <select
                        aria-label="按类型筛选"
                        value={prefs.type}
                        onChange={(event) =>
                            updatePrefs({
                                type: (event.currentTarget as HTMLSelectElement)
                                    .value,
                            })}
                    >
                        <option value="全部">全部类型</option>
                        {types.map((type) => (
                            <option key={type} value={type}>{type}</option>
                        ))}
                    </select>
                </div>
                {sources.length
                    ? (
                        <>
                            <div class="table-wrap channels-table-wrap desktop-only">
                                <table class="request-table channels-table">
                                    <caption class="sr-only">上游渠道</caption>
                                    <thead>
                                        <tr>
                                            <SortHeader
                                                label="名称"
                                                sortKey="name"
                                                sort={sort}
                                                onSort={setSort}
                                            />
                                            <th scope="col">类型</th>
                                            <SortHeader
                                                label="优先级"
                                                sortKey="priority"
                                                sort={sort}
                                                onSort={setSort}
                                            />
                                            <SortHeader
                                                label="状态"
                                                sortKey="state"
                                                sort={sort}
                                                onSort={setSort}
                                            />
                                            <th
                                                scope="col"
                                                class="channel-actions-col"
                                            >
                                                操作
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {visible.map((source, index) => {
                                            const state = sourceState(source);
                                            const id = source.id || "";
                                            return (
                                                <tr
                                                    key={id || index}
                                                    class={`channels-row row-tone-${state.tone}`}
                                                >
                                                    <td class="channels-name">
                                                        <strong
                                                            title={source
                                                                .name ||
                                                                id}
                                                        >
                                                            {source.name ||
                                                                id ||
                                                                "未命名渠道"}
                                                        </strong>
                                                        <code title={id}>
                                                            {id}
                                                        </code>
                                                    </td>
                                                    <td>
                                                        <span class="plugin-chip">
                                                            {source
                                                                .sourcePluginId ||
                                                                "—"}
                                                        </span>
                                                    </td>
                                                    <td class="channels-priority">
                                                        {source.priority !==
                                                                undefined
                                                            ? `P${source.priority}`
                                                            : "—"}
                                                    </td>
                                                    <td class="channels-state">
                                                        <span
                                                            class={`status-chip chip-${state.tone}`}
                                                        >
                                                            {state.label}
                                                        </span>
                                                        <small
                                                            title={sourceAvailabilityText(
                                                                source,
                                                            )}
                                                        >
                                                            {sourceAvailabilityText(
                                                                source,
                                                            )}
                                                        </small>
                                                    </td>
                                                    <td class="channel-actions-col">
                                                        <div
                                                            class="channel-row-actions"
                                                            role="group"
                                                            aria-label={`操作 ${
                                                                source.name ||
                                                                id ||
                                                                "渠道"
                                                            }`}
                                                        >
                                                            <button
                                                                type="button"
                                                                class="icon-button"
                                                                disabled={Boolean(
                                                                    pendingId,
                                                                ) || !id}
                                                                aria-label={`${
                                                                    sourceInstanceEnabled(
                                                                            source,
                                                                        )
                                                                        ? "停用"
                                                                        : "启用"
                                                                } ${
                                                                    source
                                                                        .name ||
                                                                    id
                                                                }`}
                                                                title={sourceInstanceEnabled(
                                                                        source,
                                                                    )
                                                                    ? "停用"
                                                                    : "启用"}
                                                                onClick={() =>
                                                                    void toggle(
                                                                        source,
                                                                    )}
                                                            >
                                                                <Icon name="power" />
                                                            </button>
                                                            <button
                                                                type="button"
                                                                class="icon-button"
                                                                disabled={Boolean(
                                                                    pendingId,
                                                                ) || !id}
                                                                aria-label={`管理 ${
                                                                    source
                                                                        .name ||
                                                                    id
                                                                }`}
                                                                title="管理（重命名、优先级、代理、删除）"
                                                                onClick={() =>
                                                                    setSelected(
                                                                        source,
                                                                    )}
                                                            >
                                                                <Icon name="edit" />
                                                            </button>
                                                            <button
                                                                type="button"
                                                                class="icon-button"
                                                                disabled={Boolean(
                                                                    pendingId,
                                                                ) || !id ||
                                                                    !canConfigure(
                                                                        id,
                                                                    )}
                                                                aria-label={`配置 ${id}`}
                                                                title={canConfigure(
                                                                        id,
                                                                    )
                                                                    ? "配置上游连接参数"
                                                                    : "此渠道尚未声明配置表单"}
                                                                onClick={() =>
                                                                    id &&
                                                                    canConfigure(
                                                                        id,
                                                                    ) &&
                                                                    onConfigure(
                                                                        id,
                                                                    )}
                                                            >
                                                                <Icon name="settings" />
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                        {!visible.length && (
                                            <tr>
                                                <td colSpan={5}>
                                                    <p class="empty-state">
                                                        没有符合筛选条件的渠道。
                                                    </p>
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                            <div class="source-cards mobile-only">
                                {visible.map((source, index) => (
                                    <SourceCard
                                        key={source.id ?? index}
                                        source={source}
                                        proxyPool={proxyPool}
                                        onConfigure={onConfigure}
                                        onManage={setSelected}
                                        onToggle={(item) => void toggle(item)}
                                        pending={Boolean(pendingId)}
                                        status={sourceStatus?.(source)}
                                        configurable={Boolean(
                                            source.id &&
                                                canConfigure(source.id),
                                        )}
                                    />
                                ))}
                                {!visible.length && (
                                    <p class="empty-state">
                                        没有符合筛选条件的渠道。
                                    </p>
                                )}
                            </div>
                        </>
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
                <Icon name="arrow-right" size={16} />
            </a>
            {selected && (
                <SourceManagementDialog
                    key={selected.id}
                    source={selected}
                    proxyPool={proxyPool}
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
