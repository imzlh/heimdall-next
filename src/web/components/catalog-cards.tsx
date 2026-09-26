import type { Child } from "hono/jsx";
import type { ProxyPoolView } from "@heimdall/admin-contracts/proxies.ts";
import { Icon } from "../shared/icons.tsx";
import type {
    ListedModel,
    ListedPlugin,
    ListedPreset,
    ListedSource,
} from "@heimdall/admin-contracts/console.ts";
import {
    canTogglePlugin,
    pluginCapabilityLabel,
    pluginDependencyState,
    pluginKindLabel,
    pluginManagementText,
    pluginState,
    pluginTrustLabel,
    sourceAvailabilityText,
    sourceInstanceEnabled,
    sourceState,
} from "../shared/catalog-presentation.ts";
import {
    PROXY_IMPLEMENTATION_NOTE,
    sourceProxyLabel,
    sourceProxySummaryLabel,
} from "../shared/proxy-presentation.ts";

export function SourceCard({ source, status, editing = false, proxyPool }: {
    source: ListedSource;
    status?: Child;
    editing?: boolean;
    proxyPool?: ProxyPoolView | null;
}) {
    const state = sourceState(source);
    const proxyLabel = !proxyPool && source.proxySummary
        ? sourceProxySummaryLabel(source.proxySummary)
        : sourceProxyLabel(source.proxy, proxyPool);
    return (
        <article class={`source-card source-card-${state.tone}`}>
            <header class="source-card-head">
                <div class="source-card-title">
                    <h3 title={source.name || source.id}>
                        {source.name || source.id || "未命名渠道"}
                    </h3>
                    {source.name && <code title={source.id}>{source.id}</code>}
                </div>
                <span class={`status-chip chip-${state.tone}`}>
                    {state.label}
                </span>
            </header>
            <dl class="source-card-meta">
                <div>
                    <dt>模型</dt>
                    <dd>{source.models?.length ?? 0}</dd>
                </div>
                <div>
                    <dt>能力</dt>
                    <dd>{source.capabilities?.length ?? 0}</dd>
                </div>
                {source.priority !== undefined && (
                    <div>
                        <dt>优先级</dt>
                        <dd>{source.priority}</dd>
                    </div>
                )}
            </dl>
            <p class="source-probe" title={sourceAvailabilityText(source)}>
                {sourceAvailabilityText(source)}
            </p>
            <p class="source-proxy-summary" title={PROXY_IMPLEMENTATION_NOTE}>
                代理：{proxyLabel}
            </p>
            {status && (
                <details class="source-status-slot">
                    <summary>
                        渠道详情 <Icon name="chevron-down" size={14} />
                    </summary>
                    <div class="source-status-content">{status}</div>
                </details>
            )}
            <footer class="source-card-actions">
                {editing
                    ? (
                        <>
                            <button
                                class="source-state-toggle"
                                role="switch"
                                type="button"
                                disabled
                                aria-checked={sourceInstanceEnabled(source)
                                    ? "true"
                                    : "false"}
                                aria-label={`${
                                    sourceInstanceEnabled(source)
                                        ? "停用"
                                        : "启用"
                                } ${source.name || source.id}`}
                                title="交互加载后可用"
                            >
                                <span
                                    class="source-switch-track"
                                    aria-hidden="true"
                                />
                                <span>
                                    {sourceInstanceEnabled(source)
                                        ? "已启用"
                                        : "已停用"}
                                </span>
                            </button>
                            <div class="source-card-buttons">
                                <button
                                    class="icon-button"
                                    type="button"
                                    disabled
                                    title={`管理 ${
                                        source.name || source.id || "渠道"
                                    }（交互加载后可用）`}
                                    aria-label={`管理 ${
                                        source.name || source.id || "渠道"
                                    }`}
                                >
                                    <Icon name="edit" />
                                </button>
                                <button
                                    class="icon-button"
                                    type="button"
                                    disabled
                                    title={`配置 ${
                                        source.name || source.id || "渠道"
                                    }（交互加载后可用）`}
                                    aria-label={`配置 ${source.id || "渠道"}`}
                                >
                                    <Icon name="settings" />
                                </button>
                            </div>
                        </>
                    )
                    : (
                        <a class="section-link" href="/admin?view=channels">
                            查看渠道 <Icon name="arrow-right" size={16} />
                        </a>
                    )}
            </footer>
        </article>
    );
}

export function ModelDirectory(
    { models, error }: { models: ListedModel[]; error?: string },
) {
    return (
        <details class="panel model-directory" open={Boolean(error)}>
            <summary class="model-directory-summary">
                <span>
                    <strong>模型目录</strong>
                    <small>查看当前可调用的模型</small>
                </span>
                <span class="panel-count">{models.length} 个模型</span>
            </summary>
            {error && <p class="form-error" role="alert">{error}</p>}
            {models.length
                ? (
                    <div class="model-tags">
                        {models.map((model, index) => (
                            <span
                                class="model-tag"
                                key={model.id ?? index}
                                title={model.owned_by}
                            >
                                {model.id || "未命名模型"}
                            </span>
                        ))}
                    </div>
                )
                : <p class="empty-state">还没有可用模型，请先配置渠道。</p>}
        </details>
    );
}

