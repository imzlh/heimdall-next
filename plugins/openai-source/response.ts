import type { StreamEvent, Usage } from "@heimdall/contracts";
import { invalidUpstreamResponse, OpenAIUpstreamError } from "./errors.ts";
import { isRecord, type WireObject } from "./types.ts";

/** Translate a non-streaming Chat Completions response into HIP events. */
export function jsonEvents(
    body: unknown,
    messageId: string,
): readonly StreamEvent[] {
    if (
        !isRecord(body) || !Array.isArray(body.choices) ||
        !isRecord(body.choices[0])
    ) {
        throw new OpenAIUpstreamError({
            code: "upstream_invalid_response",
            message: "upstream JSON response has no choices",
            retryable: false,
            status: 502,
        });
    }
    const choice = body.choices[0];
    if (!isRecord(choice.message)) {
        throw invalidUpstreamResponse(
            "upstream choice.message must be an object",
        );
    }
    const message = choice.message;
    const events: StreamEvent[] = [];
    appendContent(events, messageId, message.content);
    appendStringPart(
        events,
        messageId,
        "refusal",
        "refusal",
        message.refusal,
    );
    appendStringPart(
        events,
        messageId,
        "reasoning",
        "reasoning",
        typeof message.reasoning_content === "string"
            ? message.reasoning_content
            : typeof message.reasoning === "string"
            ? message.reasoning
            : undefined,
    );
    if (Array.isArray(message.tool_calls)) {
        for (const [index, raw] of message.tool_calls.entries()) {
            if (!isRecord(raw)) {
                throw invalidUpstreamResponse(
                    "upstream JSON tool call must be an object",
                );
            }
            const callId = raw.id;
            if (typeof callId !== "string" || callId.length === 0) {
                throw invalidUpstreamResponse(
                    `upstream JSON tool call ${index} must contain id`,
                );
            }
            if (!Object.hasOwn(raw, "function") || !isRecord(raw.function)) {
                throw invalidUpstreamResponse(
                    `upstream JSON tool call ${index} must contain function`,
                );
            }
            const fn = raw.function;
            if (typeof fn.name !== "string" || fn.name.length === 0) {
                throw invalidUpstreamResponse(
                    `upstream JSON tool call ${index} must contain function.name`,
                );
            }
            if (
                fn.arguments !== undefined && typeof fn.arguments !== "string"
            ) {
                throw invalidUpstreamResponse(
                    `upstream JSON tool call ${index} function.arguments must be a string`,
                );
            }
            const partId = `${messageId}:tool:${index}`;
            const args = fn.arguments ?? "";
            events.push({
                kind: "part.started",
                messageId,
                part: {
                    id: partId,
                    type: "tool_call",
                    callId,
                    name: fn.name,
                    argumentsText: "",
                    status: "in_progress",
                },
            });
            if (args.length > 0) {
                events.push({
                    kind: "part.delta",
                    messageId,
                    partId,
                    delta: args,
                });
            }
            events.push({ kind: "part.completed", messageId, partId });
        }
    }
    events.push({
        kind: "message.completed",
        messageId,
        finishReason: typeof choice.finish_reason === "string"
            ? choice.finish_reason
            : "stop",
    });
    if (isRecord(body.usage)) {
        events.push({ kind: "usage", usage: parseUsage(body.usage) });
    }
    return events;
}

/** Convert provider content blocks without collapsing their semantics. */
function appendContent(
    events: StreamEvent[],
    messageId: string,
    value: unknown,
): void {
    if (value === undefined || value === null) return;
    if (typeof value === "string") {
        appendStringPart(events, messageId, "text", "text", value);
        return;
    }
    if (!Array.isArray(value)) {
        throw invalidUpstreamResponse(
            "upstream choice.message.content must be a string or array",
        );
    }
    let textIndex = 0;
    let refusalIndex = 0;
    for (const item of value) {
        if (!isRecord(item) || typeof item.type !== "string") {
            throw invalidUpstreamResponse(
                "upstream message content block must be an object with type",
            );
        }
        if (item.type === "text" || item.type === "output_text") {
            if (typeof item.text !== "string") {
                throw invalidUpstreamResponse(
                    "upstream text content block must contain text",
                );
            }
            const suffix = textIndex++;
            appendStringPart(
                events,
                messageId,
                `text:${suffix}`,
                "text",
                item.text,
            );
        } else if (item.type === "refusal") {
            const text = item.refusal ?? item.text;
            if (typeof text !== "string") {
                throw invalidUpstreamResponse(
                    "upstream refusal content block must contain text",
                );
            }
            const suffix = refusalIndex++;
            appendStringPart(
                events,
                messageId,
                `refusal:${suffix}`,
                "refusal",
                text,
            );
        } else {
            throw invalidUpstreamResponse(
                `unsupported upstream message content type: ${item.type}`,
            );
        }
    }
}

function appendStringPart(
    events: StreamEvent[],
    messageId: string,
    idSuffix: string,
    type: "text" | "refusal" | "reasoning",
    value: unknown,
): void {
    if (typeof value !== "string" || value.length === 0) return;
    const partId = `${messageId}:${idSuffix}`;
    events.push({
        kind: "part.started",
        messageId,
        part: type === "text"
            ? { id: partId, type, text: "" }
            : type === "refusal"
            ? { id: partId, type, text: "" }
            : { id: partId, type, text: "", visibility: "private" },
    });
    events.push({ kind: "part.delta", messageId, partId, delta: value });
    events.push({ kind: "part.completed", messageId, partId });
}

export function parseUsage(value: WireObject): Usage {
    const promptTokens = integer(value.input_tokens ?? value.prompt_tokens);
    const outputTokens = integer(
        value.output_tokens ?? value.completion_tokens,
    );
    const totalTokens = integer(value.total_tokens);
    const inputDetails = isRecord(value.input_tokens_details)
        ? value.input_tokens_details
        : undefined;
    const outputDetails = isRecord(value.output_tokens_details)
        ? value.output_tokens_details
        : undefined;
    const cachedInputTokens = integer(inputDetails?.cached_tokens);
    // OpenAI's prompt_tokens is inclusive of cache reads; HIP's inputTokens
    // excludes them (surfaced separately in cachedInputTokens).
    const inputTokens = promptTokens === undefined
        ? undefined
        : Math.max(0, promptTokens - (cachedInputTokens ?? 0));
    return compact({
        inputTokens,
        outputTokens,
        totalTokens,
        cachedInputTokens,
        reasoningTokens: integer(outputDetails?.reasoning_tokens),
    });
}

function integer(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) &&
            value >= 0
        ? value
        : undefined;
}

function compact(value: Record<string, unknown>): Usage {
    return Object.fromEntries(
        Object.entries(value).filter(([, item]) => item !== undefined),
    ) as Usage;
}
