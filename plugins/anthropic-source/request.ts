import type {
    ContentPart,
    GenerateRequest,
    Message,
    OperationRequest,
} from "@heimdall/contracts";
import { bytesToBase64 } from "@heimdall/contracts";
import { type AnthropicSourceConfig, SAFE_FORWARD_FIELDS } from "./config.ts";
import { AnthropicUpstreamError } from "./errors.ts";
import { isRecord, type WireObject } from "./types.ts";

/** Anthropic requires an explicit output budget; used when none is supplied. */
export const DEFAULT_MAX_TOKENS = 4096;

/** Extract and validate the generation payload at the source boundary. */
export function generationPayload(input: OperationRequest): GenerateRequest {
    if (input.operation !== "generation.create") {
        throw new AnthropicUpstreamError({
            code: "unsupported_operation",
            message: `Anthropic source cannot execute ${input.operation}`,
            retryable: false,
            status: 400,
        });
    }
    const payload = input.payload;
    if (!isRecord(payload) || !Array.isArray(payload.messages)) {
        throw new AnthropicUpstreamError({
            code: "invalid_internal_request",
            message: "generation.create payload is not a GenerateRequest",
            retryable: false,
            status: 500,
        });
    }
    return {
        ...payload,
        ...(input.traits.model === undefined
            ? {}
            : { model: input.traits.model }),
    } as unknown as GenerateRequest;
}

/** Convert the canonical generation request to Anthropic Messages JSON. */
export function toWireRequest(
    request: GenerateRequest,
    _config: AnthropicSourceConfig,
): WireObject {
    const body: WireObject = {
        model: request.model ?? "",
        messages: toWireMessages(request.messages),
        max_tokens: maxTokens(request),
        stream: request.stream === true,
    };
    const system = hoistSystem(request);
    if (system !== undefined) body.system = system;
    if (request.tools !== undefined) {
        body.tools = request.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined
                ? {}
                : { description: tool.description }),
            input_schema: tool.inputSchema ?? {},
        }));
    }
    if (request.toolChoice !== undefined) {
        body.tool_choice = toWireToolChoice(request.toolChoice);
    }
    for (const [key, value] of Object.entries(request.sampling ?? {})) {
        const wireKey = samplingWireKey(key);
        if (wireKey !== undefined) body[wireKey] = value;
    }
    const raw = isRecord(request.extensions?.raw)
        ? request.extensions.raw
        : undefined;
    const stops = stopSequences(raw);
    if (stops !== undefined) body.stop_sequences = stops;
    if (raw !== undefined) {
        for (const key of SAFE_FORWARD_FIELDS) {
            if (Object.hasOwn(raw, key)) body[key] = raw[key];
        }
    }
    return body;
}

/** Anthropic carries system content at the top level, not inside messages. */
function hoistSystem(request: GenerateRequest): string | undefined {
    const parts: string[] = [];
    if (
        typeof request.instructions === "string" &&
        request.instructions.length > 0
    ) {
        parts.push(request.instructions);
    }
    for (const message of request.messages) {
        if (message.role !== "system") continue;
        for (const part of message.parts) {
            if (part.type === "text" && part.text.length > 0) {
                parts.push(part.text);
            }
        }
    }
    return parts.length === 0 ? undefined : parts.join("\n");
}

function maxTokens(request: GenerateRequest): number {
    const requested = request.sampling?.maxOutputTokens;
    return typeof requested === "number" && Number.isInteger(requested) &&
            requested > 0
        ? requested
        : DEFAULT_MAX_TOKENS;
}

function toWireMessages(messages: readonly Message[]): WireObject[] {
    const wire: WireObject[] = [];
    for (const message of messages) {
        if (message.role === "system") continue;
        const content = toContentBlocks(message.parts);
        if (content.length === 0) continue;
        wire.push({
            role: message.role === "assistant" ? "assistant" : "user",
            content,
        });
    }
    return wire;
}

function toContentBlocks(parts: readonly ContentPart[]): unknown[] {
    const blocks: unknown[] = [];
    for (const part of parts) {
        switch (part.type) {
            case "text":
                blocks.push({ type: "text", text: part.text });
                break;
            case "refusal":
                blocks.push({ type: "text", text: part.text });
                break;
            case "json":
                blocks.push({
                    type: "text",
                    text: part.text ?? JSON.stringify(part.value ?? null),
                });
                break;
            case "image":
                blocks.push({ type: "image", source: imageSource(part) });
                break;
            case "tool_call":
                blocks.push({
                    type: "tool_use",
                    id: part.callId,
                    name: part.name,
                    input: toolInput(part),
                });
                break;
            case "tool_result":
                blocks.push(toolResultBlock(part));
                break;
            case "reasoning":
            case "document":
            case "audio":
            case "video":
            case "citation":
            case "custom":
                // No portable Anthropic request representation; omit.
                break;
        }
    }
    return blocks;
}

function imageSource(
    part: Extract<ContentPart, { type: "image" }>,
): WireObject {
    const source = part.source;
    if (source.data !== undefined) {
        return {
            type: "base64",
            media_type: source.mediaType,
            data: bytesToBase64(source.data),
        };
    }
    if (source.uri !== undefined) {
        return { type: "url", url: source.uri };
    }
    throw new AnthropicUpstreamError({
        code: "unsupported_input",
        message: "image part has no URI or inline data",
        retryable: false,
        status: 400,
    });
}

function toolInput(
    part: Extract<ContentPart, { type: "tool_call" }>,
): unknown {
    if (part.arguments !== undefined) return part.arguments;
    if (part.argumentsText.length === 0) return {};
    try {
        return JSON.parse(part.argumentsText);
    } catch {
        return {};
    }
}

function toolResultBlock(
    part: Extract<ContentPart, { type: "tool_result" }>,
): WireObject {
    const block: WireObject = {
        type: "tool_result",
        tool_use_id: part.callId,
        content: toolResultContent(part),
    };
    if (part.isError === true) block.is_error = true;
    return block;
}

function toolResultContent(
    part: Extract<ContentPart, { type: "tool_result" }>,
): unknown {
    if (part.parts !== undefined && part.parts.length > 0) {
        const nested = toContentBlocks(part.parts);
        if (nested.length > 0) return nested;
    }
    if (part.result !== undefined) {
        return typeof part.result === "string"
            ? part.result
            : JSON.stringify(part.result);
    }
    return "";
}

function toWireToolChoice(
    value: NonNullable<GenerateRequest["toolChoice"]>,
): WireObject {
    if (value === "auto") return { type: "auto" };
    if (value === "required") return { type: "any" };
    if (value === "none") return { type: "none" };
    return { type: "tool", name: value.name };
}

function samplingWireKey(key: string): string | undefined {
    switch (key) {
        case "temperature":
            return "temperature";
        case "topP":
            return "top_p";
        case "topK":
            return "top_k";
        default:
            return undefined;
    }
}

function stopSequences(raw: WireObject | undefined): string[] | undefined {
    if (raw === undefined) return undefined;
    const value = Object.hasOwn(raw, "stop_sequences")
        ? raw.stop_sequences
        : Object.hasOwn(raw, "stop")
        ? raw.stop
        : undefined;
    if (typeof value === "string") {
        return value.length > 0 ? [value] : undefined;
    }
    if (!Array.isArray(value)) return undefined;
    const stops = value.filter((item): item is string =>
        typeof item === "string" && item.length > 0
    );
    return stops.length === 0 ? undefined : stops;
}
