/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef } from "hono/jsx/dom";
import {
    parseSourceModelMap,
    type SourceModelMap,
} from "@heimdall/admin-contracts/source-model-map.ts";
import { Icon } from "../../shared/icons.tsx";
import { controlValue } from "../dom.ts";

export interface SourceModelMapRow {
    readonly id: number;
    readonly alias: string;
    readonly upstream: string;
}

export function sourceModelMapRows(
    mapping?: SourceModelMap,
): SourceModelMapRow[] {
    return Object.entries(mapping ?? {}).map(([alias, upstream], id) => ({
        id,
        alias,
        upstream,
    }));
}

/** Keep rows until validation; converting first would silently overwrite aliases. */
export function readSourceModelMapRows(
    rows: readonly SourceModelMapRow[],
): SourceModelMap {
    const mapping: Record<string, string> = Object.create(null);
    for (const row of rows) {
        const alias = row.alias.trim();
        if (!alias || !row.upstream.trim()) {
            throw new TypeError(
                "请填写每行的对外模型名和上游模型名，或删除空行。",
            );
        }
        if (Object.hasOwn(mapping, alias)) {
            throw new TypeError(
                `对外模型名「${alias}」重复，每个名称只能映射一次。`,
            );
        }
        mapping[alias] = row.upstream;
    }
    return parseSourceModelMap(mapping);
}

export function sameSourceModelMap(
    left?: SourceModelMap,
    right?: SourceModelMap,
): boolean {
    const keys = Object.keys(left ?? {});
    return keys.length === Object.keys(right ?? {}).length &&
        keys.every((key) => left?.[key] === right?.[key]);
}

/** Routing metadata is shared by every source and never belongs to a provider form. */
export function SourceModelMapEditor(
    { rows, onChange, disabled, invalid, idPrefix }: {
        readonly rows: readonly SourceModelMapRow[];
        readonly onChange: (rows: readonly SourceModelMapRow[]) => void;
        readonly disabled?: boolean;
        readonly invalid?: boolean;
        readonly idPrefix: string;
    },
) {
    const root = useRef<HTMLDivElement | null>(null);
    const focusNewRow = useRef(false);
    useEffect(() => {
        if (focusNewRow.current) {
            focusNewRow.current = false;
            const inputs = root.current?.querySelectorAll<HTMLInputElement>(
                "input[data-model-alias]",
            );
            inputs?.[rows.length - 1]?.focus();
        } else if (invalid) {
            root.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
                ?.focus();
        }
    }, [rows.length, invalid]);
    const update = (id: number, field: "alias" | "upstream", value: string) =>
        onChange(
            rows.map((row) => row.id === id ? { ...row, [field]: value } : row),
        );
    return (
        <div ref={root} class="source-model-map" data-model-map="">
            <div class="source-model-map-heading">
                <span class="field-label" id={`${idPrefix}-title`}>
                    模型映射
                </span>
                <span class="field-help">可选 · {rows.length} / 256</span>
            </div>
            <p class="field-help" id={`${idPrefix}-help`}>
                客户端使用对外模型名，核心转为此渠道的上游模型名。
            </p>
            <div
                class="source-model-map-rows"
                role="group"
                aria-labelledby={`${idPrefix}-title`}
            >
                {rows.map((row, index) => {
                    let aliasInvalid = false;
                    let upstreamInvalid = false;
                    if (invalid) {
                        try {
                            parseSourceModelMap({ [row.alias]: "valid" });
                        } catch {
                            aliasInvalid = true;
                        }
                        try {
                            parseSourceModelMap({ valid: row.upstream });
                        } catch {
                            upstreamInvalid = true;
                        }
                        aliasInvalid ||= rows.some((other) =>
                            other.id !== row.id &&
                            other.alias.trim() === row.alias.trim()
                        );
                    }
                    return (
                        <div class="source-model-map-row" key={row.id}>
                            <label>
                                <span class="field-help">对外模型名</span>
                                <input
                                    name={`model-alias-${row.id}`}
                                    data-model-alias=""
                                    aria-label={`第 ${index + 1} 行对外模型名`}
                                    aria-describedby={`${idPrefix}-help`}
                                    aria-invalid={aliasInvalid
                                        ? "true"
                                        : undefined}
                                    autoComplete="off"
                                    spellCheck={false}
                                    maxLength={256}
                                    placeholder="例如：fast"
                                    value={row.alias}
                                    disabled={disabled}
                                    onInput={(event) =>
                                        update(
                                            row.id,
                                            "alias",
                                            controlValue(event),
                                        )}
                                />
                            </label>
                            <Icon
                                name="arrow-right"
                                class="source-model-map-arrow"
                            />
                            <label>
                                <span class="field-help">上游模型名</span>
                                <input
                                    name={`model-upstream-${row.id}`}
                                    aria-label={`第 ${index + 1} 行上游模型名`}
                                    aria-describedby={`${idPrefix}-help`}
                                    aria-invalid={upstreamInvalid
                                        ? "true"
                                        : undefined}
                                    autoComplete="off"
                                    spellCheck={false}
                                    maxLength={256}
                                    placeholder="例如：gpt-4.1-mini"
                                    value={row.upstream}
                                    disabled={disabled}
                                    onInput={(event) =>
                                        update(
                                            row.id,
                                            "upstream",
                                            controlValue(event),
                                        )}
                                />
                            </label>
                            <button
                                type="button"
                                class="icon-button"
                                disabled={disabled}
                                aria-label={`删除第 ${index + 1} 行映射`}
                                title="删除映射"
                                onClick={() =>
                                    onChange(
                                        rows.filter((item) =>
                                            item.id !== row.id
                                        ),
                                    )}
                            >
                                <Icon name="close" />
                            </button>
                        </div>
                    );
                })}
            </div>
            <button
                type="button"
                class="text-button source-model-map-add"
                disabled={disabled || rows.length >= 256}
                onClick={() => {
                    focusNewRow.current = true;
                    onChange([...rows, {
                        id: Math.max(-1, ...rows.map((row) => row.id)) + 1,
                        alias: "",
                        upstream: "",
                    }]);
                }}
            >
                <Icon name="plus" /> 添加模型映射
            </button>
        </div>
    );
}
