/**
 * Bound the transcript sent upstream. A long conversation — or a tool loop that
 * re-sends its growing tool records every round — would otherwise push the whole
 * history to the model on every turn. Keep the most recent messages within both
 * a message-count and a text-character budget, always keeping the final message,
 * and never begin the window on a dangling tool result whose originating tool
 * call was trimmed away (upstreams reject a tool message with no matching call).
 */
import type { ChatMessageRecord } from "@heimdall/storage";

export function boundHistory(
    messages: readonly ChatMessageRecord[],
    maxMessages: number,
    maxChars: number,
): readonly ChatMessageRecord[] {
    if (messages.length <= 1) return messages;
    const last = messages.length - 1;
    let start = Math.max(0, messages.length - maxMessages);
    let used = 0;
    for (let i = last; i >= start; i--) {
        used += messages[i]!.text.length;
        if (used > maxChars && i < last) {
            start = i + 1;
            break;
        }
    }
    while (start < last && messages[start]!.role === "tool") start++;
    return start === 0 ? messages : messages.slice(start);
}
