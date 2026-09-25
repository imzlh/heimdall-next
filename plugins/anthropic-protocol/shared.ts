import {
    type ContentPart,
    type Extensions,
    type GenerationRequest,
    type JsonObject,
    type JsonValue,
    type Message,
    type OperationRequest,
    ProtocolError,
} from "@heimdall/contracts";
import { type ConversationState } from "@heimdall/hip";

export type SseEvent = { event: string; data: unknown };

export function asObject(value: unknown): JsonObject | undefined {
    return isObject(value) ? value as JsonObject : undefined;
}

export function requireObject(value: unknown, message: string): JsonObject {
    const object = asObject(value);
    if (!object) throw new ProtocolError(400, message);
    return object;
}

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
    if (
        value === null || typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
    ) return true;
    if (Array.isArray(value)) return value.every(isJsonValue);
    return isObject(value) && Object.values(value).every(isJsonValue);
}

export function nonEmptyString(value: unknown, message: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new ProtocolError(400, message);
    }
    return value;
}

export function nonEmptyOrBlankString(value: unknown, message: string): string {
    if (typeof value !== "string") throw new ProtocolError(400, message);
    return value;
}

export function optionalString(
    value: unknown,
    label: string,
): string | undefined {
    return value === undefined
        ? undefined
        : nonEmptyString(value, `${label} must be a non-empty string`);
}

export function parseJsonText(value: string): JsonValue | undefined {
    try {
        const parsed: unknown = JSON.parse(value);
        return isJsonValue(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

export function encodeUtf8(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let result = "";
    for (const byte of bytes) result += String.fromCharCode(byte);
    return btoa(result);
}

/** Remove protocol fields that look like credentials before retaining raw JSON. */
export function sanitizeJson(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(sanitizeJson);
    if (!isObject(value)) return value;
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
        if (isSensitiveKey(key) || !isJsonValue(item)) continue;
        result[key] = sanitizeJson(item);
    }
    return result;
}

export function isSensitiveKey(key: string): boolean {
    const normalized = key.toLowerCase().replaceAll(/[-_]/g, "");
    return normalized === "authorization" ||
        normalized === "apikey" ||
        normalized === "accesstoken" ||
        normalized === "refreshtoken" ||
        normalized === "password" ||
        normalized === "secret" ||
        normalized === "credential" ||
        normalized === "cookie" ||
        normalized.endsWith("secret") ||
        normalized.endsWith("token");
}

export function unknownFields(
    value: JsonObject,
    known: ReadonlySet<string>,
): Record<string, JsonValue> {
    const raw: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
        if (known.has(key) || isSensitiveKey(key) || !isJsonValue(item)) {
            continue;
        }
        raw[key] = sanitizeJson(item);
    }
    return raw;
}

export function rawExtensions(raw: JsonObject): Extensions | undefined {
    return Object.keys(raw).length > 0
        ? { raw: sanitizeJson(raw) as JsonObject }
        : undefined;
}

export function compactUndefined<T>(value: T): T {
    if (Array.isArray(value)) return value.map(compactUndefined) as T;
    if (!isObject(value)) return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .map(([key, item]) => [key, compactUndefined(item)]),
    ) as T;
}

export function isTerminalStatus(status: ConversationState["status"]): boolean {
    return status === "completed" || status === "error" ||
        status === "cancelled";
}

export function generationPayload(input: OperationRequest): GenerationRequest {
    const payload = input.payload;
    if (!isObject(payload) || !Array.isArray(payload.messages)) {
        throw new ProtocolError(
            500,
            `Anthropic protocol cannot serialize vocabulary for ${input.operation}`,
            "invalid_internal_payload",
        );
    }
    return payload as GenerationRequest;
}

export function isPublicReasoning(part: ContentPart): boolean {
    return part.type === "reasoning" &&
        part.visibility === "public";
}

export function isAnthropicVisiblePart(part: ContentPart): boolean {
    if (part.type === "reasoning") return isPublicReasoning(part);
    return part.type === "text" || part.type === "refusal" ||
        part.type === "tool_call" || part.type === "image" ||
        part.type === "document" || part.type === "custom";
}

export function anthropicPartIndex(
    message: Message | undefined,
    id: string,
): number {
    if (!message) return 0;
    let index = 0;
    for (const part of message.parts) {
        if (part.id === id) return index;
        if (isAnthropicVisiblePart(part)) index++;
    }
    return index;
}

export function inferInputModalities(
    messages: readonly Message[],
): readonly string[] {
    const modalities = new Set<string>();
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type === "tool_call" || part.type === "tool_result") {
                continue;
            }
            modalities.add(
                part.type === "reasoning" || part.type === "refusal"
                    ? "text"
                    : part.type,
            );
        }
    }
    return [...modalities].sort();
}

export function requiredCapabilities(
    request: GenerationRequest,
): readonly string[] {
    const capabilities = new Set<string>();
    if (request.tools?.length) capabilities.add("tools");
    const raw = asObject(request.extensions?.raw);
    if (raw?.thinking !== undefined) capabilities.add("reasoning");
    for (const modality of inferInputModalities(request.messages)) {
        if (modality !== "text") capabilities.add(`${modality}.input`);
    }
    return [...capabilities].sort();
}

export function enqueueSse(
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder,
    value: unknown,
    event: string,
): void {
    controller.enqueue(
        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`),
    );
}
