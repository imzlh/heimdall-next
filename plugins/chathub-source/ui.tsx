/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { flushSync, render, useState } from "hono/jsx/dom";
import {
    isUiJsonObject,
    type UiContext,
} from "@heimdall/admin-contracts/ui.ts";
import { CHATHUB_METER_LABELS } from "./account-view.ts";

/** The source.status bridge supplies only this source's public plugin snapshot. */
export function mount(element: HTMLElement, context: UiContext): () => void {
    if (context.sourcePluginId !== "heimdall.source.chathub") {
        throw new TypeError(
            "ChatHub account information requires its own source",
        );
    }
    const plugin = context.data.plugin;
    const data = isUiJsonObject(plugin) && isUiJsonObject(plugin.account)
        ? plugin.account
        : {};
    let unmount: (() => void) | undefined;
    let disposed = false;
    function Root() {
        const [active, setActive] = useState(true);
        unmount = () => setActive(false);
        return active ? <AccountInformation data={data} /> : null;
    }
    render(<Root />, element);
    return () => {
        if (disposed) return;
        disposed = true;
        flushSync(() => unmount?.());
        unmount = undefined;
    };
}

function AccountInformation({ data }: { data: Record<string, unknown> }) {
    const meters = Array.isArray(data.meters)
        ? data.meters.filter(isUiJsonObject).slice(0, 10)
        : [];
    const balances = meters.filter((meter) =>
        typeof meter.name === "string" &&
        Object.hasOwn(CHATHUB_METER_LABELS, meter.name) &&
        typeof meter.remaining === "number" &&
        Number.isFinite(meter.remaining) && meter.remaining >= 0
    );
    const restrictions = meters.filter((meter) =>
        meter.name === "access" && meter.blocked === true
    );
    const diagnostics = [
        ...new Set(
            restrictions.flatMap((meter) =>
                typeof meter.error === "string" && meter.error.trim()
                    ? [meter.error.slice(0, 160)]
                    : []
            ),
        ),
    ];
    const updatedAt = typeof data.updatedAt === "string" &&
            Number.isFinite(Date.parse(data.updatedAt))
        ? data.updatedAt
        : undefined;
    return (
        <section aria-label="ChatHub 账号信息" class="slot-content">
            <p class="slot-text">
                {typeof data.label === "string" ? data.label : "Microsoft 账号"}
            </p>
            {balances.map((meter) => (
                <dl key={meter.name as string} class="slot-metrics">
                    <div
                        class={`slot-metric tone-${
                            meter.blocked === true ? "warning" : "neutral"
                        }`}
                    >
                        <dt>{CHATHUB_METER_LABELS[meter.name as string]}</dt>
                        <dd>
                            <strong>{meter.remaining as number}</strong>
                            {meter.blocked === true && (
                                <small>
                                    当前不可用
                                </small>
                            )}
                        </dd>
                    </div>
                </dl>
            ))}
            {restrictions.length > 0 && (
                <span class="slot-badge tone-warning">部分能力受限</span>
            )}
            {diagnostics.length > 0 && (
                <details class="slot-text">
                    <summary>限制详情</summary>
                    {diagnostics.map((error) => <p key={error}>{error}</p>)}
                </details>
            )}
            {balances.length === 0 && restrictions.length === 0 && (
                <p class="slot-text">尚无额度快照，完成一次对话后更新。</p>
            )}
            {updatedAt && (
                <p class="field-help">
                    最近更新：<time dateTime={updatedAt}>
                        {new Date(updatedAt).toLocaleString("zh-CN")}
                    </time>
                </p>
            )}
        </section>
    );
}
