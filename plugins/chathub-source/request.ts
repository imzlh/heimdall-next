import type { GenerationRequest, OperationRequest } from "@heimdall/contracts";
import { flattenConversation } from "./tools.ts";

export function generationPayload(input: OperationRequest): GenerationRequest {
    if (
        input.operation !== "generation.create" ||
        !("messages" in input.payload)
    ) {
        throw new TypeError("ChatHub supports generation.create only");
    }
    const request = input.payload;
    if (request.responseFormat && request.responseFormat !== "text") {
        throw new TypeError("ChatHub does not guarantee structured output");
    }
    for (const message of request.messages) {
        for (const part of message.parts) {
            if (
                ![
                    "text",
                    "reasoning",
                    "tool_call",
                    "tool_result",
                    "json",
                    "refusal",
                ].includes(part.type)
            ) {
                throw new TypeError(
                    "ChatHub currently supports text and tool messages only",
                );
            }
        }
    }
    return request;
}

export function conversationMessages(
    request: GenerationRequest,
): Record<string, unknown>[] {
    const messages: Record<string, unknown>[] = [];
    if (request.instructions) {
        messages.push({ role: "system", content: request.instructions });
    }
    for (const message of request.messages) {
        const text: string[] = [];
        const calls: unknown[] = [];
        for (const part of message.parts) {
            if (part.type === "text" || part.type === "refusal") {
                text.push(part.text);
            }
            if (part.type === "json") {
                text.push(part.text ?? JSON.stringify(part.value));
            }
            if (part.type === "tool_call") {
                calls.push({
                    id: part.callId,
                    type: "function",
                    function: {
                        name: part.name,
                        arguments: part.argumentsText,
                    },
                });
            }
            if (part.type === "tool_result") {
                messages.push({
                    role: "tool",
                    tool_call_id: part.callId,
                    content: part.parts?.map((item) =>
                        "text" in item ? item.text : ""
                    ).join("") ??
                        JSON.stringify(part.result ?? part.error ?? null),
                });
            }
        }
        if (text.length || calls.length) {
            messages.push({
                role: message.role,
                content: text.join("\n"),
                ...(calls.length ? { tool_calls: calls } : {}),
            });
        }
    }
    return messages;
}

export function conversationText(request: GenerationRequest): string {
    return flattenConversation(conversationMessages(request));
}
