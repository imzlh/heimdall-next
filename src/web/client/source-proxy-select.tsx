/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import type {
    ProxyPoolView,
    SourceProxySelection,
} from "@heimdall/admin-contracts/proxies.ts";
import { useId } from "hono/jsx/dom";
import { controlValue } from "./dom.ts";
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
            <label>
                出站代理
                <select
                    name="source-proxy"
                    value={sourceProxyValue(value)}
                    disabled={disabled}
                    aria-describedby={helpId}
                    onChange={(event) =>
                        onChange(sourceProxySelection(controlValue(event)))}
                >
                    <option value="inherit">
                        {sourceProxyLabel({ mode: "inherit" }, pool)}
                    </option>
                    <option value="direct">直连</option>
                    {missing && (
                        <option value={`proxy:${selectedId}`} disabled>
                            {selectedId}（{pool ? "已移除" : "待读取"}）
                        </option>
                    )}
                    {pool?.entries.map((entry) => (
                        <option
                            key={entry.id}
                            value={`proxy:${entry.id}`}
                            disabled={!entry.enabled}
                        >
                            {entry.name}
                            {entry.enabled ? "" : "（已停用）"}
                        </option>
                    ))}
                </select>
            </label>
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
