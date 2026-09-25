import type {
    BlobRef,
    CanonicalError,
    ContentPart,
    GenerationRequest,
    JsonValue,
    Message,
    OperationRequest,
    OperationTraits,
    StreamEvent,
    StreamFrame,
    Usage,
} from "./mod.ts";

export class HipValidationError extends Error {
    override readonly name = "HipValidationError";

    constructor(readonly path: string, message: string) {
        super(`${path}: ${message}`);
    }
}

export function validateOperationRequest(
    value: unknown,
): asserts value is OperationRequest {
    const request = record(value, "$request");
    equal(request.version, 1, "$request.version");
    text(request.requestId, "$request.requestId");
    operationId(request.operation, "$request.operation");
    validateTraits(request.traits, "$request.traits");
    if (request.metadata !== undefined) {
        jsonObject(request.metadata, "$request.metadata");
    }
    if (request.extensions !== undefined) {
        jsonObject(request.extensions, "$request.extensions");
    }

    const payload = record(request.payload, "$request.payload");
    if (Object.hasOwn(payload, "messages")) {
        validateGenerationRequest(payload, "$request.payload");
    } else {
        text(payload.vocabulary, "$request.payload.vocabulary");
        if (!Object.hasOwn(payload, "value")) {
            fail(
                "$request.payload.value",
                "is required for a custom vocabulary",
            );
        }
        json(payload.value, "$request.payload.value");
        if (payload.extensions !== undefined) {
            jsonObject(payload.extensions, "$request.payload.extensions");
        }
    }
    json(request, "$request");
}

export function validateStreamFrame(
    value: unknown,
): asserts value is StreamFrame {
    const frame = record(value, "$frame");
    equal(frame.version, 1, "$frame.version");
    text(frame.streamId, "$frame.streamId");
    text(frame.requestId, "$frame.requestId");
    positiveInteger(frame.seq, "$frame.seq");
    text(frame.eventId, "$frame.eventId");
    dateTime(frame.timestamp, "$frame.timestamp");
    if (frame.causationId !== undefined) {
        text(frame.causationId, "$frame.causationId");
    }
    if (frame.extensions !== undefined) {
        jsonObject(frame.extensions, "$frame.extensions");
    }
    validateEvent(frame.event, "$frame.event", frame.requestId as string);
    json(frame, "$frame");
}

export function assertJsonSafe(
    value: unknown,
    path = "$value",
): asserts value is JsonValue {
    json(value, path);
}

function validateTraits(
    value: unknown,
    path: string,
): asserts value is OperationTraits {
    const traits = record(value, path);
    if (traits.model !== undefined) text(traits.model, `${path}.model`);
    if (traits.streaming !== undefined) {
        boolean(traits.streaming, `${path}.streaming`);
    }
    if (traits.idempotent !== undefined) {
        boolean(traits.idempotent, `${path}.idempotent`);
    }
    stringArray(traits.inputModalities, `${path}.inputModalities`);
    stringArray(traits.outputModalities, `${path}.outputModalities`);
    stringArray(traits.requiredCapabilities, `${path}.requiredCapabilities`);
}

