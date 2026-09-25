import type {
    ContentPart,
    GenerateRequest,
    Message,
    OperationRequest,
} from "@heimdall/contracts";
import {
    type OpenAICompatibleSourceConfig,
    SAFE_FORWARD_FIELDS,
    upstreamModel,
} from "./config.ts";
import { OpenAIUpstreamError } from "./errors.ts";
import { isRecord, type WireObject } from "./types.ts";

/** Extract and validate the generation payload at the source boundary. */
export function generationPayload(input: OperationRequest): GenerateRequest {
    if (input.operation !== "generation.create") {
        throw new OpenAIUpstreamError({
            code: "unsupported_operation",
            message: `OpenAI source cannot execute ${input.operation}`,
            retryable: false,
            status: 400,
        });
    }
    const payload = input.payload;
    if (!isRecord(payload) || !Array.isArray(payload.messages)) {
        throw new OpenAIUpstreamError({
            code: "invalid_internal_request",
            message: "generation.create payload is not a GenerateRequest",
            retryable: false,
            status: 500,
        });
    }
    return payload as unknown as GenerateRequest;
}

/** Convert the canonical generation request to OpenAI Chat Completions JSON. */
export function toWireRequest(
    request: GenerateRequest,
    config: OpenAICompatibleSourceConfig,
): WireObject {
    const body: WireObject = {
        model: upstreamModel(config, request.model),
        messages: request.messages.map(toWireMessage),
        stream: request.stream === true,
    };
    if (request.tools !== undefined) {
        body.tools = request.tools.map((tool) => ({
            type: "function",
            function: {
                name: tool.name,
                ...(tool.description === undefined
                    ? {}
                    : { description: tool.description }),
                parameters: tool.inputSchema,
            },
        }));
    }
    if (request.toolChoice !== undefined) {
        body.tool_choice = toWireToolChoice(request.toolChoice);
    }
    if (request.responseFormat !== undefined) {
        body.response_format = toWireResponseFormat(request.responseFormat);
    }
    if (request.instructions !== undefined && request.messages.length === 0) {
        body.messages = [{ role: "system", content: request.instructions }];
    }
    if (request.metadata !== undefined) body.metadata = request.metadata;
    for (const [key, value] of Object.entries(request.sampling ?? {})) {
        const wireKey = samplingWireKey(key);
        if (wireKey !== undefined) body[wireKey] = value;
    }
    const raw = isRecord(request.extensions?.raw)
        ? request.extensions.raw
        : undefined;
    if (raw !== undefined) {
        for (const key of SAFE_FORWARD_FIELDS) {
            if (Object.hasOwn(raw, key)) body[key] = raw[key];
        }
    }
    return body;
}

export function toWireMessage(message: Message): WireObject {
    const content: unknown[] = [];
    const toolCalls: WireObject[] = [];
    let toolCallId: string | undefined;
    for (const part of message.parts) {
        switch (part.type) {
            case "text":
                content.push({ type: "text", text: part.text });
                break;
            case "image":
                content.push({
                    type: "image_url",
                    image_url: {
                        url: blobUrl(part.source),
                        ...(part.detail === undefined
                            ? {}
                            : { detail: part.detail }),
                    },
                });
                break;
            case "json":
                content.push({
                    type: "text",
                    text: part.text ?? JSON.stringify(part.value ?? null),
                });
                break;
            case "refusal":
                content.push({ type: "text", text: part.text });
                break;
            case "tool_call":
                toolCalls.push({
                    id: part.callId,
                    type: "function",
                    function: {
                        name: part.name,
                        arguments: part.argumentsText,
                    },
                });
                break;
            case "tool_result":
                toolCallId ??= part.callId;
                content.push({ type: "text", text: toolResultText(part) });
                break;
            case "reasoning":
            case "audio":
            case "video":
            case "document":
            case "citation":
            case "custom":
                // These parts have no portable Chat Completions representation yet.
                break;
        }
    }
    const result: WireObject = { role: message.role };
    if (message.name !== undefined) result.name = message.name;
    if (message.role === "assistant" && toolCalls.length > 0) {
        result.tool_calls = toolCalls;
    }
    if (message.role === "tool") {
        result.tool_call_id = toolCallId ?? `${message.id}:tool`;
        result.content = content.map((item) =>
            isRecord(item) && typeof item.text === "string" ? item.text : item
        );
    } else if (content.length === 0) {
        result.content = message.role === "assistant" ? null : "";
    } else if (
        content.length === 1 && isRecord(content[0]) &&
        content[0].type === "text"
    ) {
        result.content = content[0].text;
    } else {
        result.content = content;
    }
    return result;
}

export function toWireToolChoice(
    value: NonNullable<GenerateRequest["toolChoice"]>,
): unknown {
    if (typeof value === "string") return value;
    return { type: "function", function: { name: value.name } };
}

export function toWireResponseFormat(
    value: NonNullable<GenerateRequest["responseFormat"]>,
): unknown {
    if (value === "text") return { type: "text" };
    if (value === "json") return { type: "json_object" };
    return {
        type: "json_schema",
        json_schema: { name: "response", schema: value.schema },
    };
}

function samplingWireKey(key: string): string | undefined {
    switch (key) {
        case "temperature":
            return "temperature";
        case "topP":
            return "top_p";
        case "maxOutputTokens":
            return "max_tokens";
        case "maxCompletionTokens":
            return "max_completion_tokens";
        case "presencePenalty":
            return "presence_penalty";
        case "frequencyPenalty":
            return "frequency_penalty";
        case "seed":
            return "seed";
        case "candidateCount":
            return "n";
        default:
            return undefined;
    }
}

function blobUrl(
    blob: { uri?: string; mediaType: string; dataBase64?: string },
): string {
    if (blob.uri !== undefined) return blob.uri;
    if (blob.dataBase64 !== undefined) {
        return `data:${blob.mediaType};base64,${blob.dataBase64}`;
    }
    throw new OpenAIUpstreamError({
        code: "unsupported_input",
        message: "image part has no URI or inline data",
        retryable: false,
        status: 400,
    });
}

function toolResultText(
    part: Extract<ContentPart, { type: "tool_result" }>,
): string {
    if (part.result !== undefined) {
        return typeof part.result === "string"
            ? part.result
            : JSON.stringify(part.result);
    }
    if (part.parts !== undefined) {
        return part.parts.map((nested) =>
            nested.type === "text" ? nested.text : ""
        )
            .join("");
    }
    return "";
}
