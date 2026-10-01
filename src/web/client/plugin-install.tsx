/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import type { ListedPlugin } from "@heimdall/admin-contracts/console.ts";
import { describeError } from "./api/admin.ts";
import { PluginDialog } from "./plugin-dialog.tsx";
import {
    type PluginPackagePreview,
    readPluginPackage,
} from "./plugin-package-file.ts";
import {
    pluginCapabilityLabel,
    pluginDependencyState,
} from "../shared/catalog-presentation.ts";

export function PluginInstallDialog({ plugins, busy, onInstall, onClose }: {
    plugins: ListedPlugin[];
    busy: boolean;
    onInstall: (preview: PluginPackagePreview) => Promise<void>;
    onClose: () => void;
}) {
    const [preview, setPreview] = useState<PluginPackagePreview | null>(null);
    const [fileName, setFileName] = useState("");
    const [reading, setReading] = useState(false);
    const [error, setError] = useState("");
    const revision = useRef(0);
    const selected = useRef<PluginPackagePreview | null>(null);
    const mounted = useRef(true);
    const submitting = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            revision.current = (revision.current ?? 0) + 1;
        };
    }, []);
    const duplicate = preview &&
        plugins.some((plugin) => plugin.id === preview.plugin.id);
    const locked = busy || reading;

    async function select(file?: File) {
        if (submitting.current) return;
        const current = revision.current = (revision.current ?? 0) + 1;
        selected.current = null;
        setPreview(null);
        setError("");
        setFileName(file?.name ?? "");
        setReading(Boolean(file));
        if (!file) return;
        try {
            const next = await readPluginPackage(file);
            if (mounted.current && revision.current === current) {
                selected.current = next;
                setPreview(next);
            }
        } catch (error) {
            if (mounted.current && revision.current === current) {
                setError(describeError(error));
            }
        } finally {
            if (mounted.current && revision.current === current) {
                setReading(false);
            }
        }
    }

    async function install() {
        if (
            submitting.current || locked || !preview ||
            selected.current !== preview || duplicate
        ) return;
        submitting.current = true;
        setError("");
        try {
            await onInstall(preview);
        } catch (error) {
            if (mounted.current) setError(`安装失败：${describeError(error)}`);
        } finally {
            submitting.current = false;
        }
    }

    return (
        <PluginDialog title="安装插件" busy={busy} onClose={onClose}>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void install();
                }}
            >
                <p class="plugin-install-description">
                    选择本地插件包，安装后可在卡片中启用。当前支持隔离运行的工具插件。
                </p>
                <div class="plugin-package-picker">
                    <label for="plugin-package-file">JSON 插件包</label>
                    <input
                        id="plugin-package-file"
                        type="file"
                        accept=".json,application/json"
                        disabled={busy}
                        aria-describedby="plugin-package-hint"
                        onInput={(event) =>
                            void select(
                                (event.currentTarget as HTMLInputElement).files
                                    ?.[0],
                            )}
                    />
                    <small id="plugin-package-hint">
                        离线安装 · 文件最多 2 MiB · 入口代码最多 1 MiB
                    </small>
                </div>
                {reading && <p role="status">正在读取 {fileName}…</p>}
                {preview && (
                    <section
                        class="plugin-package-preview"
                        aria-label="插件包预览"
                    >
                        <header>
                            <h3>{preview.plugin.name || preview.plugin.id}</h3>
                            {preview.plugin.version && (
                                <span class="plugin-chip">
                                    v{preview.plugin.version}
                                </span>
                            )}
                        </header>
                        <code>{preview.plugin.id}</code>
                        {preview.plugin.description && (
                            <p>{preview.plugin.description}</p>
                        )}
                        <div class="plugin-card-badges">
                            <span class="plugin-chip accent">聊天工具</span>
                            <span class="plugin-chip">隔离运行</span>
                            <span class="plugin-chip">
                                {Math.ceil(preview.bytes / 1024)} KiB
                            </span>
                        </div>
                        {Boolean(preview.plugin.capabilities?.length) && (
                            <div class="plugin-preview-section">
                                <h4>声明能力</h4>
                                <div class="plugin-card-badges">
                                    {preview.plugin.capabilities!.map((
                                        item,
                                    ) => (
                                        <span class="plugin-chip">
                                            {pluginCapabilityLabel(item)}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                        {Boolean(preview.plugin.dependencies?.length) && (
                            <div class="plugin-preview-section">
                                <h4>声明依赖</h4>
                                <ul class="plugin-dependencies">
                                    {preview.plugin.dependencies!.map((id) => {
                                        const state = pluginDependencyState(
                                            id,
                                            plugins,
                                        );
                                        return (
                                            <li>
                                                <code>{id}</code>
                                                <span
                                                    class={`status-chip chip-${state.tone}`}
                                                >
                                                    {state.label}
                                                </span>
                                            </li>
                                        );
                                    })}
                                </ul>
                                <p class="field-help">
                                    缺失的依赖需要在启用前安装。
                                </p>
                            </div>
                        )}
                        <details class="plugin-card-details plugin-checksum">
                            <summary>校验和</summary>
                            <code>{preview.digest}</code>
                            <p class="field-help">安装时由服务端校验。</p>
                        </details>
                    </section>
                )}
                {duplicate && (
                    <p class="form-error" role="alert">
                        该插件已存在。安装其他版本前，请先卸载托管插件；内置插件不能覆盖。
                    </p>
                )}
                {error && <p class="form-error" role="alert">{error}</p>}
                <footer class="plugin-dialog-actions">
                    <button
                        type="button"
                        class="text-button"
                        disabled={busy}
                        onClick={onClose}
                    >
                        取消
                    </button>
                    <button
                        type="submit"
                        class="primary-button"
                        disabled={locked || !preview || Boolean(duplicate)}
                    >
                        {busy ? "正在安装…" : "安装插件包"}
                    </button>
                </footer>
            </form>
        </PluginDialog>
    );
}