export function PresetCard({ preset }: { preset: ListedPreset }) {
    return (
        <article class="preset-card">
            <header class="source-card-head">
                <h3>{preset.name || preset.id}</h3>
                {preset.version !== undefined && (
                    <span class="plugin-chip">v{preset.version}</span>
                )}
            </header>
            <p>{preset.sourcePluginId || "未指定渠道"}</p>
            <code>{preset.id}</code>
        </article>
    );
}

function PluginCard(
    { plugin, plugins }: { plugin: ListedPlugin; plugins: ListedPlugin[] },
) {
    const state = pluginState(plugin);
    const eligible = canTogglePlugin(plugin);
    const label = plugin.name || plugin.id;
    const action = plugin.enabled ? "停用" : "启用";
    return (
        <article
            class={`plugin-card${plugin.enabled === false ? " disabled" : ""}`}
        >
            <header class="plugin-card-head">
                <div class="plugin-card-title">
                    <h3 title={label}>{label}</h3>
                    <code title={plugin.id}>{plugin.id}</code>
                </div>
                <span class={`status-chip chip-${state.tone}`}>
                    {state.label}
                </span>
            </header>
            {plugin.description && (
                <p class="plugin-card-desc">{plugin.description}</p>
            )}
            <div class="plugin-card-badges">
                {typeof plugin.managed === "boolean" && (
                    <span class="plugin-chip">
                        {plugin.managed ? "托管" : "内置"}
                    </span>
                )}
                <span class="plugin-chip accent">
                    {pluginKindLabel(plugin.kind)}
                </span>
                {plugin.version && (
                    <span class="plugin-chip">v{plugin.version}</span>
                )}
            </div>
            <div class="plugin-card-meta">
                <div class="plugin-meta-group">
                    <span class="plugin-meta-label">运行方式</span>
                    <span>{pluginTrustLabel(plugin.trust)}</span>
                </div>
                {Boolean(plugin.capabilities?.length) && (
                    <details class="plugin-card-details">
                        <summary>
                            声明能力{" "}
                            <span>{plugin.capabilities!.length} 项</span>
                        </summary>
                        <div class="plugin-card-badges">
                            {plugin.capabilities!.map((capability) => (
                                <span class="plugin-chip" title={capability}>
                                    {pluginCapabilityLabel(capability)}
                                </span>
                            ))}
                        </div>
                    </details>
                )}
                {Boolean(plugin.dependencies?.length) && (
                    <details class="plugin-card-details">
                        <summary>
                            声明依赖{" "}
                            <span>{plugin.dependencies!.length} 项</span>
                        </summary>
                        <ul class="plugin-dependencies">
                            {plugin.dependencies!.map((dependency) => {
                                const state = pluginDependencyState(
                                    dependency,
                                    plugins,
                                );
                                return (
                                    <li>
                                        <code>{dependency}</code>
                                        <span
                                            class={`status-chip chip-${state.tone}`}
                                        >
                                            {state.label}
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    </details>
                )}
            </div>
            {plugin.lastError && (
                <p
                    class="plugin-card-error"
                    role="alert"
                    title={plugin.lastError}
                >
                    最近错误：{plugin.lastError}
                </p>
            )}
            <footer class="plugin-card-actions">
                <span>{pluginManagementText(plugin)}</span>
                {eligible && (
                    <button
                        class="secondary-button"
                        type="button"
                        disabled
                        title="交互加载后可用"
                        aria-label={`${action} ${label}`}
                    >
                        {action}
                    </button>
                )}
            </footer>
        </article>
    );
}

export function PluginCards(
    { plugins, error }: { plugins: ListedPlugin[]; error?: string },
) {
    return (
        <section
            id="plugins"
            class="catalog-section"
            aria-labelledby="plugins-title"
        >
            <div class="panel-heading">
                <div>
                    <h2 id="plugins-title">插件能力</h2>
                    <p>已注册插件的运行状态与可用操作</p>
                </div>
                <span class="panel-count">{plugins.length} 个插件</span>
            </div>
            {error && <p class="form-error" role="alert">{error}</p>}
            {plugins.length
                ? (
                    <div class="plugin-cards">
                        {plugins.map((plugin) => (
                            <PluginCard
                                key={plugin.id}
                                plugin={plugin}
                                plugins={plugins}
                            />
                        ))}
                    </div>
                )
                : (
                    <div class="panel empty-state">
                        <h3>暂无插件信息</h3>
                        <p>已加载的上游源、协议和预设会在这里显示。</p>
                    </div>
                )}
        </section>
    );
}
