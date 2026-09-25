/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import type { Child } from "hono/jsx";
import type { ListedModel, ListedPreset, ListedSource } from "./api/admin.ts";
import { Icon } from "../shared/icons.tsx";
import {
    sourceAvailabilityText,
    sourceInstanceEnabled,
    sourceState,
} from "../shared/catalog-presentation.ts";

export function SourceCard(
    {
        source,
        onConfigure,
        onManage,
        onToggle,
        pending = false,
        status,
        configurable = false,
    }: {
        source: ListedSource;
        onConfigure?: (id: string) => void;
        onManage?: (source: ListedSource) => void;
        onToggle?: (source: ListedSource) => void;
        pending?: boolean;
        status?: Child;
        configurable?: boolean;
    },
) {
    const state = sourceState(source);
    const id = source.id || "";
    return (
        <article
            class={`source-card source-card-${state.tone}`}
            aria-busy={pending ? "true" : "false"}
        >
            <header class="source-card-head">
                <div class="source-card-title">
                    <h3 title={source.name || id}>
                        {source.name || id || "未命名渠道"}
                    </h3>
                    {source.name && <code title={id}>{id}</code>}
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
            {status && <div class="source-status-slot">{status}</div>}
            <footer class="source-card-actions">
                {onConfigure || onManage
                    ? (
                        <>
                            {onToggle && (
                                <button
                                    type="button"
                                    class="source-state-toggle"
                                    role="switch"
                                    aria-checked={sourceInstanceEnabled(source)
                                        ? "true"
                                        : "false"}
                                    aria-label={`${
                                        sourceInstanceEnabled(source)
                                            ? "停用"
                                            : "启用"
                                    } ${source.name || id}`}
                                    disabled={pending || !id}
                                    onClick={() => onToggle(source)}
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
                            )}
                            <div class="source-card-buttons">
                                {onManage && (
                                    <button
                                        type="button"
                                        class="icon-button"
                                        disabled={pending || !id}
                                        title={`管理 ${
                                            source.name || id || "渠道"
                                        }`}
                                        aria-label={`管理 ${
                                            source.name || id || "渠道"
                                        }`}
                                        onClick={() => onManage(source)}
                                    >
                                        <Icon name="edit" />
                                    </button>
                                )}
                                {onConfigure && (
                                    <button
                                        class="icon-button"
                                        type="button"
                                        disabled={pending || !id ||
                                            !configurable}
                                        title={configurable
                                            ? `配置 ${
                                                source.name || id || "渠道"
                                            }`
                                            : "此渠道尚未声明配置表单"}
                                        aria-label={`配置 ${id || "渠道"}`}
                                        onClick={() =>
                                            id && configurable &&
                                            onConfigure(id)}
                                    >
                                        <Icon name="settings" />
                                    </button>
                                )}
                            </div>
                        </>
                    )
                    : (
                        <a class="section-link" href="/admin?view=channels">
                            查看渠道 <span aria-hidden="true">→</span>
                        </a>
                    )}
            </footer>
        </article>
    );
}

export function ModelDirectory({ models, error }: {
    models: ListedModel[];
    error?: string;
}) {
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
