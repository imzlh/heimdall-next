import type { ChatConversation } from "@heimdall/admin-contracts/chat.ts";

/** Strict JSON projection shared by HTTP responses and the SSR boot snapshot. */
export function readChatBranches(
    value: unknown,
): ChatConversation["branches"] {
    if (!Array.isArray(value) || value.length > 10_000) return;
    const branches: NonNullable<ChatConversation["branches"]> = [];
    const ids = new Set<string>();
    let selected = false;
    for (const branch of value) {
        if (
            !branch || typeof branch !== "object" || Array.isArray(branch) ||
            typeof branch.messageId !== "string" ||
            !branch.messageId.trim() || branch.messageId.length > 512 ||
            ids.has(branch.messageId) ||
            typeof branch.label !== "string" || branch.label.length > 512 ||
            typeof branch.selected !== "boolean" ||
            (branch.selected && selected)
        ) return;
        ids.add(branch.messageId);
        if (branch.selected) selected = true;
        branches.push({
            messageId: branch.messageId,
            label: branch.label,
            selected: branch.selected,
        });
    }
    return branches;
}
