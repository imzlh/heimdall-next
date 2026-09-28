import {
    bytesToBase64,
    type GenerationRequest,
    type OperationRequest,
    type RequestContext,
    type StreamFrame,
    type Usage,
} from "@heimdall/contracts";
import {
    applyFrame,
    type ConversationState,
    initialState,
} from "@heimdall/hip";
import {
    anthropicStopReason,
    anthropicStreamError,
    assistantMessage,
    mapAnthropicErrorType,
    toAnthropicUsage,
} from "./output.ts";
import {
    anthropicPartIndex,
    enqueueSse,
    generationPayload,
    isPublicReasoning,
    isTerminalStatus,
    statusPartSummary,
} from "./shared.ts";
import { ProtocolError } from "@heimdall/contracts";

interface StreamTracker {
    messageStarted: boolean;
    messageStopped: boolean;
    lastUsage?: Usage;
}

export function serializeAnthropicStream(
    context: RequestContext,
    input: OperationRequest,
    events: AsyncIterable<StreamFrame>,
): Response {
    const encoder = new TextEncoder();
    const request = generationPayload(input);
    const body = new ReadableStream<Uint8Array>({
        async start(controller) {
            let state: ConversationState | undefined;
            const tracker: StreamTracker = {
                messageStarted: false,
                messageStopped: false,
            };
            try {
                for await (const frame of events) {
                    if (context.signal.aborted) {
                        throw new ProtocolError(
                            499,
                            "request was cancelled",
                            "request_cancelled",
                        );
                    }
                    const previous = state;
                    state ??= initialState(frame.streamId, frame.requestId);
                    state = applyFrame(state, frame);
                    if (state === previous) continue;
                    const output = anthropicStreamEvents(
                        frame,
                        state,
                        request,
                        tracker,
                    );
                    for (const item of output) {
                        enqueueSse(controller, encoder, item.data, item.event);
                    }
                }
                if (!state || !isTerminalStatus(state.status)) {
                    throw new ProtocolError(
                        502,
                        "source stream ended without a terminal event",
                        "stream_incomplete",
                    );
                }
                if (state.status === "completed" && !tracker.messageStopped) {
                    enqueueSse(
                        controller,
                        encoder,
                        { type: "message_stop" },
                        "message_stop",
                    );
                }
            } catch (error) {
                const streamError = anthropicStreamError(error);
                enqueueSse(controller, encoder, {
                    type: "error",
                    error: {
                        type: streamError.type,
                        message: streamError.message,
                    },
                }, "error");
            } finally {
                controller.close();
            }
        },
    });
    return new Response(body, {
        headers: {
            "cache-control": "no-cache",
            "content-type": "text/event-stream; charset=utf-8",
        },
    });
}

