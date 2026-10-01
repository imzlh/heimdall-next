import {
    resolveUiBlock,
    resolveUiRender,
    safeUiHref,
    selectUiContributions,
    uiContributionKey,
} from "@heimdall/admin-contracts/ui.ts";
import type {
    UiBlock,
    UiContext,
    UiContribution,
    UiPolicy,
    UiSlot,
} from "@heimdall/admin-contracts/ui.ts";

export interface PluginSlotProps {
    readonly contribution: UiContribution;
    readonly context: UiContext;
    readonly policy?: UiPolicy;
}

export interface PluginSlotsProps {
    readonly slot: UiSlot;
    readonly contributions: readonly UiContribution[];
    readonly context: UiContext;
    readonly policy?: UiPolicy;
}

function SchemaBlock({ block, index }: { block: UiBlock; index: number }) {
    switch (block.kind) {
        case "metric":
            return (
                <div class={`slot-metric tone-${block.tone ?? "neutral"}`}>
                    <dt>{block.label}</dt>
                    <dd>
                        <strong>{block.value}</strong>
                        {block.unit && <small>{block.unit}</small>}
                    </dd>
                </div>
            );
        case "text":
            return <p class="slot-text">{block.text}</p>;
        case "badge":
            return (
                <span class={`slot-badge tone-${block.tone ?? "neutral"}`}>
                    {block.label}
                </span>
            );
        case "link":
            return safeUiHref(block.href)
                ? <a class="text-button" href={block.href}>{block.label}</a>
                : <span>{block.label}</span>;
        case "action":
            return (
                <button
                    type="button"
                    class="secondary-button"
                    data-ui-action-index={index}
                    disabled
                    title="交互加载后可用"
                >
                    {block.label}
                </button>
            );
        case "toggle":
            return (
                <button
                    type="button"
                    class="slot-toggle"
                    role="switch"
                    aria-checked={block.checked ? "true" : "false"}
                    data-ui-action-index={index}
                    disabled
                    title="交互加载后可用"
                >
                    <span>{block.label}</span>
                    <span class="slot-toggle-track" aria-hidden="true" />
                </button>
            );
    }
}

/** No plugin code executes during SSR; executable contributions retain fallback. */
export function PluginSlot({ contribution, context, policy }: PluginSlotProps) {
    const key = uiContributionKey(contribution);
    const mode = resolveUiRender(contribution, policy);
    return (
        <article
            class={`plugin-slot plugin-slot-${
                contribution.slot.replaceAll(".", "-")
            }`}
            data-ui-extension={key}
            data-ui-mode={mode.kind}
            aria-label={contribution.title}
        >
            <header class="slot-heading">
                <h3>{contribution.title}</h3>
                <span class="slot-attribution">{contribution.pluginId}</span>
            </header>
            {contribution.description && (
                <p class="slot-description">{contribution.description}</p>
            )}
            <div class="slot-content" data-ui-fallback="">
                {contribution.schema.blocks.map((block, index) =>
                    block.kind === "metric"
                        ? (
                            <dl class="slot-metrics" key={index}>
                                <SchemaBlock
                                    block={resolveUiBlock(block, context)}
                                    index={index}
                                />
                            </dl>
                        )
                        : (
                            <SchemaBlock
                                key={index}
                                block={resolveUiBlock(block, context)}
                                index={index}
                            />
                        )
                )}
            </div>
            <div class="slot-mount" data-ui-mount="" hidden />
            <p class="slot-notice" data-ui-notice="" role="status" hidden />
            {contribution.schema.blocks.some((block) =>
                block.kind === "action" || block.kind === "toggle"
            ) && (
                <noscript>
                    <p class="slot-notice">
                        启用 JavaScript 后可执行插件操作。
                    </p>
                </noscript>
            )}
        </article>
    );
}

export function PluginSlots(
    { slot, contributions, context, policy }: PluginSlotsProps,
) {
    const entries = selectUiContributions(contributions, slot, context);
    if (!entries.length) return null;
    return (
        <div
            class={`plugin-slots plugin-slots-${slot.replaceAll(".", "-")}`}
            data-ui-slot={slot}
        >
            {entries.map((contribution) => (
                <PluginSlot
                    key={uiContributionKey(contribution)}
                    contribution={contribution}
                    context={context}
                    policy={policy}
                />
            ))}
        </div>
    );
}
