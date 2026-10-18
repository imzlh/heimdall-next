import type { ConsoleSnapshot } from "@heimdall/admin-contracts/console.ts";
import type { UiContribution, UiPolicy } from "@heimdall/admin-contracts/ui.ts";
import { uiContributionKey } from "@heimdall/admin-contracts/ui.ts";
import { PluginSlots } from "../components/slots.tsx";
import { Icon } from "../shared/icons.tsx";
import { ChannelsSnapshot, OverviewSnapshot } from "./catalog.tsx";
import { SystemLogSnapshotView } from "./system-log.tsx";
import { JournalSnapshotView } from "./journal.tsx";
import { type ConsolePage, consolePageInfo } from "../shared/page-info.ts";
import { dashboardUiContext } from "../shared/ui-context.ts";
import {
    PROXY_IMPLEMENTATION_NOTE,
    sourceProxyLabel,
} from "../shared/proxy-presentation.ts";
import {
    requestReceivedTime,
    requestState,
} from "../shared/activity-presentation.ts";
import { DurationSummary, TokenSummary } from "../shared/request-cells.tsx";
import { MaintenanceStatus } from "../shared/maintenance-status.tsx";
import { SettingsCard } from "../shared/settings-card.tsx";
import {
    ASSET_RETENTION_NOTE,
    retentionDaysLabel,
} from "../shared/retention-settings.ts";

export type { ConsolePage } from "../shared/page-info.ts";
export interface ConsolePageProps {
    readonly desktop?: boolean;
    readonly snapshot: ConsoleSnapshot;
    readonly page: ConsolePage;
    readonly tab?: string;
    readonly contributions: readonly UiContribution[];
    readonly policy?: UiPolicy;
    readonly sourcePluginIds?: Readonly<Record<string, string>>;
}