function validateGenerationRequest(
    value: unknown,
    path: string,
): asserts value is GenerationRequest {
    const request = record(value, path);
    if (!Array.isArray(request.messages)) {
        fail(`${path}.messages`, "must be an array");
    }
    const messages = request.messages.map((message, index) =>
        validateMessage(message, `${path}.messages[${index}]`)
    );
    validateMessageGraph(messages, `${path}.messages`);
    if (request.model !== undefined) text(request.model, `${path}.model`);
    if (request.instructions !== undefined) {
        string(request.instructions, `${path}.instructions`);
    }
    if (request.stream !== undefined) boolean(request.stream, `${path}.stream`);
    stringArray(request.outputModalities, `${path}.outputModalities`);
    if (request.tools !== undefined) {
        if (!Array.isArray(request.tools)) {
            fail(`${path}.tools`, "must be an array");
        }
        const names = new Set<string>();
        for (const [index, raw] of request.tools.entries()) {
            const tool = record(raw, `${path}.tools[${index}]`);
            const name = text(tool.name, `${path}.tools[${index}].name`);
            if (names.has(name)) {
                fail(`${path}.tools[${index}].name`, `duplicate tool ${name}`);
            }
            names.add(name);
            if (tool.description !== undefined) {
                string(tool.description, `${path}.tools[${index}].description`);
            }
            json(tool.inputSchema, `${path}.tools[${index}].inputSchema`);
            if (tool.outputSchema !== undefined) {
                json(tool.outputSchema, `${path}.tools[${index}].outputSchema`);
            }
            if (tool.execution !== undefined) {
                oneOf(
                    tool.execution,
                    ["server", "client", "either"],
                    `${path}.tools[${index}].execution`,
                );
            }
            if (tool.extensions !== undefined) {
                jsonObject(
                    tool.extensions,
                    `${path}.tools[${index}].extensions`,
                );
            }
        }
    }
    if (request.toolChoice !== undefined) {
        if (
            typeof request.toolChoice === "object" &&
            request.toolChoice !== null && !Array.isArray(request.toolChoice)
        ) {
            const choice = record(request.toolChoice, `${path}.toolChoice`);
            text(choice.name, `${path}.toolChoice.name`);
        } else {
            oneOf(
                request.toolChoice,
                ["auto", "none", "required"],
                `${path}.toolChoice`,
            );
        }
    }
    if (request.responseFormat !== undefined) {
        if (
            typeof request.responseFormat === "object" &&
            request.responseFormat !== null &&
            !Array.isArray(request.responseFormat)
        ) {
            const format = record(
                request.responseFormat,
                `${path}.responseFormat`,
            );
            json(
                format.schema,
                `${path}.responseFormat.schema`,
            );
        } else {
            oneOf(
                request.responseFormat,
                ["text", "json"],
                `${path}.responseFormat`,
            );
        }
    }
    if (request.sampling !== undefined) {
        const sampling = record(request.sampling, `${path}.sampling`);
        for (const [key, item] of Object.entries(sampling)) {
            finiteNumber(item, `${path}.sampling.${key}`);
        }
    }
    if (request.metadata !== undefined) {
        jsonObject(request.metadata, `${path}.metadata`);
    }
    if (request.extensions !== undefined) {
        jsonObject(request.extensions, `${path}.extensions`);
    }
}

function validateMessage(value: unknown, path: string): Message {
    const message = record(value, path);
    text(message.id, `${path}.id`);
    text(message.role, `${path}.role`);
    if (message.parentId !== undefined) {
        text(message.parentId, `${path}.parentId`);
    }
    if (message.createdAt !== undefined) {
        dateTime(message.createdAt, `${path}.createdAt`);
    }
    if (message.name !== undefined) string(message.name, `${path}.name`);
    if (message.status !== undefined) {
        oneOf(
            message.status,
            ["in_progress", "completed", "failed"],
            `${path}.status`,
        );
    }
    if (message.finishReason !== undefined) {
        string(message.finishReason, `${path}.finishReason`);
    }
    if (!Array.isArray(message.parts)) {
        fail(`${path}.parts`, "must be an array");
    }
    const partIds = new Set<string>();
    for (const [index, raw] of message.parts.entries()) {
        const part = validatePart(raw, `${path}.parts[${index}]`);
        if (partIds.has(part.id)) {
            fail(`${path}.parts[${index}].id`, `duplicate part ${part.id}`);
        }
        partIds.add(part.id);
    }
    if (message.metadata !== undefined) {
        jsonObject(message.metadata, `${path}.metadata`);
    }
    if (message.extensions !== undefined) {
        jsonObject(message.extensions, `${path}.extensions`);
    }
    return value as Message;
}

function validateMessageGraph(
    messages: readonly Message[],
    path: string,
): void {
    const byId = new Map<string, Message>();
    for (const [index, message] of messages.entries()) {
        if (byId.has(message.id)) {
            fail(`${path}[${index}].id`, `duplicate message ${message.id}`);
        }
        byId.set(message.id, message);
    }
    for (const [index, message] of messages.entries()) {
        if (message.parentId !== undefined && !byId.has(message.parentId)) {
            fail(
                `${path}[${index}].parentId`,
                `unknown message ${message.parentId}`,
            );
        }
        const visited = new Set<string>();
        let current: Message | undefined = message;
        while (current?.parentId !== undefined) {
            if (visited.has(current.id)) {
                fail(
                    `${path}[${index}].parentId`,
                    "message graph contains a cycle",
                );
            }
            visited.add(current.id);
            current = byId.get(current.parentId);
        }
    }
}

