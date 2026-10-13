import type { ListedPlugin } from "@heimdall/admin-contracts/console.ts";
import {
    canRollbackPlugin,
    canTogglePlugin,
    canUninstallPlugin,
    pluginCapabilityLabel,
    pluginDependencyState,
    pluginKindLabel,
    pluginManagementText,
    pluginState,
    pluginTrustLabel,
} from "./catalog-presentation.ts";

/** One card for the initial SSR HTML and the live management island. */
export function PluginCard(
    {
        plugin,
        plugins,
        busy = false,
        pending = false,
        onToggle,
        onUninstall,
        onRollback,
        onConfigure,
    }: {
        plugin: ListedPlugin;
        plugins: ListedPlugin[];
        busy?: boolean;
        pending?: boolean;
        onToggle?: (plugin: ListedPlugin) => void;
        onUninstall?: (plugin: ListedPlugin) => void;
        onRollback?: (plugin: ListedPlugin) => void;
        onConfigure?: (plugin: ListedPlugin) => void;
    },
) {
    const state = pluginState(plugin);
    const eligible = canTogglePlugin(plugin);
    const label = plugin.name || plugin.id;
    const action = plugin.enabled ? "停用" : "启用";
    return (
        <article
            class={`plugin-card${plugin.enabled === false ? " disabled" : ""}`}
            aria-busy={pending ? "true" : "false"}
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
                <div class="plugin-operation-buttons">
                    {plugin.canConfigure === true && (
                        <button
                            class="secondary-button"
                            type="button"
                            disabled={busy || !onConfigure}
                            title={!onConfigure ? "交互加载后可用" : undefined}
                            onClick={() => onConfigure?.(plugin)}
                            aria-label={`配置 ${label}`}
                        >
                            配置
                        </button>
                    )}
                    {eligible && (
                        <button
                            class="secondary-button"
                            type="button"
                            disabled={busy || !onToggle}
                            title={!onToggle ? "交互加载后可用" : undefined}
                            onClick={() => onToggle?.(plugin)}
                            aria-label={`${action} ${label}`}
                        >
                            {pending ? "处理中…" : action}
                        </button>
                    )}
                    {canUninstallPlugin(plugin) && (
                        <button
                            class="text-button plugin-remove-button"
                            type="button"
                            disabled={busy || !onUninstall}
                            title={!onUninstall ? "交互加载后可用" : undefined}
                            aria-label={`卸载 ${label}`}
                            onClick={() => onUninstall?.(plugin)}
                        >
                            卸载
                        </button>
                    )}
                    {plugin.managed === true && plugin.rollbackVersion && (
                        <button
                            class="text-button"
                            type="button"
                            disabled={busy || !onRollback ||
                                !canRollbackPlugin(plugin)}
                            title={!plugin.revision?.trim()
                                ? "缺少当前插件的版本记录，请刷新插件列表后重试"
                                : !onRollback
                                ? "交互加载后可用"
                                : undefined}
                            aria-label={`回滚 ${label} 至 v${plugin.rollbackVersion}`}
                            onClick={() => onRollback?.(plugin)}
                        >
                            回滚至 v{plugin.rollbackVersion}
                        </button>
                    )}
                </div>
            </footer>
        </article>
    );
}