/** Complete read-only content is sent before the browser enhancement loads. */
export function ConsolePageView(props: ConsolePageProps) {
    const { snapshot, page, tab, contributions, policy } = props;
    const { dashboard } = snapshot;
    const pageInfo = consolePageInfo(
        page,
        contributions.find((item) =>
            item.slot === "nav.tab" && uiContributionKey(item) === tab
        )?.title,
    );
    const context = dashboardUiContext(dashboard);
    return (
        <div class="console-content">
            <div class="console-toolbar">
                <span class="breadcrumb">管理端 / {pageInfo.label}</span>
                <div class="topbar-actions">
                    {!dashboard.authRequired && !props.desktop && (
                        <form method="post" action="/admin/logout">
                            <button
                                class="icon-button"
                                type="submit"
                                aria-label="退出登录"
                                title="退出登录"
                            >
                                <Icon name="log-out" />
                            </button>
                        </form>
                    )}
                </div>
            </div>
            <header class="page-heading">
                <div>
                    <p class="eyebrow">工作空间</p>
                    <h1>{pageInfo.label}</h1>
                    <p>{pageInfo.description}</p>
                </div>
            </header>
            {dashboard.authRequired ? <LoginPanel /> : (
                <>
                    <p class="ssr-notice" role="status">
                        正在加载交互功能，当前可浏览数据。
                    </p>
                    {Object.entries(dashboard.errors).filter(([, value]) =>
                        value
                    ).map(([key, value]) => (
                        <p class="error-message" key={key}>{value}</p>
                    ))}
                    {page === "overview" && (
                        <>
                            <OverviewSnapshot
                                dashboard={dashboard}
                                stats={snapshot.stats}
                                proxyPool={snapshot.proxies?.pool}
                                widgets={
                                    <PluginSlots
                                        slot="dashboard.widget"
                                        contributions={contributions}
                                        context={context}
                                        policy={policy}
                                    />
                                }
                            />
                            <RequestTable snapshot={snapshot} />
                        </>
                    )}
                    {page === "channels" && (
                        <ChannelsSnapshot
                            dashboard={dashboard}
                            proxyPool={snapshot.proxies?.pool}
                            contributions={contributions}
                            context={context}
                            policy={policy}
                            sourcePluginIds={props.sourcePluginIds}
                        />
                    )}
                    {page === "logs" && snapshot.systemLog && (
                        <SystemLogSnapshotView snapshot={snapshot.systemLog} />
                    )}
                    {page === "requests" && snapshot.journal && (
                        <JournalSnapshotView snapshot={snapshot.journal} />
                    )}
                    {page === "settings" && (
                        <>
                            <div class="settings-snapshot">
                                <div class="settings-grid">
                                    <SettingsCard
                                        id="runtime-settings-title"
                                        title="运行与对话"
                                        description="调整请求限额、探测频率与对话标题模型。"
                                        icon="gauge"
                                    >
                                        {snapshot.settings
                                            ? (
                                                <dl class="settings-summary">
                                                    <dt>每分钟请求上限</dt>
                                                    <dd>
                                                        {snapshot.settings
                                                            .settings
                                                            .limitPerMinute}
                                                    </dd>
                                                    <dt>探测间隔</dt>
                                                    <dd>
                                                        {snapshot.settings
                                                            .settings
                                                            .probeIntervalMs} ms
                                                    </dd>
                                                    <dt>对话标题模型</dt>
                                                    <dd>
                                                        {snapshot.settings
                                                            .settings
                                                            .titleModel ||
                                                            "跟随对话所选模型"}
                                                    </dd>
                                                </dl>
                                            )
                                            : (
                                                <p class="empty-state">
                                                    {snapshot.errors.settings ||
                                                        "当前实例未配置运行设置服务。"}
                                                </p>
                                            )}
                                    </SettingsCard>
                                    {snapshot.settings && (
                                        <>
                                            <SettingsCard
                                                id="gateway-settings-title"
                                                title="访问安全"
                                                description="管理访问网关时使用的密钥。"
                                                icon="key"
                                            >
                                                <dl class="settings-summary">
                                                    <dt>网关访问密钥</dt>
                                                    <dd>
                                                        {snapshot.settings
                                                                .settings
                                                                .proxyKeyConfigured
                                                            ? "已配置"
                                                            : "未配置"}
                                                    </dd>
                                                </dl>
                                                <p class="field-help">
                                                    密钥只写入，不会回显。
                                                </p>
                                            </SettingsCard>
                                            <SettingsCard
                                                id="retention-title"
                                                title="数据保留"
                                                description="按天保留历史，0 表示永久保留。"
                                                icon="logs"
                                            >
                                                <dl class="settings-summary">
                                                    <dt>请求记录保留</dt>
                                                    <dd>
                                                        {retentionDaysLabel(
                                                            snapshot.settings
                                                                .settings
                                                                .requestRetentionDays,
                                                        )}
                                                    </dd>
                                                    <dt>对话保留</dt>
                                                    <dd>
                                                        {retentionDaysLabel(
                                                            snapshot.settings
                                                                .settings
                                                                .chatRetentionDays,
                                                        )}
                                                    </dd>
                                                </dl>
                                                <p class="field-help">
                                                    对话按最后活动时间计算，正在生成的对话会保留。
                                                </p>
                                                <p class="field-help">
                                                    {ASSET_RETENTION_NOTE}
                                                </p>
                                            </SettingsCard>
                                            <div class="settings-card settings-maintenance-card">
                                                <MaintenanceStatus
                                                    status={snapshot.settings
                                                        .maintenance}
                                                />
                                            </div>
                                        </>
                                    )}
                                </div>
                            </div>
                            <ProxyPoolSnapshot snapshot={snapshot} />
                            <PluginSlots
                                slot="settings.section"
                                contributions={contributions}
                                context={context}
                                policy={policy}
                            />
                        </>
                    )}
                    {page === "plugin" && (
                        <PluginSlots
                            slot="nav.tab"
                            contributions={contributions.filter((item) =>
                                uiContributionKey(item) === tab
                            )}
                            context={context}
                            policy={policy}
                        />
                    )}
                    <noscript>
                        <p class="notice">
                            当前页面可直接阅读。修改配置、授权及实时状态需要启用
                            JavaScript。
                        </p>
                    </noscript>
                </>
            )}
        </div>
    );
}

function ProxyPoolSnapshot({ snapshot }: { snapshot: ConsoleSnapshot }) {
    const pool = snapshot.proxies?.pool;
    return (
        <section
            class="panel proxy-pool-panel"
            aria-labelledby="proxy-pool-title"
        >
            <div class="panel-heading">
                <div>
                    <h2 id="proxy-pool-title">出站代理池</h2>
                    <p>{PROXY_IMPLEMENTATION_NOTE}</p>
                </div>
                {pool && (
                    <span class="status-chip chip-muted">
                        {pool.entries.length} 个代理
                    </span>
                )}
            </div>
            {pool
                ? (
                    <>
                        <dl class="settings-summary">
                            <dt>全局默认</dt>
                            <dd>
                                {sourceProxyLabel({ mode: "inherit" }, pool)}
                            </dd>
                        </dl>
                        <div class="proxy-entry-list">
                            {pool.entries.map((entry) => (
                                <article class="proxy-entry" key={entry.id}>
                                    <div class="proxy-entry-heading">
                                        <div class="proxy-entry-identity">
                                            <strong>{entry.name}</strong>
                                            <small>{entry.url}</small>
                                        </div>
                                        <div class="proxy-entry-actions">
                                            {pool.defaultProxyId === entry.id &&
                                                (
                                                    <span class="status-chip chip-muted">
                                                        默认
                                                    </span>
                                                )}
                                            <span
                                                class={`status-chip chip-${
                                                    entry.enabled
                                                        ? "success"
                                                        : "muted"
                                                }`}
                                            >
                                                {entry.enabled
                                                    ? "已启用"
                                                    : "已停用"}
                                            </span>
                                            <span class="plugin-chip">
                                                {entry.authConfigured
                                                    ? "认证已配置"
                                                    : "无认证"}
                                            </span>
                                        </div>
                                    </div>
                                </article>
                            ))}
                        </div>
                        {!pool.entries.length && (
                            <p class="empty-state">
                                尚未添加代理，全局默认使用直连。
                            </p>
                        )}
                    </>
                )
                : (
                    <p class="empty-state">
                        {snapshot.errors.proxies ||
                            "当前实例未配置代理池服务。"}
                    </p>
                )}
        </section>
    );
}

