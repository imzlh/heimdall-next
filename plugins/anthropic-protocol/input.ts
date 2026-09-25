import {
    type GenerationRequest,
    type JsonObject,
    type JsonValue,
    type OperationRequest,
    ProtocolError,
    type RequestContext,
    type ToolDefinition,
} from "@heimdall/contracts";
import {
    ANTHROPIC_PRESERVED_FIELDS,
    ANTHROPIC_REQUEST_FIELDS,
} from "./contract.ts";
import { parseMessages } from "./input/content.ts";
import {
    asObject,
    compactUndefined,
    inferInputModalities,
    isJsonValue,
    nonEmptyOrBlankString,
    nonEmptyString,
    optionalString,
    rawExtensions,
    requiredCapabilities,
    requireObject,
    sanitizeJson,
    unknownFields,
} from "./shared.ts";

export async function parseAnthropicRequest(
    context: RequestContext,
): Promise<OperationRequest<GenerationRequest>> {
    const body = await parseJsonBody(context.request);
    validateRequestTypes(body);
    const model = nonEmptyString(body.model, "model is required");
    validateMaxTokens(body.max_tokens);
    const messages = parseMessages(body.messages, context.requestId);
    const instructions = parseSystem(body.system);
    const raw = {
        ...unknownFields(body, ANTHROPIC_REQUEST_FIELDS),
        ...preservedFields(body),
        ...(body.system === undefined
            ? {}
            : { system: sanitizeJson(body.system) }),
    };
    const request: GenerationRequest = {
        model,
        messages,
        instructions,
        tools: parseTools(body.tools),
        toolChoice: parseToolChoice(body.tool_choice),
        sampling: parseSampling(body),
        stream: body.stream === true,
        metadata: parseMetadata(body.metadata),
        extensions: Object.keys(raw).length > 0 ? { raw } : undefined,
    };
    return compactUndefined({
        version: 1,
        requestId: context.requestId,
        operation: context.route.operation,
        payload: request,
        traits: {
            model,
            streaming: request.stream === true,
            inputModalities: inferInputModalities(messages),
            requiredCapabilities: requiredCapabilities(request),
            idempotent: false,
        },
    });
}

async function parseJsonBody(request: Request): Promise<JsonObject> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        throw new ProtocolError(400, "request body must be valid JSON");
    }
    if (!asObject(body)) {
        throw new ProtocolError(400, "request body must be an object");
    }
    return body as JsonObject;
}

function validateRequestTypes(body: JsonObject): void {
    if (body.stream !== undefined && typeof body.stream !== "boolean") {
        throw new ProtocolError(400, "stream must be a boolean");
    }
    for (const field of ["temperature", "top_p", "top_k"] as const) {
        const value = body[field];
        if (
            value !== undefined &&
            (typeof value !== "number" || !Number.isFinite(value))
        ) {
            throw new ProtocolError(400, `${field} must be a finite number`);
        }
    }
    const topP = body.top_p;
    if (typeof topP === "number" && (topP < 0 || topP > 1)) {
        throw new ProtocolError(400, "top_p must be between 0 and 1");
    }
    const temperature = body.temperature;
    if (
        typeof temperature === "number" &&
        (temperature < 0 || temperature > 1)
    ) {
        throw new ProtocolError(400, "temperature must be between 0 and 1");
    }
    if (
        body.top_k !== undefined &&
        (!Number.isInteger(body.top_k as number) || (body.top_k as number) < 0)
    ) {
        throw new ProtocolError(400, "top_k must be a non-negative integer");
    }
    if (body.stop_sequences !== undefined) {
        if (
            !Array.isArray(body.stop_sequences) ||
            !body.stop_sequences.every((value) => typeof value === "string")
        ) {
            throw new ProtocolError(
                400,
                "stop_sequences must be an array of strings",
            );
        }
    }
    if (body.thinking !== undefined && !asObject(body.thinking)) {
        throw new ProtocolError(400, "thinking must be an object");
    }
}

function parseSystem(value: JsonValue | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) {
        throw new ProtocolError(400, "system must be a string or array");
    }
    const texts: string[] = [];
    for (const item of value) {
        const block = requireObject(item, "system blocks must be objects");
        const type = nonEmptyString(block.type, "system block requires a type");
        if (type !== "text") {
            throw new ProtocolError(
                400,
                `unsupported system block type: ${type}`,
            );
        }
        texts.push(
            nonEmptyOrBlankString(block.text, "system text must be a string"),
        );
    }
    return texts.join("\n");
}

function parseTools(
    value: JsonValue | undefined,
): ToolDefinition[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        throw new ProtocolError(400, "tools must be an array");
    }
    return value.map((item) => {
        const wire = requireObject(item, "each tool must be an object");
        const inputSchema = wire.input_schema === undefined
            ? {}
            : wire.input_schema;
        if (!isJsonValue(inputSchema)) {
            throw new ProtocolError(400, "tool.input_schema must be JSON");
        }
        return {
            name: nonEmptyString(wire.name, "tool name is required"),
            description: optionalString(wire.description, "tool.description"),
            inputSchema,
            extensions: rawExtensions(wire),
        };
    });
}

function parseToolChoice(
    value: JsonValue | undefined,
): GenerationRequest["toolChoice"] {
    if (value === undefined) return undefined;
    const wire = requireObject(value, "tool_choice must be an object");
    const type = nonEmptyString(wire.type, "tool_choice.type is required");
    if (type === "auto") return "auto";
    if (type === "any") return "required";
    if (type === "none") return "none";
    if (type === "tool") {
        return {
            name: nonEmptyString(
                wire.name,
                "tool_choice tool name is required",
            ),
        };
    }
    throw new ProtocolError(400, `unsupported tool_choice type: ${type}`);
}

function parseSampling(
    body: JsonObject,
): Readonly<Record<string, number>> | undefined {
    const sampling: Record<string, number> = {};
    for (
        const [wireName, hipName] of [
            ["temperature", "temperature"],
            ["top_p", "topP"],
            ["top_k", "topK"],
            ["max_tokens", "maxOutputTokens"],
        ] as const
    ) {
        const value = body[wireName];
        if (typeof value === "number" && Number.isFinite(value)) {
            sampling[hipName] = value;
        }
    }
    return Object.keys(sampling).length > 0 ? sampling : undefined;
}

function validateMaxTokens(value: JsonValue | undefined): void {
    if (
        typeof value !== "number" || !Number.isInteger(value) || value <= 0
    ) {
        throw new ProtocolError(400, "max_tokens must be a positive integer");
    }
}

function preservedFields(body: JsonObject): Record<string, JsonValue> {
    const raw: Record<string, JsonValue> = {};
    for (const key of ANTHROPIC_PRESERVED_FIELDS) {
        const value = body[key];
        if (value !== undefined && isJsonValue(value)) {
            raw[key] = sanitizeJson(value);
        }
    }
    return raw;
}

function parseMetadata(
    value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
    if (value === undefined) return undefined;
    const object = asObject(value);
    if (!object) throw new ProtocolError(400, "metadata must be an object");
    return sanitizeJson(object) as Readonly<Record<string, JsonValue>>;
}
