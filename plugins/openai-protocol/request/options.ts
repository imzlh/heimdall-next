import {
    type GenerateRequest,
    type JsonValue,
    type ToolCallPart,
    type ToolDefinition,
} from "@heimdall/contracts";
import { type JsonObject, ProtocolError } from "@heimdall/contracts";
import {
    asObject,
    isJsonValue,
    nonEmptyString,
    optionalString,
    parseJsonText,
    requireObject,
} from "../wire.ts";

export function parseToolCall(
    value: JsonValue,
    fallbackId: string,
): ToolCallPart {
    const wire = requireObject(value, "tool calls must be objects");
    const fn = asObject(wire.function) ?? wire;
    const callId = typeof wire.call_id === "string"
        ? wire.call_id
        : typeof wire.id === "string"
        ? wire.id
        : fallbackId;
    const name = nonEmptyString(fn.name, "tool call requires a function name");
    const argumentValue = fn.arguments ?? {};
    const argumentsText = typeof argumentValue === "string"
        ? argumentValue
        : JSON.stringify(argumentValue);
    return {
        id: fallbackId,
        type: "tool_call",
        callId,
        name,
        argumentsText,
        arguments: parseJsonText(argumentsText) ??
            (isJsonValue(argumentValue) ? argumentValue : undefined),
        // Historical input calls are complete; in-progress calls use HIP events.
        status: wire.status === "failed" ? "failed" : "completed",
        done: true,
        extensions: { raw: wire },
    };
}

export function parseTools(
    value: JsonValue | undefined,
): ToolDefinition[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        throw new ProtocolError(400, "tools must be an array");
    }
    return value.map((item) => {
        const wire = requireObject(item, "each tool must be an object");
        const fn = asObject(wire.function) ?? wire;
        const type = typeof wire.type === "string" ? wire.type : "function";
        const name = typeof fn.name === "string" && fn.name.length > 0
            ? fn.name
            : type;
        return {
            name,
            description: optionalString(fn.description, "tool.description"),
            inputSchema: isJsonValue(fn.parameters) ? fn.parameters : {},
            extensions: { raw: wire },
        };
    });
}

export function parseToolChoice(
    value: JsonValue | undefined,
): GenerateRequest["toolChoice"] {
    if (value === undefined) return undefined;
    if (value === "auto" || value === "none" || value === "required") {
        return value;
    }
    const wire = asObject(value);
    const fn = asObject(wire?.function) ?? wire;
    if (typeof fn?.name === "string" && fn.name.length > 0) {
        return { name: fn.name };
    }
    throw new ProtocolError(
        400,
        "tool_choice must be auto, none, required, or a named function",
    );
}

export function parseResponseFormat(
    value: JsonValue | undefined,
): GenerateRequest["responseFormat"] {
    if (value === undefined) return undefined;
    const wire = asObject(value);
    if (!wire) {
        throw new ProtocolError(400, "response format must be an object");
    }
    if (wire.type === "text") return "text";
    if (wire.type === "json_object") return "json";
    if (wire.type === "json_schema") {
        const jsonSchema = asObject(wire.json_schema) ?? wire;
        const schema = jsonSchema.schema;
        if (isJsonValue(schema)) return { schema };
        throw new ProtocolError(
            400,
            "json_schema response format requires schema",
        );
    }
    throw new ProtocolError(400, "unsupported response format type");
}

export function parseSampling(
    body: JsonObject,
    isResponses: boolean,
): Readonly<Record<string, number>> | undefined {
    const mapping: ReadonlyArray<readonly [string, string]> = [
        ["temperature", "temperature"],
        ["top_p", "topP"],
        [
            isResponses ? "max_output_tokens" : "max_completion_tokens",
            "maxOutputTokens",
        ],
        ["max_tokens", "maxOutputTokens"],
        ["presence_penalty", "presencePenalty"],
        ["frequency_penalty", "frequencyPenalty"],
        ["seed", "seed"],
        ["n", "candidateCount"],
    ];
    const sampling: Record<string, number> = {};
    for (const [wireName, hipName] of mapping) {
        const value = body[wireName];
        if (typeof value === "number" && Number.isFinite(value)) {
            sampling[hipName] = value;
        }
    }
    return Object.keys(sampling).length > 0 ? sampling : undefined;
}

export function parseMetadata(
    value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
    if (value === undefined) return undefined;
    const metadata = asObject(value);
    if (!metadata) throw new ProtocolError(400, "metadata must be an object");
    return metadata;
}
