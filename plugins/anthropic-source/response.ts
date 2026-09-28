import type { StreamEvent, Usage } from "@heimdall/contracts";
import { invalidUpstreamResponse } from "./errors.ts";
import { isRecord, type WireObject } from "./types.ts";

/** Translate a non-streaming Messages response into ordered HIP events. */
export function jsonEvents(
    body: unknown,
    messageId: string,
): readonly StreamEvent[] {
    if (!isRecord(body) || !Array.isArray(body.content)) {
        throw invalidUpstreamResponse(
            "upstream JSON response has no content array",
        );
    }
    const events: StreamEvent[] = [];
    for (const [index, block] of body.content.entries()) {
        if (!isRecord(block) || typeof block.type !== "string") {
            throw invalidUpstreamResponse(
                "upstream content block must be an object with type",
            );
        }
        appendBlock(events, messageId, block, index);
    }
    events.push({
        kind: "message.completed",
        messageId,
        finishReason: typeof body.stop_reason === "string"
            ? body.stop_reason
            : "end_turn",
    });
    if (isRecord(body.usage)) {
        events.push({ kind: "usage", usage: parseUsage(body.usage) });
    }
    return events;
}

function appendBlock(
    events: StreamEvent[],
    messageId: string,
    block: WireObject,
    index: number,
): void {
    switch (block.type) {
        case "text": {
            if (typeof block.text !== "string") {
                throw invalidUpstreamResponse("text block must contain text");
            }
            const partId = `${messageId}:text:${index}`;
            events.push({
                kind: "part.started",
                messageId,
                part: { id: partId, type: "text", text: "" },
            });
            if (block.text.length > 0) {
                events.push({
                    kind: "part.delta",
                    messageId,
                    partId,
                    delta: block.text,
                });
            }
            events.push({ kind: "part.completed", messageId, partId });
            break;
        }
        case "thinking": {
            const text = typeof block.thinking === "string"
                ? block.thinking
                : "";
            const partId = `${messageId}:reasoning:${index}`;
            events.push({
                kind: "part.started",
                messageId,
                part: {
                    id: partId,
                    type: "reasoning",
                    text: "",
                    visibility: "private",
                    ...(typeof block.signature === "string"
                        ? { signature: block.signature }
                        : {}),
                },
            });
            if (text.length > 0) {
                events.push({
                    kind: "part.delta",
                    messageId,
                    partId,
                    delta: text,
                });
            }
            events.push({ kind: "part.completed", messageId, partId });
            break;
        }
        case "redacted_thinking": {
            const partId = `${messageId}:reasoning:${index}`;
            events.push({
                kind: "part.started",
                messageId,
                part: {
                    id: partId,
                    type: "reasoning",
                    text: "",
                    visibility: "redacted",
                    ...(typeof block.data === "string"
                        ? { extensions: { raw: { data: block.data } } }
                        : {}),
                },
            });
            events.push({ kind: "part.completed", messageId, partId });
            break;
        }
        case "tool_use": {
            if (typeof block.id !== "string" || block.id.length === 0) {
                throw invalidUpstreamResponse("tool_use block must contain id");
            }
            if (typeof block.name !== "string" || block.name.length === 0) {
                throw invalidUpstreamResponse(
                    "tool_use block must contain name",
                );
            }
            const partId = `${messageId}:tool:${index}`;
            const args = block.input === undefined
                ? ""
                : JSON.stringify(block.input);
            events.push({
                kind: "part.started",
                messageId,
                part: {
                    id: partId,
                    type: "tool_call",
                    callId: block.id,
                    name: block.name,
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
            break;
        }
        default:
            throw invalidUpstreamResponse(
                `unsupported upstream content type: ${block.type}`,
            );
    }
}

/**
 * Map Anthropic token accounting onto existing HIP usage fields.
 *
 * Anthropic reports `input_tokens` exclusive of both cache reads and writes.
 * HIP's `inputTokens` counts freshly processed input, which includes cache
 * writes but not cache reads, so writes are folded in; cache reads stay in
 * `cachedInputTokens` and `totalTokens` carries the billed sum.
 * `service_tier` is preserved under extensions.
 */
export function parseUsage(value: WireObject): Usage {
    const rawInput = integer(value.input_tokens);
    const outputTokens = integer(value.output_tokens);
    const cachedInputTokens = integer(value.cache_read_input_tokens);
    const cacheWriteTokens = integer(value.cache_creation_input_tokens);
    const inputTokens = rawInput === undefined
        ? undefined
        : rawInput + (cacheWriteTokens ?? 0);
    const totalTokens = inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens + (cachedInputTokens ?? 0)
        : undefined;
    const usage: Record<string, unknown> = {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheWriteTokens,
        totalTokens,
    };
    if (typeof value.service_tier === "string") {
        usage.extensions = { raw: { service_tier: value.service_tier } };
    }
    return compact(usage);
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