function validatePart(value: unknown, path: string): ContentPart {
    const part = record(value, path);
    text(part.id, `${path}.id`);
    const type = text(part.type, `${path}.type`);
    if (part.done !== undefined) boolean(part.done, `${path}.done`);
    if (part.extensions !== undefined) {
        jsonObject(part.extensions, `${path}.extensions`);
    }
    switch (type) {
        case "text":
        case "refusal":
            string(part.text, `${path}.text`);
            break;
        case "reasoning":
            string(part.text, `${path}.text`);
            if (part.visibility !== undefined) {
                oneOf(
                    part.visibility,
                    ["public", "private", "redacted"],
                    `${path}.visibility`,
                );
            }
            if (part.signature !== undefined) {
                string(part.signature, `${path}.signature`);
            }
            break;
        case "image":
            validateBlobRef(part.source, `${path}.source`);
            if (part.detail !== undefined) {
                oneOf(part.detail, ["low", "high", "auto"], `${path}.detail`);
            }
            break;
        case "audio":
            validateBlobRef(part.source, `${path}.source`);
            if (part.transcript !== undefined) {
                string(part.transcript, `${path}.transcript`);
            }
            break;
        case "video":
            validateBlobRef(part.source, `${path}.source`);
            if (part.durationMs !== undefined) {
                nonNegativeInteger(part.durationMs, `${path}.durationMs`);
            }
            break;
        case "document":
            validateBlobRef(part.source, `${path}.source`);
            if (part.title !== undefined) string(part.title, `${path}.title`);
            break;
        case "json":
            if (part.value !== undefined) json(part.value, `${path}.value`);
            if (part.text !== undefined) string(part.text, `${path}.text`);
            if (part.value === undefined && part.text === undefined) {
                fail(path, "json part needs value or text");
            }
            break;
        case "tool_call":
            text(part.callId, `${path}.callId`);
            text(part.name, `${path}.name`);
            string(part.argumentsText, `${path}.argumentsText`);
            if (part.arguments !== undefined) {
                json(part.arguments, `${path}.arguments`);
            }
            if (part.status !== undefined) {
                oneOf(
                    part.status,
                    ["in_progress", "completed", "failed"],
                    `${path}.status`,
                );
            }
            break;
        case "tool_result":
            text(part.callId, `${path}.callId`);
            if (part.result !== undefined) json(part.result, `${path}.result`);
            if (part.parts !== undefined) {
                if (!Array.isArray(part.parts)) {
                    fail(`${path}.parts`, "must be an array");
                }
                part.parts.forEach((nested, index) =>
                    validatePart(nested, `${path}.parts[${index}]`)
                );
            }
            if (part.isError !== undefined) {
                boolean(part.isError, `${path}.isError`);
            }
            if (part.error !== undefined) {
                validateError(part.error, `${path}.error`);
            }
            break;
        case "citation":
            if (part.label !== undefined) string(part.label, `${path}.label`);
            if (part.url !== undefined) string(part.url, `${path}.url`);
            if (part.quote !== undefined) string(part.quote, `${path}.quote`);
            break;
        case "custom":
            text(part.name, `${path}.name`);
            if (part.value !== undefined) json(part.value, `${path}.value`);
            break;
        default:
            fail(
                `${path}.type`,
                `unknown standard content type ${type}; use custom`,
            );
    }
    return value as ContentPart;
}

function validateBlobRef(
    value: unknown,
    path: string,
): asserts value is BlobRef {
    const blob = record(value, path);
    text(blob.mediaType, `${path}.mediaType`);
    if (blob.uri === undefined && blob.dataBase64 === undefined) {
        fail(path, "requires uri or dataBase64");
    }
    if (blob.uri !== undefined) text(blob.uri, `${path}.uri`);
    if (blob.dataBase64 !== undefined) {
        string(blob.dataBase64, `${path}.dataBase64`);
    }
    if (blob.bytes !== undefined) {
        nonNegativeInteger(blob.bytes, `${path}.bytes`);
    }
    if (blob.sha256 !== undefined) text(blob.sha256, `${path}.sha256`);
    if (blob.extensions !== undefined) {
        jsonObject(blob.extensions, `${path}.extensions`);
    }
}

