import type { DashboardData } from "@heimdall/admin-contracts/console.ts";
import type { Child } from "hono/jsx";
import type {
    UiContext,
    UiContribution,
    UiPolicy,
} from "@heimdall/admin-contracts/ui.ts";
import {
    ModelDirectory,
    PluginCards,
    SourceCard,
} from "../components/catalog-cards.tsx";
import { PluginSlots } from "../components/slots.tsx";
import { sourcePluginIdFor } from "../shared/source-schemas.ts";
import { sourceUiContext } from "../shared/ui-context.ts";
import { Icon } from "../shared/icons.tsx";

export function OverviewSnapshot(
    { dashboard, widgets }: { dashboard: DashboardData; widgets?: Child },
) {
    const { sources, plugins } = dashboard.status;
    const healthy = dashboard.health.status === "ok";
    return (
        <>
            <section class="stats-grid" aria-label="实例概况">
                <article class="stat-card">
                    <h2>服务健康</h2>
                    <strong>{healthy ? "正常" : "需要检查"}</strong>
                    <p>{healthy ? "服务正在接受请求" : "请检查服务状态"}</p>
                </article>
                <article class="stat-card">
                    <h2>已启用渠道</h2>
                    <strong>
                        {sources.filter((source) => source.enabled).length}
                    </strong>
                    <p>共 {sources.length} 个渠道</p>
                </article>
                <article class="stat-card">
                    <h2>可用模型</h2>
                    <strong>{dashboard.models.length}</strong>
                    <p>当前可调用</p>
                </article>
                <article class="stat-card">
                    <h2>运行中插件</h2>
                    <strong>
                        {plugins.filter((plugin) =>
                            plugin.enabled && !plugin.lastError
                        ).length}
                    </strong>
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
            <PluginCards plugins={plugins} error={dashboard.errors.status} />
            <ModelDirectory
                models={dashboard.models}
                error={dashboard.errors.models}
            />
        </>
    );
}

export function ChannelsSnapshot(
    { dashboard, contributions, context, policy, sourcePluginIds }: {
        dashboard: DashboardData;
        contributions: readonly UiContribution[];
        context: UiContext;
        policy?: UiPolicy;
        sourcePluginIds?: Readonly<Record<string, string>>;
    },
) {
    const { sources, plugins } = dashboard.status;
    return (
        <>
            <section class="catalog-section" aria-labelledby="sources-title">
                <div class="panel-heading">
                    <div>
                        <h2 id="sources-title">上游渠道</h2>
                    </div>
                    <span class="panel-count">{sources.length} 个渠道</span>
                </div>
                {sources.length
                    ? (
                        <div class="source-cards">
                            {sources.map((source, index) => (
                                <SourceCard
                                    key={source.id ?? index}
                                    source={source}
                                    editing
                                    status={
                                        <PluginSlots
                                            slot="source.status"
                                            contributions={contributions}
                                            context={sourceUiContext(
                                                context,
                                                source,
                                                source.sourcePluginId ??
                                                    sourcePluginIds
                                                        ?.[source.id ?? ""] ??
                                                    sourcePluginIdFor(
                                                        source.id ?? "",
                                                    ),
                                            )}
                                            policy={policy}
                                        />
                                    }
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
                                disabled
                                title="交互加载后可用"
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
        </>
    );
}
