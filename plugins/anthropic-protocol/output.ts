import {
    type ContentPart,
    type GenerationRequest,
    type JsonObject,
    type JsonValue,
    type Message,
    type OperationRequest,
    ProtocolError,
    type StreamFrame,
    type ToolCallPart,
    type Usage,
} from "@heimdall/contracts";
import {
    applyFrame,
    type ConversationState,
    initialState,
} from "@heimdall/hip";
import {
    asObject,
    generationPayload,
    isPublicReasoning,
    isTerminalStatus,
    parseJsonText,
    sanitizeJson,
} from "./shared.ts";

export async function materialize(
    events: AsyncIterable<StreamFrame>,
    requestId: string,
): Promise<{ state?: ConversationState; id: string }> {
    let state: ConversationState | undefined;
    let id = `msg-${requestId}`;
    for await (const frame of events) {
        id = frame.streamId;
        state ??= initialState(frame.streamId, requestId);
        state = applyFrame(state, frame);
    }
    if (!state || !isTerminalStatus(state.status)) {
        throw new ProtocolError(
            502,
            "source stream ended without a terminal event",
            "stream_incomplete",
        );
    }
    return { state, id };
}

export async function serializeAnthropicJson(
    input: OperationRequest,
    events: AsyncIterable<StreamFrame>,
): Promise<Response> {
    try {
        const materialized = await materialize(events, input.requestId);
        if (materialized.state?.error) {
            return anthropicErrorResponse(materialized.state.error);
        }
        if (materialized.state?.status === "cancelled") {
            return anthropicErrorResponse({
                code: "request_cancelled",
                message: "request was cancelled",
                status: 499,
            });
        }
        return Response.json(buildMessageResponse(
            generationPayload(input),
            materialized.state,
            materialized.id,
        ));
    } catch (error) {
        const protocolError = protocolErrorInfo(error);
        if (protocolError) {
            return anthropicErrorResponse({
                code: protocolError.code,
                message: protocolError.message,
                status: protocolError.status,
            });
        }
        throw error;
    }
}

export function buildMessageResponse(
    request: GenerationRequest,
    state: ConversationState | undefined,
    id: string,
): Record<string, unknown> {
    const message = assistantMessage(state);
    return {
        id,
        type: "message",
        role: "assistant",
        model: request.model ?? "",
        content: message ? toAnthropicContent(message.parts) : [],
        stop_reason: anthropicStopReason(
            message?.finishReason ?? state?.finishReason,
            message?.parts ?? [],
        ),
        stop_sequence: null,
        usage: toAnthropicUsage(state?.usage),
    };
}

export function assistantMessage(
    state: ConversationState | undefined,
): Message | undefined {
    if (!state) return undefined;
    const messages = Object.values(state.messages);
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.role === "assistant") return messages[index];
    }
    return undefined;
}

export function toAnthropicContent(
    parts: readonly ContentPart[],
): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    for (const part of parts) {
        if (part.type === "text") {
            const raw = asObject(part.extensions?.raw);
            result.push({
                type: "text",
                text: part.text,
                ...(raw?.citations === undefined
                    ? {}
                    : { citations: raw.citations }),
            });
        } else if (part.type === "tool_call") {
            result.push({
                type: "tool_use",
                id: part.callId,
                name: part.name,
                input: parseArguments(part),
            });
        } else if (part.type === "reasoning" && isPublicReasoning(part)) {
            result.push({
                type: "thinking",
                thinking: part.text,
                ...(part.signature === undefined
                    ? {}
                    : { signature: part.signature }),
            });
        } else if (
            part.type === "reasoning" && part.visibility === "redacted"
        ) {
            const raw = asObject(part.extensions?.raw);
            result.push({
                type: "redacted_thinking",
                data: typeof raw?.data === "string" ? raw.data : "",
            });
        } else if (part.type === "refusal") {
            result.push({ type: "text", text: part.text });
        } else if (part.type === "image") {
            result.push({
                type: "image",
                source: part.source.dataBase64 !== undefined
                    ? {
                        type: "base64",
                        media_type: part.source.mediaType,
                        data: part.source.dataBase64,
                    }
                    : {
                        type: "url",
                        url: part.source.uri ?? "",
                    },
            });
        } else if (part.type === "document") {
            const source = part.source.dataBase64 !== undefined
                ? {
                    type: "base64",
                    media_type: part.source.mediaType,
                    data: part.source.dataBase64,
                }
                : { type: "url", url: part.source.uri ?? "" };
            result.push({
                type: "document",
                source,
                ...(part.title === undefined ? {} : { title: part.title }),
            });
        } else if (part.type === "custom") {
            const raw = asObject(part.extensions?.raw);
            result.push(
                raw && typeof raw.type === "string"
                    ? sanitizeJson(raw) as JsonObject
                    : { type: part.name, value: part.value },
            );
        }
    }
    return result;
}

