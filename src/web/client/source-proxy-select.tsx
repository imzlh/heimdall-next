/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import type {
    ProxyPoolView,
    SourceProxySelection,
} from "@heimdall/admin-contracts/proxies.ts";
import { useId } from "hono/jsx/dom";
import { Dropdown } from "./forms/dropdown.tsx";
import {
    PROXY_IMPLEMENTATION_NOTE,
    sourceProxyLabel,
    sourceProxySelection,
    sourceProxyValue,
} from "../shared/proxy-presentation.ts";

export function SourceProxySelect({ value, pool, disabled, onChange }: {
    readonly value?: SourceProxySelection;
    readonly pool?: ProxyPoolView | null;
    readonly disabled?: boolean;
    readonly onChange: (value: SourceProxySelection) => void;
}) {
    const helpId = `source-proxy-help-${useId()}`;
    const selectedId = value?.mode === "proxy" ? value.proxyId : undefined;
    const missing = selectedId &&
        !pool?.entries.some((entry) => entry.id === selectedId);
    return (
        <div class="source-proxy-field">
            <span class="field-label">出站代理</span>
            <Dropdown
                value={sourceProxyValue(value)}
                disabled={disabled}
                describedBy={helpId}
                ariaLabel="出站代理"
                dataName="source-proxy"
                options={[
                    {
                        value: "inherit",
                        label: sourceProxyLabel({ mode: "inherit" }, pool),
                    },
                    { value: "direct", label: "直连" },
                    ...(missing
                        ? [{
                            value: `proxy:${selectedId}`,
                            label: `${selectedId}（${
                                pool ? "已移除" : "待读取"
                            }）`,
                            disabled: true,
                        }]
                        : []),
                    ...(pool?.entries ?? []).map((entry) => ({
                        value: `proxy:${entry.id}`,
                        label: `${entry.name}${
                            entry.enabled ? "" : "（已停用）"
                        }`,
                        disabled: !entry.enabled,
                    })),
                ]}
                onChange={(next) => onChange(sourceProxySelection(next))}
            />
            <p class="field-help" id={helpId}>
                {PROXY_IMPLEMENTATION_NOTE}
            </p>
            {!pool && (
                <p class="field-help">
                    代理池尚未读取，可先选择继承全局或直连。
                </p>
            )}
        </div>
    );
}
