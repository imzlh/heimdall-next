import { type GenerateRequest, type StreamFrame } from "@heimdall/contracts";
import type { ConversationState } from "@heimdall/hip";
import {
    chatFinishReason,
    isPublicReasoning,
    statusPartSummary,
    toolPartIndex,
    toUnixSeconds,
    wantsStreamUsage,
} from "../wire.ts";
import { toOpenAIUsage } from "../response.ts";

export function chatStreamEvents(
    frame: StreamFrame,
    state: ConversationState,
    request: GenerateRequest,
): unknown[] {
    const event = frame.event;
    const base = {
        id: frame.streamId,
        object: "chat.completion.chunk",
        created: toUnixSeconds(frame.timestamp),
        model: request.model ?? "",
    };
    if (
        event.kind === "message.started" && event.message.role === "assistant"
    ) {
        return [{
            ...base,
            choices: [{
                index: 0,
                delta: { role: "assistant", content: "" },
                finish_reason: null,
            }],
        }];
    }
    if (event.kind === "part.started" && event.part.type === "tool_call") {
        const message = state.messages[event.messageId];
        return [{
            ...base,
            choices: [{
                index: 0,
                delta: {
                    tool_calls: [{
                        index: toolPartIndex(message, event.part.id),
                        id: event.part.callId,
                        type: "function",
                        function: { name: event.part.name, arguments: "" },
                    }],
                },
                finish_reason: null,
            }],
        }];
    }
    if (event.kind === "part.started") {
        // Cloud activity has no structured OpenAI field; surface its
        // pre-rendered summary to compatible clients as a content line.
        const summary = statusPartSummary(event.part);
        if (summary !== undefined) {
            return [{
                ...base,
                choices: [{
                    index: 0,
                    delta: { content: summary + "\n" },
                    finish_reason: null,
                }],
            }];
        }
    }
    if (event.kind === "part.delta") {
        const message = state.messages[event.messageId];
        const part = message?.parts.find((candidate) =>
            candidate.id === event.partId
        );
        if (typeof event.delta !== "string" || !part) return [];
        if (part.type === "text") {
            return [{
                ...base,
                choices: [{
                    index: 0,
                    delta: { content: event.delta },
                    finish_reason: null,
                }],
            }];
        }
        if (part.type === "reasoning" && isPublicReasoning(part)) {
            return [{
                ...base,
                choices: [{
                    index: 0,
                    delta: { reasoning_content: event.delta },
                    finish_reason: null,
                }],
            }];
        }
        if (part.type === "refusal") {
            return [{
                ...base,
                choices: [{
                    index: 0,
                    delta: { refusal: event.delta },
                    finish_reason: null,
                }],
            }];
        }
        if (part.type === "tool_call") {
            return [{
                ...base,
                choices: [{
                    index: 0,
                    delta: {
                        tool_calls: [{
                            index: toolPartIndex(message, part.id),
                            function: { arguments: event.delta },
                        }],
                    },
                    finish_reason: null,
                }],
            }];
        }
    }
    if (event.kind === "tool.call") {
        const message = state.messages[event.messageId];
        const part = message?.parts.find((candidate) =>
            candidate.type === "tool_call" && candidate.callId === event.callId
        );
        return [{
            ...base,
            choices: [{
                index: 0,
                delta: {
                    tool_calls: [{
                        index: toolPartIndex(message, part?.id ?? event.callId),
                        id: event.callId,
                        type: "function",
                        function: {
                            name: event.name,
                            arguments: event.argumentsText ??
                                (event.arguments === undefined
                                    ? ""
                                    : JSON.stringify(event.arguments)),
                        },
                    }],
                },
                finish_reason: null,
            }],
        }];
    }
    if (event.kind === "message.completed") {
        const message = state.messages[event.messageId];
        return [{
            ...base,
            choices: [{
                index: 0,
                delta: {},
                finish_reason: chatFinishReason(
                    event.finishReason,
                    message?.parts ?? [],
                ),
            }],
        }];
    }
    if (event.kind === "usage" && wantsStreamUsage(request)) {
        return [{
            ...base,
            choices: [],
            usage: toOpenAIUsage(event.usage, "chat"),
        }];
    }
    if (event.kind === "run.error") {
        return [{
            error: {
                message: event.error.message,
                type: event.error.code,
                code: event.error.providerCode ?? event.error.code,
            },
        }];
    }
    if (event.kind === "run.cancelled") {
        return [{
            error: {
                message: "request was cancelled",
                type: "request_cancelled",
                code: "request_cancelled",
            },
        }];
    }
    return [];
}