function validateEvent(
    value: unknown,
    path: string,
    requestId: string,
): asserts value is StreamEvent {
    const event = record(value, path);
    const kind = text(event.kind, `${path}.kind`);
    switch (kind) {
        case "run.started":
            validateOperationRequest(event.request);
            if ((event.request as OperationRequest).requestId !== requestId) {
                fail(
                    `${path}.request.requestId`,
                    "does not match frame requestId",
                );
            }
            break;
        case "message.started":
            validateMessage(event.message, `${path}.message`);
            break;
        case "part.started":
            text(event.messageId, `${path}.messageId`);
            validatePart(event.part, `${path}.part`);
            break;
        case "part.delta":
            text(event.messageId, `${path}.messageId`);
            text(event.partId, `${path}.partId`);
            json(event.delta, `${path}.delta`);
            break;
        case "part.completed":
            text(event.messageId, `${path}.messageId`);
            text(event.partId, `${path}.partId`);
            if (event.value !== undefined) json(event.value, `${path}.value`);
            break;
        case "message.completed":
            text(event.messageId, `${path}.messageId`);
            if (event.finishReason !== undefined) {
                string(event.finishReason, `${path}.finishReason`);
            }
            break;
        case "tool.call":
            text(event.messageId, `${path}.messageId`);
            text(event.callId, `${path}.callId`);
            text(event.name, `${path}.name`);
            if (event.arguments !== undefined) {
                json(event.arguments, `${path}.arguments`);
            }
            if (event.argumentsText !== undefined) {
                string(event.argumentsText, `${path}.argumentsText`);
            }
            break;
        case "tool.result":
            text(event.messageId, `${path}.messageId`);
            text(event.callId, `${path}.callId`);
            if (event.result !== undefined) {
                json(event.result, `${path}.result`);
            }
            if (event.parts !== undefined) {
                if (!Array.isArray(event.parts)) {
                    fail(`${path}.parts`, "must be an array");
                }
                event.parts.forEach((part, index) =>
                    validatePart(part, `${path}.parts[${index}]`)
                );
            }
            if (event.isError !== undefined) {
                boolean(event.isError, `${path}.isError`);
            }
            if (event.error !== undefined) {
                validateError(event.error, `${path}.error`);
            }
            break;
        case "usage":
            validateUsage(event.usage, `${path}.usage`);
            break;
        case "checkpoint":
            text(event.stateHash, `${path}.stateHash`);
            if (!/^sha256:[0-9a-f]{64}$/.test(event.stateHash as string)) {
                fail(
                    `${path}.stateHash`,
                    "must be sha256 followed by 64 lowercase hexadecimal digits",
                );
            }
            break;
        case "run.completed":
        case "run.cancelled":
        case "run.cancel.requested":
            if (event.reason !== undefined) {
                string(event.reason, `${path}.reason`);
            }
            break;
        case "run.error":
            validateError(event.error, `${path}.error`);
            break;
        case "custom":
            text(event.name, `${path}.name`);
            if (event.value !== undefined) json(event.value, `${path}.value`);
            break;
        default:
            fail(`${path}.kind`, `unknown standard event ${kind}; use custom`);
    }
}

function validateUsage(value: unknown, path: string): asserts value is Usage {
    const usage = record(value, path);
    for (
        const key of [
            "inputTokens",
            "outputTokens",
            "reasoningTokens",
            "cachedInputTokens",
            "cacheWriteTokens",
            "totalTokens",
        ]
    ) {
        if (usage[key] !== undefined) {
            nonNegativeInteger(usage[key], `${path}.${key}`);
        }
    }
    if (
        usage.cost !== undefined &&
        (typeof usage.cost !== "string" || !/^\d+(?:\.\d+)?$/.test(usage.cost))
    ) {
        fail(`${path}.cost`, "must be a non-negative decimal string");
    }
    if (usage.currency !== undefined) text(usage.currency, `${path}.currency`);
    if (usage.extensions !== undefined) {
        jsonObject(usage.extensions, `${path}.extensions`);
    }
}