export function parseArguments(part: ToolCallPart): JsonValue {
    if (part.arguments !== undefined) return part.arguments;
    return parseJsonText(part.argumentsText) ?? {};
}

export function toAnthropicUsage(
    usage: Usage | undefined,
): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (usage?.inputTokens !== undefined) {
        result.input_tokens = usage.inputTokens;
    }
    if (usage?.outputTokens !== undefined) {
        result.output_tokens = usage.outputTokens;
    }
    if (usage?.cacheWriteTokens !== undefined) {
        result.cache_creation_input_tokens = usage.cacheWriteTokens;
    }
    if (usage?.cachedInputTokens !== undefined) {
        result.cache_read_input_tokens = usage.cachedInputTokens;
    }
    if (usage?.extensions !== undefined) {
        const raw = asObject(usage.extensions.raw);
        if (raw?.service_tier !== undefined) {
            result.service_tier = raw.service_tier;
        }
    }
    return result;
}

export function anthropicErrorResponse(
    error: { code?: string; message?: string; status?: number },
): Response {
    const status = error.status !== undefined && error.status >= 400 &&
            error.status <= 599
        ? error.status
        : 502;
    return Response.json({
        type: "error",
        error: {
            type: mapAnthropicErrorType(error.code ?? "api_error"),
            message: error.message ?? "upstream request failed",
        },
    }, { status });
}

export function anthropicStreamError(
    error: unknown,
): { type: string; message: string } {
    const protocolError = protocolErrorInfo(error);
    if (protocolError) {
        return {
            type: mapAnthropicErrorType(protocolError.code),
            message: protocolError.message,
        };
    }
    return {
        type: "api_error",
        message: error instanceof Error ? error.message : String(error),
    };
}

/** Recognize both the public contract error and the temporary HIP bridge error. */
export function protocolErrorInfo(
    error: unknown,
): { status: number; code: string; message: string } | undefined {
    if (error instanceof ProtocolError) {
        return {
            status: error.status,
            code: error.code,
            message: error.message,
        };
    }
    if (error instanceof Error && error.name === "ProtocolError") {
        return { status: 502, code: "api_error", message: error.message };
    }
    return undefined;
}

export function mapAnthropicErrorType(code: string): string {
    if (code === "invalid_request" || code === "invalid_internal_payload") {
        return "invalid_request_error";
    }
    if (
        code === "authentication_error" || code === "permission_error" ||
        code === "not_found_error"
    ) return code;
    if (code === "rate_limit" || code === "rate_limit_error") {
        return "rate_limit_error";
    }
    if (code === "overloaded_error") return "overloaded_error";
    if (code === "request_cancelled" || code === "timeout_error") {
        return "timeout_error";
    }
    return "api_error";
}

export function anthropicStopReason(
    reason: string | undefined,
    parts: readonly ContentPart[],
): string | null {
    if (
        reason === "tool_call" || reason === "tool_use" ||
        parts.some((part) => part.type === "tool_call")
    ) return "tool_use";
    if (reason === "max_tokens" || reason === "length") return "max_tokens";
    if (reason === "stop_sequence") return "stop_sequence";
    if (reason === "pause_turn") return "pause_turn";
    if (reason === "model_context_window_exceeded") {
        return "model_context_window_exceeded";
    }
    return "end_turn";
}