function anthropicStreamEvents(
    frame: StreamFrame,
    state: ConversationState,
    request: GenerationRequest,
    tracker: StreamTracker,
): Array<{ event: string; data: unknown }> {
    const event = frame.event;
    const output: Array<{ event: string; data: unknown }> = [];
    const emit = (eventName: string, data: unknown) =>
        output.push({ event: eventName, data });
    if (event.kind === "run.started" && !tracker.messageStarted) {
        emit("message_start", {
            type: "message_start",
            message: {
                id: frame.streamId,
                type: "message",
                role: "assistant",
                model: request.model ?? "",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: toAnthropicUsage(undefined),
            },
        });
        tracker.messageStarted = true;
    } else if (event.kind === "part.started") {
        const part = event.part;
        if (
            part.type === "text" || part.type === "refusal" ||
            (part.type === "reasoning" && isPublicReasoning(part))
        ) {
            emit("content_block_start", {
                type: "content_block_start",
                index: anthropicPartIndex(
                    state.messages[event.messageId],
                    part.id,
                ),
                content_block: part.type === "text" || part.type === "refusal"
                    ? { type: "text", text: "" }
                    : {
                        type: "thinking",
                        thinking: "",
                        ...(part.signature === undefined
                            ? {}
                            : { signature: part.signature }),
                    },
            });
        } else if (part.type === "tool_call") {
            emit("content_block_start", {
                type: "content_block_start",
                index: anthropicPartIndex(
                    state.messages[event.messageId],
                    part.id,
                ),
                content_block: {
                    type: "tool_use",
                    id: part.callId,
                    name: part.name,
                    input: {},
                },
            });
        } else if (part.type === "image") {
            emit("content_block_start", {
                type: "content_block_start",
                index: anthropicPartIndex(
                    state.messages[event.messageId],
                    part.id,
                ),
                content_block: {
                    type: "image",
                    source: part.source.data !== undefined
                        ? {
                            type: "base64",
                            media_type: part.source.mediaType,
                            data: bytesToBase64(part.source.data),
                        }
                        : { type: "url", url: part.source.uri ?? "" },
                },
            });
        } else if (part.type === "document") {
            emit("content_block_start", {
                type: "content_block_start",
                index: anthropicPartIndex(
                    state.messages[event.messageId],
                    part.id,
                ),
                content_block: {
                    type: "document",
                    source: part.source.data !== undefined
                        ? {
                            type: "base64",
                            media_type: part.source.mediaType,
                            data: bytesToBase64(part.source.data),
                        }
                        : { type: "url", url: part.source.uri ?? "" },
                    ...(part.title === undefined ? {} : { title: part.title }),
                },
            });
        } else if (statusPartSummary(part) !== undefined) {
            // Cloud activity has no Anthropic block type; stream its summary as
            // a text block so compatible clients still see it.
            const index = anthropicPartIndex(
                state.messages[event.messageId],
                part.id,
            );
            emit("content_block_start", {
                type: "content_block_start",
                index,
                content_block: { type: "text", text: "" },
            });
            emit("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: {
                    type: "text_delta",
                    text: statusPartSummary(part)!,
                },
            });
        } else if (part.type === "custom") {
            const raw = part.extensions?.raw;
            const contentBlock = raw && typeof raw === "object" &&
                    !Array.isArray(raw) && typeof raw.type === "string"
                ? raw
                : { type: part.name, value: part.value };
            emit("content_block_start", {
                type: "content_block_start",
                index: anthropicPartIndex(
                    state.messages[event.messageId],
                    part.id,
                ),
                content_block: contentBlock,
            });
        }
    } else if (event.kind === "part.delta" && typeof event.delta === "string") {
        const part = state.messages[event.messageId]?.parts.find((candidate) =>
            candidate.id === event.partId
        );
        const index = anthropicPartIndex(
            state.messages[event.messageId],
            event.partId,
        );
        if (part?.type === "text" || part?.type === "refusal") {
            emit("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "text_delta", text: event.delta },
            });
        } else if (part?.type === "tool_call") {
            emit("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: event.delta },
            });
        } else if (part?.type === "reasoning" && isPublicReasoning(part)) {
            emit("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "thinking_delta", thinking: event.delta },
            });
        }
    } else if (event.kind === "part.completed") {
        const part = state.messages[event.messageId]?.parts.find((candidate) =>
            candidate.id === event.partId
        );
        if (
            part &&
            (part.type === "text" || part.type === "refusal" ||
                part.type === "tool_call" ||
                part.type === "image" || part.type === "document" ||
                part.type === "custom" ||
                (part.type === "reasoning" && isPublicReasoning(part)))
        ) {
            emit("content_block_stop", {
                type: "content_block_stop",
                index: anthropicPartIndex(
                    state.messages[event.messageId],
                    event.partId,
                ),
            });
        }
    } else if (event.kind === "tool.call") {
        const message = state.messages[event.messageId];
        const index = anthropicPartIndex(message, event.callId);
        const argumentsText = event.argumentsText ??
            (event.arguments === undefined
                ? ""
                : JSON.stringify(event.arguments));
        emit("content_block_start", {
            type: "content_block_start",
            index,
            content_block: {
                type: "tool_use",
                id: event.callId,
                name: event.name,
                input: {},
            },
        });
        if (argumentsText.length > 0) {
            emit("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: {
                    type: "input_json_delta",
                    partial_json: argumentsText,
                },
            });
        }
        emit("content_block_stop", { type: "content_block_stop", index });
    } else if (event.kind === "usage") {
        tracker.lastUsage = event.usage;
        emit("message_delta", {
            type: "message_delta",
            delta: {},
            usage: toAnthropicUsage(event.usage),
        });
    } else if (event.kind === "run.completed") {
        const usage = state.usage ?? tracker.lastUsage;
        emit("message_delta", {
            type: "message_delta",
            delta: {
                stop_reason: anthropicStopReason(
                    event.finishReason ?? state.finishReason,
                    assistantMessage(state)?.parts ?? [],
                ),
                stop_sequence: null,
            },
            usage: toAnthropicUsage(usage),
        });
        emit("message_stop", { type: "message_stop" });
        tracker.messageStopped = true;
    } else if (event.kind === "run.error") {
        emit("error", {
            type: "error",
            error: {
                type: mapAnthropicErrorType(event.error.code),
                message: event.error.message,
            },
        });
    } else if (event.kind === "run.cancelled") {
        emit("error", {
            type: "error",
            error: { type: "timeout_error", message: "request was cancelled" },
        });
    }
    return output;
}