function LoginPanel() {
    return (
        <section class="panel auth-panel">
            <h2>连接管理工作区</h2>
            <p>输入管理令牌，查看渠道、用量和运行设置。</p>
            <form method="post" action="/admin/session">
                <label for="admin-token">管理令牌</label>
                <input
                    id="admin-token"
                    name="token"
                    type="password"
                    required
                    autocomplete="current-password"
                />
                <button type="submit" class="primary-button">连接</button>
            </form>
        </section>
    );
}

function RequestTable({ snapshot }: { snapshot: ConsoleSnapshot }) {
    return (
        <section class="panel activity-panel" aria-labelledby="activity-title">
            <div class="panel-heading">
                <div>
                    <h2 id="activity-title">用量与最近请求</h2>
                    <p>
                        最近 20 条请求 ·{" "}
                        <a href="/admin?view=requests">查看全部</a>
                    </p>
                </div>
                <span class="status-chip chip-muted">
                    {snapshot.usage.usage
                        ? `${
                            snapshot.usage.usage.totalTokens.toLocaleString(
                                "zh-CN",
                            )
                        } tokens`
                        : "暂无用量"}
                </span>
            </div>
            {snapshot.errors.usage && (
                <p class="error-message">用量：{snapshot.errors.usage}</p>
            )}
            {snapshot.usage.days?.length
                ? (
                    <details class="usage-history">
                        <summary>
                            每日用量 · {snapshot.usage.days.length} 天
                        </summary>
                        <ul class="catalog-list">
                            {snapshot.usage.days.map((day) => (
                                <li class="catalog-row" key={day.day}>
                                    <strong>{day.day}</strong>
                                    <span>
                                        {day.totalTokens.toLocaleString(
                                            "zh-CN",
                                        )} tokens ·{" "}
                                        {day.requestCount.toLocaleString(
                                            "zh-CN",
                                        )} 次请求
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </details>
                )
                : null}
            {snapshot.errors.requests && (
                <p class="error-message">{snapshot.errors.requests}</p>
            )}
            {snapshot.requests.length
                ? (
                    <div class="table-wrap request-table-wrap">
                        <table class="request-table">
                            <caption class="sr-only">最近 20 条请求</caption>
                            <thead>
                                <tr>
                                    <th scope="col">
                                        时间 / 请求 ID <small>本地时区</small>
                                    </th>
                                    <th scope="col">模型 / 操作</th>
                                    <th scope="col">状态</th>
                                    <th scope="col">耗时</th>
                                    <th scope="col">Token</th>
                                </tr>
                            </thead>
                            <tbody>
                                {snapshot.requests.map((request) => {
                                    const state = requestState(request.status);
                                    return (
                                        <tr key={request.requestId}>
                                            <td class="request-time">
                                                <time
                                                    dateTime={request
                                                        .receivedAt}
                                                >
                                                    {requestReceivedTime(
                                                        request.receivedAt,
                                                    )}
                                                </time>
                                                <a
                                                    class="request-id-inline"
                                                    title={request.requestId}
                                                    href={`/admin?view=requests&id=${
                                                        encodeURIComponent(
                                                            request.requestId ??
                                                                "",
                                                        )
                                                    }`}
                                                >
                                                    {request.requestId}
                                                </a>
                                            </td>
                                            <td class="request-model">
                                                <strong title={request.model}>
                                                    {request.model ||
                                                        "未指定模型"}
                                                </strong>
                                                <small>
                                                    {request.operation ||
                                                        "未知操作"}
                                                </small>
                                            </td>
                                            <td class="request-state">
                                                <span
                                                    class={`status-chip chip-${state.tone}`}
                                                    title={request.status}
                                                >
                                                    {state.label}
                                                </span>
                                            </td>
                                            <td class="request-duration">
                                                <DurationSummary
                                                    row={request}
                                                />
                                            </td>
                                            <td class="request-tokens-cell">
                                                <TokenSummary row={request} />
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )
                : <p class="empty-state">暂无请求记录。</p>}
        </section>
    );
}
