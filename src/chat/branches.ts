import type { ChatStore, ConversationRecord } from "@heimdall/storage";

/** A conversation menu can reach every retained path, even after turn deletion. */
export function presentConversation(
    store: ChatStore,
    id: string,
):
    | (ConversationRecord & {
        branches?: { messageId: string; label: string; selected: boolean }[];
    })
    | null {
    const conversation = store.getConversation(id);
    if (!conversation) return null;
    const messages = store.listAllMessages(id);
    const parents = new Set(
        messages.map((message) => message.parentId).filter(Boolean),
    );
    const leaves = messages.filter((message) => !parents.has(message.id));
    if (leaves.length < 2) return conversation;
    return {
        ...conversation,
        branches: leaves.map((message) => ({
            messageId: message.id,
            label: message.callId
                ? "工具调用"
                : message.text.trim().slice(0, 80) || "空回复",
            selected: message.id === conversation.activeMessageId,
        })),
    };
}
