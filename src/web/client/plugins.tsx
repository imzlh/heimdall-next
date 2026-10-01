/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import {
    describeError,
    type ListedPlugin,
    setPluginEnabled,
    uninstallPlugin,
} from "./api/admin.ts";
import { installPluginPackage } from "./api/plugin-packages.ts";
import { PluginCard } from "../shared/plugin-card.tsx";
import {
    canTogglePlugin,
    canUninstallPlugin,
    pluginDependents,
} from "../shared/catalog-presentation.ts";
import { PluginInstallDialog } from "./plugin-install.tsx";
import { PluginDialog } from "./plugin-dialog.tsx";
import type { PluginPackagePreview } from "./plugin-package-file.ts";

interface PluginsProps {
    plugins: ListedPlugin[];
    loadError: string;
    onRefresh: () => Promise<void>;
}

export function PluginsPanel({ plugins, loadError, onRefresh }: PluginsProps) {
    const [pendingId, setPendingId] = useState("");
    const [actionError, setActionError] = useState("");
    const [message, setMessage] = useState("");
    const [dialog, setDialog] = useState<"install" | ListedPlugin | null>(null);
    const [refreshFailed, setRefreshFailed] = useState(false);
    const busy = useRef(false);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const deleting = dialog && dialog !== "install" ? dialog : null;
    const dependents = deleting ? pluginDependents(deleting, plugins) : [];

    function dismiss() {
        if (!busy.current) {
            setDialog(null);
            setActionError("");
        }
    }

    async function refresh(completed: string) {
        try {
            await onRefresh();
            if (mounted.current) setRefreshFailed(false);
        } catch (error) {
            if (mounted.current) {
                setRefreshFailed(true);
                setActionError(
                    `${completed}，列表刷新失败：${describeError(error)}`,
                );
            }
        }
    }

    async function change(kind: "toggle" | "remove", plugin: ListedPlugin) {
        if (busy.current) return;
        if (kind === "toggle" && !canTogglePlugin(plugin)) return;
        if (
            kind === "remove" &&
            (!canUninstallPlugin(plugin) ||
                pluginDependents(plugin, plugins).length)
        ) return;
        busy.current = true;
        setPendingId(plugin.id);
        setActionError("");
        setMessage("");
        try {
            if (kind === "toggle") {
                await setPluginEnabled(plugin.id, !plugin.enabled);
            } else await uninstallPlugin(plugin.id);
            if (!mounted.current) return;
            const action = kind === "remove"
                ? "卸载"
                : plugin.enabled
                ? "停用"
                : "启用";
            setMessage(`已${action} ${plugin.name || plugin.id}。`);
            if (kind === "remove") setDialog(null);
            await refresh(kind === "remove" ? "插件已卸载" : "插件状态已更新");
        } catch (error) {
            if (mounted.current) {
                setActionError(
                    `${kind === "remove" ? "卸载插件" : "更新插件状态"}失败：${
                        describeError(error)
                    }`,
                );
                // A lifecycle failure may have persisted lastError or stopped a worker.
                // Refresh the actual host state while retaining the operation failure.
                try {
                    await onRefresh();
                } catch { /* Original operation error remains actionable. */ }
            }
        } finally {
            busy.current = false;
            if (mounted.current) setPendingId("");
        }
    }

    async function install(preview: PluginPackagePreview) {
        if (busy.current) return;
        busy.current = true;
        setPendingId("@install");
        setActionError("");
        setMessage("");
        try {
            await installPluginPackage(preview.input);
            if (!mounted.current) return;
            setDialog(null);
            setMessage(
                `已安装 ${
                    preview.plugin.name || preview.plugin.id
                }，可在插件卡片中启用。`,
            );
            await refresh("插件已安装");
        } finally {
            busy.current = false;
            if (mounted.current) setPendingId("");
        }
    }

    async function retryRefresh() {
        if (busy.current) return;
        busy.current = true;
        setPendingId("@refresh");
        setActionError("");
        try {
            await refresh("操作已完成");
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
                    <h2 id="plugins-title" tabIndex={-1}>插件能力</h2>
                    <p>已注册插件的运行状态与可用操作</p>
                </div>
                <div class="plugin-heading-actions">
                    <span class="panel-count">{plugins.length} 个插件</span>
                    <button
                        type="button"
                        class="secondary-button"
                        disabled={Boolean(pendingId)}
                        onClick={() => {
                            if (!busy.current) {
                                setActionError("");
                                setDialog("install");
                            }
                        }}
                    >
                        安装插件
                    </button>
                </div>
            </div>
            {loadError && <p class="form-error" role="alert">{loadError}</p>}
            {actionError && !deleting && (
                <p class="form-error" role="alert">{actionError}</p>
            )}
            {message && <p class="form-success" role="status">{message}</p>}
            {(refreshFailed || loadError) && (
                <button
                    class="text-button"
                    type="button"
                    disabled={Boolean(pendingId)}
                    onClick={() => void retryRefresh()}
                >
                    重新读取插件列表
                </button>
            )}
            {plugins.length
                ? (
                    <div class="plugin-cards">
                        {plugins.map((plugin) => (
                            <PluginCard
                                key={plugin.id}
                                plugin={plugin}
                                plugins={plugins}
                                busy={Boolean(pendingId)}
                                pending={pendingId === plugin.id}
                                onToggle={(plugin) =>
                                    void change("toggle", plugin)}
                                onUninstall={(plugin) => {
                                    if (!busy.current) {
                                        setActionError("");
                                        setDialog(plugin);
                                    }
                                }}
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
            {dialog === "install" && (
                <PluginInstallDialog
                    plugins={plugins}
                    busy={Boolean(pendingId)}
                    onInstall={install}
                    onClose={dismiss}
                />
            )}
            {deleting && (
                <PluginDialog
                    title="卸载插件"
                    busy={Boolean(pendingId)}
                    onClose={dismiss}
                >
                    <p class="plugin-remove-description">
                        卸载“{deleting.name ||
                            deleting.id}”将移除插件包和安装记录。
                        {deleting.enabled ? "运行中的插件会先停用。" : ""}
                        之后可以重新安装。
                    </p>
                    <code>{deleting.id}</code>
                    {dependents.length > 0 && (
                        <div class="plugin-remove-blocked" role="alert">
                            <p>以下插件仍依赖它，请先处理这些依赖：</p>
                            <ul>
                                {dependents.map((plugin) => (
                                    <li key={plugin.id}>
                                        {plugin.name || plugin.id}{" "}
                                        <code>{plugin.id}</code>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {actionError && (
                        <p class="form-error" role="alert">{actionError}</p>
                    )}
                    <footer class="plugin-dialog-actions">
                        <button
                            type="button"
                            class="text-button"
                            disabled={Boolean(pendingId)}
                            onClick={dismiss}
                        >
                            取消
                        </button>
                        <button
                            type="button"
                            class="primary-button plugin-confirm-remove"
                            disabled={Boolean(pendingId) ||
                                dependents.length > 0}
                            onClick={() => void change("remove", deleting)}
                        >
                            {pendingId ? "正在卸载…" : "确认卸载"}
                        </button>
                    </footer>
                </PluginDialog>
            )}
        </section>
    );
}
