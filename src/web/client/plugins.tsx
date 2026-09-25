/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import {
    describeError,
    type ListedPlugin,
    setPluginEnabled,
} from "./api/admin.ts";
import {
    canTogglePlugin,
    pluginCapabilityLabel,
    pluginDependencyState,
    pluginKindLabel,
    pluginManagementText,
    pluginState,
    pluginTrustLabel,
} from "../shared/catalog-presentation.ts";

interface PluginsProps {
    plugins: ListedPlugin[];
    loadError: string;
    onRefresh: () => Promise<void>;
}

function PluginCard({ plugin, plugins, pendingId, onToggle }: {
    plugin: ListedPlugin;
    plugins: ListedPlugin[];
    pendingId: string;
    onToggle: (plugin: ListedPlugin) => Promise<void>;
}) {
    const eligible = canTogglePlugin(plugin);
    const label = plugin.name || plugin.id;
    const action = plugin.enabled ? "停用" : "启用";
    const state = pluginState(plugin);
    return (
        <article
            class={`plugin-card${plugin.enabled === false ? " disabled" : ""}`}
            aria-busy={pendingId === plugin.id ? "true" : "false"}
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
                        disabled={Boolean(pendingId)}
                        aria-label={`${action} ${label}`}
                        onClick={() => void onToggle(plugin)}
                    >
                        {pendingId === plugin.id ? "处理中…" : action}
                    </button>
                )}
            </footer>
        </article>
    );
}

export function PluginsPanel({ plugins, loadError, onRefresh }: PluginsProps) {
    const [pendingId, setPendingId] = useState("");
    const [actionError, setActionError] = useState("");
    const [message, setMessage] = useState("");
    const busy = useRef(false);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    async function togglePlugin(plugin: ListedPlugin) {
        if (busy.current || !canTogglePlugin(plugin)) return;
        busy.current = true;
        setPendingId(plugin.id);
        setActionError("");
        setMessage("");
        try {
            await setPluginEnabled(plugin.id, !plugin.enabled);
            if (mounted.current) {
                setMessage(
                    `已${plugin.enabled ? "停用" : "启用"} ${
                        plugin.name || plugin.id
                    }。`,
                );
            }
            try {
                await onRefresh();
            } catch (error) {
                if (mounted.current) {
                    setActionError(
                        `插件状态已更新，列表刷新失败：${describeError(error)}`,
                    );
                }
            }
        } catch (error) {
            if (mounted.current) {
                setActionError(`更新插件状态失败：${describeError(error)}`);
            }
        } finally {
            busy.current = false;
            if (mounted.current) setPendingId("");
        }
    }

    return (
        <section
            id="plugins"
            class="catalog-section"
            aria-labelledby="plugins-title"
            aria-busy={pendingId ? "true" : "false"}
        >
            <div class="panel-heading">
                <div>
                    <h2 id="plugins-title">插件能力</h2>
                    <p>已注册插件的运行状态与可用操作</p>
                </div>
                <span class="panel-count">{plugins.length} 个插件</span>
            </div>
            {loadError && <p class="form-error" role="alert">{loadError}</p>}
            {actionError && <p class="form-error" role="alert">{actionError}
            </p>}
            {message && <p class="form-success" role="status">{message}</p>}
            {plugins.length
                ? (
                    <div class="plugin-cards">
                        {plugins.map((plugin) => (
                            <PluginCard
                                key={plugin.id}
                                plugin={plugin}
                                plugins={plugins}
                                pendingId={pendingId}
                                onToggle={togglePlugin}
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
