import { chatUiContext } from "@heimdall/admin-contracts/chat-ui.ts";
import type { ChatInitial } from "@heimdall/admin-contracts/chat.ts";
import {
    selectUiContributions,
    uiContributionKey,
} from "@heimdall/admin-contracts/ui.ts";
import { PluginSlot } from "./slots.tsx";

export function ChatSlots(
    { initial, slot }: {
        initial: ChatInitial;
        slot: "chat.composer" | "chat.sidebar";
    },
) {
    const extensions = initial.extensions;
    if (!initial.authenticated || !initial.available || !extensions) {
        return null;
    }
    const entries = selectUiContributions(extensions.contributions, slot);
    if (!entries.length) return null;
    return (
        <div
            class={`chat-plugin-slots plugin-slots-${
                slot.replaceAll(".", "-")
            }`}
            data-ui-slot={slot}
            aria-label={slot === "chat.composer" ? "对话能力" : "会话插件"}
        >
            {entries.map((contribution) => (
                <PluginSlot
                    key={uiContributionKey(contribution)}
                    contribution={contribution}
                    context={chatUiContext({
                        conversation: initial.conversation,
                        model: initial.selectedModel ?? initial.models[0] ?? "",
                        messageCount: initial.messages.length,
                        busy: false,
                        tools: extensions.tools,
                    }, contribution)}
                    policy={extensions.policy}
                />
            ))}
        </div>
    );
}
