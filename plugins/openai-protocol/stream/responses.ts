import {
    type GenerateRequest,
    type StreamFrame,
    type ToolCallPart,
} from "@heimdall/contracts";
import type { ConversationState } from "@heimdall/hip";
import { isPublicReasoning, toUnixSeconds } from "../wire.ts";
import {
    buildResponsesResponse,
    toResponsesMessageItem,
    toResponsesReasoning,
    toResponsesToolCall,
} from "../response.ts";
import { type ResponsesTracker } from "./types.ts";
import {
    ensureResponseMessage,
    responseOutputIndex,
    type ResponsesEvent,
} from "./helpers.ts";

export { ensureResponseMessage, responseOutputIndex } from "./helpers.ts";

export function responsesStreamEvents(
    frame: StreamFrame,
    state: ConversationState,
    request: GenerateRequest,
    tracker: ResponsesTracker,
): ResponsesEvent[] {
    const event = frame.event;
    const outputs: ResponsesEvent[] = [];
    const emit = (type: string, fields: Record<string, unknown>) => {
        outputs.push({
            event: type,
            data: {
                type,
                sequence_number: tracker.nextSequenceNumber++,
                ...fields,
            },
        });
    };

    if (event.kind === "run.started") {
        const response = buildResponsesResponse(
            request,
            state,
            frame.streamId,
            toUnixSeconds(frame.timestamp),
            "in_progress",
        );
        emit("response.created", { response });
        emit("response.in_progress", { response });
        return outputs;
    }
    if (event.kind === "part.started") {
        const part = event.part;
        if (part.type === "text" || part.type === "refusal") {
            const outputIndex = ensureResponseMessage(
                outputs,
                tracker,
                state.messages[event.messageId],
            );
            const contentIndex =
                tracker.nextContentIndexes.get(event.messageId) ?? 0;
            tracker.contentIndexes.set(part.id, contentIndex);
            tracker.nextContentIndexes.set(event.messageId, contentIndex + 1);
            emit("response.content_part.added", {
                item_id: event.messageId,
                output_index: outputIndex,
                content_index: contentIndex,
                part: part.type === "text"
                    ? { type: "output_text", text: "", annotations: [] }
                    : { type: "refusal", refusal: "" },
            });
        } else if (part.type === "tool_call") {
            const outputIndex = responseOutputIndex(tracker, part.id);
            emit("response.output_item.added", {
                output_index: outputIndex,
                item: toResponsesToolCall(part),
            });
        } else if (part.type === "reasoning" && isPublicReasoning(part)) {
            const outputIndex = responseOutputIndex(tracker, part.id);
            emit("response.output_item.added", {
                output_index: outputIndex,
                item: toResponsesReasoning(part),
            });
            emit("response.reasoning_summary_part.added", {
                item_id: part.id,
                output_index: outputIndex,
                summary_index: 0,
                part: { type: "summary_text", text: "" },
            });
        }
        return outputs;
    }
    if (event.kind === "part.delta") {
        const message = state.messages[event.messageId];
        const part = message?.parts.find((candidate) =>
            candidate.id === event.partId
        );
        if (!part || typeof event.delta !== "string") return outputs;
        if (part.type === "text") {
            emit("response.output_text.delta", {
                item_id: event.messageId,
                output_index: responseOutputIndex(tracker, event.messageId),
                content_index: tracker.contentIndexes.get(part.id) ?? 0,
                delta: event.delta,
                logprobs: [],
            });
        } else if (part.type === "refusal") {
            emit("response.refusal.delta", {
                item_id: event.messageId,
                output_index: responseOutputIndex(tracker, event.messageId),
                content_index: tracker.contentIndexes.get(part.id) ?? 0,
                delta: event.delta,
            });
        } else if (part.type === "tool_call") {
            emit("response.function_call_arguments.delta", {
                item_id: part.id,
                output_index: responseOutputIndex(tracker, part.id),
                delta: event.delta,
            });
        } else if (part.type === "reasoning" && isPublicReasoning(part)) {
            emit("response.reasoning_summary_text.delta", {
                item_id: part.id,
                output_index: responseOutputIndex(tracker, part.id),
                summary_index: 0,
                delta: event.delta,
            });
        }
        return outputs;
    }
    if (event.kind === "part.completed") {
        const message = state.messages[event.messageId];
        const part = message?.parts.find((candidate) =>
            candidate.id === event.partId
        );
        if (!part) return outputs;
        if (part.type === "text") {
            const outputIndex = responseOutputIndex(tracker, event.messageId);
            const contentIndex = tracker.contentIndexes.get(part.id) ?? 0;
            emit("response.output_text.done", {
                item_id: event.messageId,
                output_index: outputIndex,
                content_index: contentIndex,
                text: part.text,
                logprobs: [],
            });
            emit("response.content_part.done", {
                item_id: event.messageId,
                output_index: outputIndex,
                content_index: contentIndex,
                part: { type: "output_text", text: part.text, annotations: [] },
            });
        } else if (part.type === "refusal") {
            const outputIndex = responseOutputIndex(tracker, event.messageId);
            const contentIndex = tracker.contentIndexes.get(part.id) ?? 0;
            emit("response.refusal.done", {
                item_id: event.messageId,
                output_index: outputIndex,
                content_index: contentIndex,
                refusal: part.text,
            });
            emit("response.content_part.done", {
                item_id: event.messageId,
                output_index: outputIndex,
                content_index: contentIndex,
                part: { type: "refusal", refusal: part.text },
            });
        } else if (part.type === "tool_call") {
            const outputIndex = responseOutputIndex(tracker, part.id);
            emit("response.function_call_arguments.done", {
                item_id: part.id,
                output_index: outputIndex,
                arguments: part.argumentsText,
            });
            emit("response.output_item.done", {
                output_index: outputIndex,
                item: toResponsesToolCall(part),
            });
        } else if (part.type === "reasoning" && isPublicReasoning(part)) {
            const outputIndex = responseOutputIndex(tracker, part.id);
            emit("response.reasoning_summary_text.done", {
                item_id: part.id,
                output_index: outputIndex,
                summary_index: 0,
                text: part.text,
            });
            emit("response.reasoning_summary_part.done", {
                item_id: part.id,
                output_index: outputIndex,
                summary_index: 0,
                part: { type: "summary_text", text: part.text },
            });
            emit("response.output_item.done", {
                output_index: outputIndex,
                item: toResponsesReasoning(part),
            });
        }
        return outputs;
    }
    if (event.kind === "message.completed") {
        const outputIndex = tracker.outputIndexes.get(event.messageId);
        const message = state.messages[event.messageId];
        if (outputIndex !== undefined && message) {
            emit("response.output_item.done", {
                output_index: outputIndex,
                item: toResponsesMessageItem(message),
            });
        }
        return outputs;
    }
    if (event.kind === "tool.call") {
        const part: ToolCallPart = {
            id: event.callId,
            type: "tool_call",
            callId: event.callId,
            name: event.name,
            argumentsText: event.argumentsText ??
                (event.arguments === undefined
                    ? ""
                    : JSON.stringify(event.arguments)),
            arguments: event.arguments,
            status: "completed",
            done: true,
        };
        const outputIndex = responseOutputIndex(tracker, part.id);
        emit("response.output_item.added", {
            output_index: outputIndex,
            item: toResponsesToolCall(part),
        });
        emit("response.output_item.done", {
            output_index: outputIndex,
            item: toResponsesToolCall(part),
        });
        return outputs;
    }
    if (event.kind === "run.completed") {
        emit("response.completed", {
            response: buildResponsesResponse(
                request,
                state,
                frame.streamId,
                toUnixSeconds(frame.timestamp),
                "completed",
            ),
        });
        return outputs;
    }
    if (event.kind === "run.error") {
        emit("response.failed", {
            response: buildResponsesResponse(
                request,
                state,
                frame.streamId,
                toUnixSeconds(frame.timestamp),
                "failed",
            ),
        });
        return outputs;
    }
    if (event.kind === "run.cancelled") {
        emit("response.incomplete", {
            response: buildResponsesResponse(
                request,
                state,
                frame.streamId,
                toUnixSeconds(frame.timestamp),
                "incomplete",
                "cancelled",
            ),
        });
        return outputs;
    }
    return outputs;
}
