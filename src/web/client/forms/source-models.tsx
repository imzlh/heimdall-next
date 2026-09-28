/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import type { SourceDraftProbeResult } from "@heimdall/admin-contracts/source-probe.ts";

/** Host-owned discovery display, shared by schema forms and preset JSX. */
export function SourceModels({ result, selected = [], disabled, onSelect }: {
    readonly result: SourceDraftProbeResult;
    readonly selected?: readonly string[];
    readonly disabled?: boolean;
    readonly onSelect?: (model: string) => void;
}) {
    return (
        <div
            class="source-probe-result"
            data-state={result.ok ? "success" : "error"}
        >
            <p
                class={result.ok ? "form-success" : "form-error"}
                role={result.ok ? "status" : "alert"}
            >
                {result.message}
            </p>
            {result.ok && result.models?.length
                ? (
                    <>
                        <p class="field-help">
                            发现 {result.models.length}{" "}
                            个模型{onSelect ? "，点击加入模型映射。" : "。"}
                        </p>
                        <div class="source-model-list" aria-label="上游模型">
                            {result.models.map((model) =>
                                onSelect
                                    ? (
                                        <button
                                            key={model}
                                            type="button"
                                            class="source-model-chip"
                                            aria-pressed={selected.includes(
                                                    model,
                                                )
                                                ? "true"
                                                : "false"}
                                            disabled={disabled}
                                            onClick={() => onSelect(model)}
                                        >
                                            {model}
                                        </button>
                                    )
                                    : (
                                        <span
                                            key={model}
                                            class="source-model-chip"
                                        >
                                            {model}
                                        </span>
                                    )
                            )}
                        </div>
                    </>
                )
                : result.ok && (
                    <p class="field-help">插件未返回模型列表，仍可保存渠道。</p>
                )}
        </div>
    );
}

/** Preserve aliases already supplied by the operator while adding direct names. */
export function addDiscoveredModel(raw: unknown, model: string): string {
    const mapping = readModelMap(raw);
    if (!Object.hasOwn(mapping, model)) mapping[model] = model;
    return JSON.stringify(mapping, null, 2);
}

export function readModelMap(raw: unknown): Record<string, string> {
    const parsed: unknown = typeof raw === "string"
        ? JSON.parse(raw || "{}")
        : raw ?? {};
    if (
        !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        Object.entries(parsed).some(([key, value]) =>
            !key || typeof value !== "string" || !value
        )
    ) {
        throw new TypeError("请先修正模型映射，再添加发现的模型。");
    }
    return Object.assign(Object.create(null), parsed);
}
