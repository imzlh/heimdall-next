import {
    type ContentPart,
    type GenerateRequest,
    type Message,
    type StreamFrame,
    type ToolCallPart,
    type Usage,
} from "@heimdall/contracts";
import {
    applyFrame,
    type ConversationState,
    initialState,
} from "@heimdall/hip";
import { ProtocolError } from "@heimdall/contracts";
import {
    chatFinishReason,
    isPublicReasoning,
    isTerminalStatus,
    responsesStatus,
    toUnixSeconds,
} from "./wire.ts";

export async function materialize(
    events: AsyncIterable<StreamFrame>,
    requestId: string,
): Promise<{
    state?: ConversationState;
    id: string;
    createdAt: number;
}> {
    let state: ConversationState | undefined;
    let id = `resp-${requestId}`;
    let createdAt = Math.floor(Date.now() / 1000);
    for await (const frame of events) {
        if (!state) {
            id = frame.streamId;
            createdAt = toUnixSeconds(frame.timestamp);
            state = initialState(frame.streamId, requestId);
        }
        state = applyFrame(state, frame);
    }
    if (!state || !isTerminalStatus(state.status)) {
        throw new ProtocolError(
            502,
            "source stream ended without a terminal event",
            "stream_incomplete",
        );
    }
    return { state, id, createdAt };
}

export function buildChatResponse(
    request: GenerateRequest,
    state: ConversationState | undefined,
    id: string,
    created: number,
): Record<string, unknown> {
    const messages = state
        ? Object.values(state.messages).filter((message) =>
            message.role === "assistant"
        )
        : [];
    if (messages.length === 0) {
        messages.push({ id: `${id}:message`, role: "assistant", parts: [] });
    }
    return {
        id,
        object: "chat.completion",
        created,
        model: request.model ?? "",
        choices: messages.map((message, index) => ({
            index,
            message: toChatMessage(message),
            logprobs: null,
            finish_reason: chatFinishReason(
                message.finishReason ?? state?.finishReason,
                message.parts,
            ),
        })),
        ...(state?.usage ? { usage: toOpenAIUsage(state.usage, "chat") } : {}),
    };
}

export function toChatMessage(message: Message): Record<string, unknown> {
    const text = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
    const refusal = message.parts
        .filter((part) => part.type === "refusal")
        .map((part) => part.text)
        .join("");
    const toolCalls = message.parts
        .filter((part): part is ToolCallPart => part.type === "tool_call")
        .map((part) => ({
            id: part.callId,
            type: "function",
            function: { name: part.name, arguments: part.argumentsText },
        }));
    return {
        role: "assistant",
        content: text.length > 0 ? text : null,
        ...(refusal.length > 0 ? { refusal } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
}

export function buildResponsesResponse(
    request: GenerateRequest,
    state: ConversationState | undefined,
    id: string,
    createdAt: number,
    statusOverride?:
        | "in_progress"
        | "completed"
        | "failed"
        | "incomplete"
        | "cancelled",
    incompleteReason?: string,
): Record<string, unknown> {
    const status = statusOverride ?? responsesStatus(state?.status);
    return {
        id,
        object: "response",
        created_at: createdAt,
        status,
        error: state?.error
            ? { code: state.error.code, message: state.error.message }
            : null,
        incomplete_details: status === "completed"
            ? null
            : incompleteReason !== undefined
            ? { reason: incompleteReason }
            : state?.finishReason
            ? { reason: state.finishReason }
            : null,
        instructions: request.instructions ?? null,
        model: request.model ?? "",
        output: state ? responsesOutput(state) : [],
        metadata: request.metadata ?? {},
        ...(state?.usage ? { usage: toOpenAIUsage(state.usage) } : {}),
    };
}

export function responsesOutput(
    state: ConversationState,
): Array<Record<string, unknown>> {
    const output: Array<Record<string, unknown>> = [];
    for (const message of Object.values(state.messages)) {
        if (message.role !== "assistant") continue;
        const content = toResponsesContent(message.parts);
        if (content.length > 0) {
            output.push({
                id: message.id,
                type: "message",
                status: message.status ?? "completed",
                role: "assistant",
                content,
            });
        }
        for (const part of message.parts) {
            if (part.type === "tool_call") {
                output.push(toResponsesToolCall(part));
            } else if (part.type === "reasoning" && isPublicReasoning(part)) {
                output.push({
                    id: part.id,
                    type: "reasoning",
                    summary: part.text.length > 0
                        ? [{ type: "summary_text", text: part.text }]
                        : [],
                    status: part.done ? "completed" : "in_progress",
                });
            }
        }
    }
    return output;
}

export function toResponsesToolCall(
    part: ToolCallPart,
): Record<string, unknown> {
    return {
        id: part.id,
        type: "function_call",
        call_id: part.callId,
        name: part.name,
        arguments: part.argumentsText,
        status: part.done || part.status === "completed"
            ? "completed"
            : "in_progress",
    };
}

export function toResponsesReasoning(
    part: Extract<ContentPart, { type: "reasoning" }>,
): Record<string, unknown> {
    return {
        id: part.id,
        type: "reasoning",
        summary: part.text.length > 0
            ? [{ type: "summary_text", text: part.text }]
            : [],
        status: part.done ? "completed" : "in_progress",
    };
}

export function toOpenAIUsage(
    usage: Usage,
    dialect: "chat" | "responses" = "responses",
): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (usage.inputTokens !== undefined) {
        result[dialect === "chat" ? "prompt_tokens" : "input_tokens"] =
            usage.inputTokens;
    }
    if (usage.outputTokens !== undefined) {
        result[dialect === "chat" ? "completion_tokens" : "output_tokens"] =
            usage.outputTokens;
    }
    if (usage.totalTokens !== undefined) {
        result.total_tokens = usage.totalTokens;
    } else if (
        usage.inputTokens !== undefined && usage.outputTokens !== undefined
    ) {
        result.total_tokens = usage.inputTokens + usage.outputTokens;
    }
    if (usage.cachedInputTokens !== undefined) {
        result[
            dialect === "chat"
                ? "prompt_tokens_details"
                : "input_tokens_details"
        ] = { cached_tokens: usage.cachedInputTokens };
    }
    if (usage.reasoningTokens !== undefined) {
        result[
            dialect === "chat"
                ? "completion_tokens_details"
                : "output_tokens_details"
        ] = {
            reasoning_tokens: usage.reasoningTokens,
        };
    }
    return result;
}

export function openAIErrorResponse(
    error: ConversationState["error"],
): Response {
    const status = error?.status && error.status >= 400 && error.status <= 599
        ? error.status
        : 502;
    return Response.json({
        error: {
            message: error?.message ?? "upstream request failed",
            type: error?.code ?? "upstream_error",
            code: error?.providerCode ?? error?.code ?? "upstream_error",
        },
    }, { status });
}

export function toResponsesMessageItem(
    message: Message,
): Record<string, unknown> {
    return {
        id: message.id,
        type: "message",
        status: message.status ?? "completed",
        role: "assistant",
        content: toResponsesContent(message.parts),
    };
}

export function toResponsesContent(
    parts: readonly ContentPart[],
): Array<Record<string, unknown>> {
    const content: Array<Record<string, unknown>> = [];
    for (const part of parts) {
        if (part.type === "text") {
            content.push({
                type: "output_text",
                text: part.text,
                annotations: [],
            });
        } else if (part.type === "refusal") {
            content.push({ type: "refusal", refusal: part.text });
        }
    }
    return content;
}
