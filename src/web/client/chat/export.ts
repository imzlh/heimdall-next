import type { ChatConversation, ChatMessage } from "../api/chat.ts";

/** Whole-conversation Markdown: one block per user/assistant message. */
export function conversationToMarkdown(
    conversation: Pick<ChatConversation, "title" | "updatedAt">,
    messages: readonly ChatMessage[],
): string {
    const blocks: string[] = [`# ${conversation.title || "新对话"}`, ""];
    for (const message of messages) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        if (!message.text) continue;
        const author = message.role === "user" ? "你" : "Heimdall";
        blocks.push(
            `## ${author} · ${
                message.createdAt.slice(0, 16).replace("T", " ")
            }`,
            "",
            message.text.trim(),
            "",
        );
    }
    blocks.push(
        `---`,
        "",
        `导出于 ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    );
    return blocks.join("\n");
}

/** Filename-safe slug: keep CJK/word characters, clamp the length. */
function exportFilename(title: string, id: string): string {
    const slug = (title || "对话").replace(/[\\/:*?"<>|\s]+/g, "-").replace(
        /^-+|-+$/g,
        "",
    );
    return `heimdall-${slug.slice(0, 40) || id.slice(0, 8)}.md`;
}

export function downloadConversation(
    conversation: Pick<ChatConversation, "id" | "title" | "updatedAt">,
    messages: readonly ChatMessage[],
): void {
    if (!conversation.id || !messages.length) return;
    const markdown = conversationToMarkdown(conversation, messages);
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exportFilename(conversation.title, conversation.id);
    anchor.click();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