function validateError(
    value: unknown,
    path: string,
    ancestors = new Set<object>(),
): asserts value is CanonicalError {
    const error = record(value, path);
    if (ancestors.has(error)) fail(path, "error cause contains a cycle");
    ancestors.add(error);
    try {
        text(error.code, `${path}.code`);
        text(error.message, `${path}.message`);
        if (error.retryable !== undefined) {
            boolean(error.retryable, `${path}.retryable`);
        }
        if (error.providerCode !== undefined) {
            string(error.providerCode, `${path}.providerCode`);
        }
        if (error.status !== undefined) {
            nonNegativeInteger(error.status, `${path}.status`);
        }
        if (error.details !== undefined) json(error.details, `${path}.details`);
        if (error.cause !== undefined) {
            validateError(error.cause, `${path}.cause`, ancestors);
        }
        if (error.extensions !== undefined) {
            jsonObject(error.extensions, `${path}.extensions`);
        }
    } finally {
        ancestors.delete(error);
    }
}

function json(
    value: unknown,
    path: string,
    ancestors = new Set<object>(),
): asserts value is JsonValue {
    if (
        value === null || typeof value === "string" ||
        typeof value === "boolean"
    ) return;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) fail(path, "contains a non-finite number");
        return;
    }
    if (typeof value !== "object") {
        fail(path, `contains non-JSON value ${typeof value}`);
    }
    if (ancestors.has(value)) fail(path, "contains a cycle");
    const prototype = Object.getPrototypeOf(value);
    if (
        !Array.isArray(value) && prototype !== Object.prototype &&
        prototype !== null
    ) {
        fail(path, "contains a non-plain object");
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            value.forEach((item, index) =>
                json(item, `${path}[${index}]`, ancestors)
            );
        } else {
            for (const [key, item] of Object.entries(value)) {
                json(item, `${path}.${key}`, ancestors);
            }
        }
    } finally {
        ancestors.delete(value);
    }
}

function jsonObject(
    value: unknown,
    path: string,
): asserts value is Record<string, JsonValue> {
    record(value, path);
    json(value, path);
}

function record(value: unknown, path: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(path, "must be an object");
    }
    return value as Record<string, unknown>;
}

function operationId(value: unknown, path: string): string {
    const result = text(value, path);
    if (!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(result)) {
        fail(path, "must be a lowercase namespaced operation id");
    }
    return result;
}

function stringArray(value: unknown, path: string): void {
    if (value === undefined) return;
    if (!Array.isArray(value)) fail(path, "must be an array");
    const seen = new Set<string>();
    for (const [index, item] of value.entries()) {
        const result = text(item, `${path}[${index}]`);
        if (seen.has(result)) {
            fail(`${path}[${index}]`, `duplicate value ${result}`);
        }
        seen.add(result);
    }
}

function text(value: unknown, path: string): string {
    if (typeof value !== "string" || value.length === 0) {
        fail(path, "must be a non-empty string");
    }
    return value;
}

function string(value: unknown, path: string): string {
    if (typeof value !== "string") fail(path, "must be a string");
    return value;
}

function oneOf(
    value: unknown,
    options: readonly string[],
    path: string,
): string {
    const result = text(value, path);
    if (!options.includes(result)) {
        fail(path, `must be one of ${options.join(", ")}`);
    }
    return result;
}

function boolean(value: unknown, path: string): boolean {
    if (typeof value !== "boolean") fail(path, "must be a boolean");
    return value;
}

function finiteNumber(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(path, "must be a finite number");
    }
    return value;
}

function positiveInteger(value: unknown, path: string): number {
    const result = nonNegativeInteger(value, path);
    if (result === 0) fail(path, "must be greater than zero");
    return result;
}

function nonNegativeInteger(value: unknown, path: string): number {
    if (
        typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
    ) {
        fail(path, "must be a non-negative safe integer");
    }
    return value;
}

function dateTime(value: unknown, path: string): string {
    const result = text(value, path);
    if (
        !Number.isFinite(Date.parse(result)) ||
        !/(?:Z|[+-]\d{2}:\d{2})$/.test(result)
    ) {
        fail(path, "must be an RFC 3339 date-time with timezone");
    }
    return result;
}

function equal(value: unknown, expected: unknown, path: string): void {
    if (value !== expected) fail(path, `must equal ${String(expected)}`);
}

function fail(path: string, message: string): never {
    throw new HipValidationError(path, message);
}
