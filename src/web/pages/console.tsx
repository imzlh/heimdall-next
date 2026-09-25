import type { ConsoleSnapshot } from "@heimdall/admin-contracts/console.ts";
import type { UiContribution, UiPolicy } from "@heimdall/admin-contracts/ui.ts";
import { uiContributionKey } from "@heimdall/admin-contracts/ui.ts";
import { PluginSlots } from "../components/slots.tsx";
import { Icon } from "../shared/icons.tsx";
import { ChannelsSnapshot, OverviewSnapshot } from "./catalog.tsx";
import { type ConsolePage, consolePageInfo } from "../shared/page-info.ts";
import { dashboardUiContext } from "../shared/ui-context.ts";
import {
    requestReceivedTime,
    requestState,
} from "../shared/activity-presentation.ts";

export type { ConsolePage } from "../shared/page-info.ts";
export interface ConsolePageProps {
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
                    {!dashboard.authRequired && (
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
                            contributions={contributions}
                            context={context}
                            policy={policy}
                            sourcePluginIds={props.sourcePluginIds}
                        />
                    )}
                    {page === "settings" && (
                        <>
                            <section class="panel">
                                <h2>代理与探测</h2>
                                {snapshot.settings
                                    ? (
                                        <dl class="settings-summary">
                                            <dt>每分钟请求上限</dt>
                                            <dd>
                                                {snapshot.settings.settings
                                                    .limitPerMinute}
                                            </dd>
                                            <dt>探测间隔</dt>
                                            <dd>
                                                {snapshot.settings.settings
                                                    .probeIntervalMs} ms
                                            </dd>
                                            <dt>代理密钥</dt>
                                            <dd>
                                                {snapshot.settings.settings
                                                        .proxyKeyConfigured
                                                    ? "已配置"
                                                    : "未配置"}
                                            </dd>
                                        </dl>
                                    )
                                    : (
                                        <p class="empty-state">
                                            {snapshot.errors.settings ||
                                                "当前实例未配置运行设置服务。"}
                                        </p>
                                    )}
                            </section>
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
                    <p>最近 20 条请求</p>
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
                                        接收时间 <small>UTC</small>
                                    </th>
                                    <th scope="col">模型 / 操作</th>
                                    <th scope="col">状态</th>
                                    <th scope="col">请求 ID</th>
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
                                            <td class="request-id">
                                                <code title={request.requestId}>
                                                    {request.requestId}
                                                </code>
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
