/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useId, useRef } from "hono/jsx/dom";
import type { ListedPlugin } from "@heimdall/admin-contracts/console.ts";
import { Icon } from "../shared/icons.tsx";
import { Dropdown } from "./forms/dropdown.tsx";

export function sameSourceMiddleware(
    left?: readonly string[] | null,
    right?: readonly string[] | null,
): boolean {
    if (left == null || right == null) return left == null && right == null;
    return left.length === right.length &&
        left.every((id, index) => id === right[index]);
}

/** Source-owned bindings retain their order and disabled plugin identities. */
export function SourceMiddlewareSelect(
    { value, plugins = [], disabled, onChange }: {
        readonly value?: readonly string[] | null;
        readonly plugins?: readonly ListedPlugin[];
        readonly disabled?: boolean;
        readonly onChange: (value: readonly string[] | null) => void;
    },
) {
    const helpId = `source-middleware-help-${useId()}`;
    const custom = useRef<readonly string[]>(value ?? []);
    if (value != null) custom.current = value;
    const catalog = plugins.filter((plugin) => plugin.kind === "middleware");
    const selected = value ?? [];
    const available = catalog.filter((plugin) => !selected.includes(plugin.id));
    const inherited = value == null;

    function move(index: number, offset: -1 | 1) {
        if (disabled || inherited) return;
        const next = [...selected];
        const target = index + offset;
        if (target < 0 || target >= next.length) return;
        [next[index], next[target]] = [next[target]!, next[index]!];
        onChange(next);
    }

    return (
        <section class="source-middleware-field" aria-label="请求中间件">
            <span class="field-label">请求中间件</span>
            <Dropdown
                value={inherited ? "inherit" : "custom"}
                ariaLabel="中间件使用方式"
                dataName="source-middleware-mode"
                describedBy={helpId}
                disabled={disabled}
                options={[
                    { value: "inherit", label: "继承全局中间件" },
                    { value: "custom", label: "自定义此渠道" },
                ]}
                onChange={(mode) => {
                    if (!disabled) {
                        onChange(
                            mode === "inherit" ? null : [...custom.current!],
                        );
                    }
                }}
            />
            <p class="field-help" id={helpId}>
                {inherited
                    ? "跟随全局中间件的启用状态与执行顺序。"
                    : "按下列顺序执行；留空则不使用中间件。停用的插件会跳过，保留绑定。"}
            </p>
            {!inherited && (
                <>
                    {selected.length > 0 && (
                        <ol
                            class="source-middleware-list"
                            aria-label="中间件执行顺序"
                        >
                            {selected.map((id, index) => {
                                const plugin = catalog.find((plugin) =>
                                    plugin.id === id
                                );
                                const label = plugin?.name || id;
                                return (
                                    <li
                                        key={id}
                                        class="source-middleware-row"
                                        data-middleware-id={id}
                                    >
                                        <span
                                            class="source-middleware-order"
                                            aria-hidden="true"
                                        >
                                            {index + 1}
                                        </span>
                                        <span class="source-middleware-name">
                                            <strong>{label}</strong>
                                            {!plugin || !plugin.enabled
                                                ? (
                                                    <small>
                                                        {plugin
                                                            ? "已停用 · 保留绑定"
                                                            : "插件不可用 · 保留绑定"}
                                                    </small>
                                                )
                                                : <small>{id}</small>}
                                        </span>
                                        <div class="source-middleware-actions">
                                            <button
                                                type="button"
                                                class="icon-button"
                                                title={`上移 ${label}`}
                                                aria-label={`上移 ${label}`}
                                                disabled={disabled ||
                                                    index === 0}
                                                onClick={() => move(index, -1)}
                                            >
                                                <Icon
                                                    name="arrow-up"
                                                    size={15}
                                                />
                                            </button>
                                            <button
                                                type="button"
                                                class="icon-button"
                                                title={`下移 ${label}`}
                                                aria-label={`下移 ${label}`}
                                                disabled={disabled ||
                                                    index ===
                                                        selected.length - 1}
                                                onClick={() => move(index, 1)}
                                            >
                                                <Icon
                                                    name="arrow-down"
                                                    size={15}
                                                />
                                            </button>
                                            <button
                                                type="button"
                                                class="icon-button"
                                                title={`移除 ${label}`}
                                                aria-label={`移除 ${label}`}
                                                disabled={disabled}
                                                onClick={() => {
                                                    if (!disabled) {
                                                        onChange(
                                                            selected.filter((
                                                                item,
                                                            ) => item !== id),
                                                        );
                                                    }
                                                }}
                                            >
                                                <Icon name="close" size={15} />
                                            </button>
                                        </div>
                                    </li>
                                );
                            })}
                        </ol>
                    )}
                    {available.length > 0
                        ? (
                            <Dropdown
                                value=""
                                placeholder="添加中间件…"
                                ariaLabel="添加中间件"
                                dataName="source-middleware-add"
                                disabled={disabled}
                                options={available.map((plugin) => ({
                                    value: plugin.id,
                                    label: `${plugin.name || plugin.id}${
                                        plugin.enabled ? "" : "（已停用）"
                                    }`,
                                }))}
                                onChange={(id) => {
                                    if (
                                        !disabled &&
                                        available.some((plugin) =>
                                            plugin.id === id
                                        )
                                    ) {
                                        onChange([...selected, id]);
                                    }
                                }}
                            />
                        )
                        : selected.length === 0 && (
                            <p class="field-help">
                                暂无可选中间件，此渠道将直接请求上游。
                            </p>
                        )}
                </>
            )}
        </section>
    );
}
