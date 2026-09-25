import type { ContentPart, StreamEvent } from "@heimdall/hip";
import type { ToolInvocation } from "@heimdall/contracts";

export type ChatToolCall = ToolInvocation;

/** Keep provider reasoning and tool arguments out of the visible chat reply. */
export class ChatResponse {
    text = "";
    readonly #parts = new Map<string, ContentPart>();
    readonly #calls = new Map<string, ChatToolCall>();

    get toolCalls(): ChatToolCall[] {
        return [...this.#calls.values()];
    }

    append(event: StreamEvent): string {
        let delta = "";
        if (event.kind === "part.started") {
            this.#parts.set(
                partKey(event.messageId, event.part.id),
                event.part,
            );
            if (event.part.type === "text" || event.part.type === "refusal") {
                delta = event.part.text;
            } else if (event.part.type === "tool_call") {
                this.#calls.set(event.part.callId, {
                    callId: event.part.callId,
                    name: event.part.name,
                    argumentsText: event.part.argumentsText,
                });
            }
        } else if (
            event.kind === "part.delta" && typeof event.delta === "string"
        ) {
            const part = this.#parts.get(
                partKey(event.messageId, event.partId),
            );
            if (part?.type === "tool_call") {
                const call = this.#calls.get(part.callId)!;
                this.#calls.set(part.callId, {
                    ...call,
                    argumentsText: call.argumentsText + event.delta,
                });
            } else if (
                part === undefined || part.type === "text" ||
                part.type === "refusal"
            ) {
                // Legacy sources can emit plain text deltas without announcing
                // a part. Announced non-text parts never use this fallback.
                delta = event.delta;
            }
        } else if (event.kind === "tool.call") {
            const previous = this.#calls.get(event.callId);
            this.#calls.set(event.callId, {
                callId: event.callId,
                name: event.name,
                argumentsText: event.argumentsText ??
                    (event.arguments === undefined
                        ? previous?.argumentsText ?? ""
                        : JSON.stringify(event.arguments)),
            });
        }
        this.text += delta;
        return delta;
    }
}

function partKey(messageId: string, partId: string): string {
    return JSON.stringify([messageId, partId]);
}
