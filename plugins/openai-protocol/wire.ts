import {
    type ContentPart,
    type Extensions,
    type GenerateRequest,
    type JsonValue,
    type Message,
    type OperationRequest,
} from "@heimdall/contracts";
import type { ConversationState } from "@heimdall/hip";
import { type JsonObject, ProtocolError } from "@heimdall/contracts";

export function isTerminalStatus(
    status: ConversationState["status"],
): boolean {
    return status === "completed" || status === "error" ||
        status === "cancelled";
}

export function isPublicReasoning(
    part: ContentPart,
): boolean {
    return part.type === "reasoning" &&
        part.visibility === "public";
}

export function openAIStreamError(error: unknown): {
    code: string;
    message: string;
    type: string;
} {
    if (error instanceof ProtocolError) {
        return {
            code: error.code,
            message: error.message,
            type: error.code,
        };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { code: "server_error", message, type: "server_error" };
}

export function chatFinishReason(
    reason: string | undefined,
    parts: readonly ContentPart[],
): string {
    if (reason === "tool_call" || reason === "tool_use") return "tool_calls";
    if (reason === "max_tokens") return "length";
    if (reason) return reason;
    return parts.some((part) => part.type === "tool_call")
        ? "tool_calls"
        : "stop";
}

export function responsesStatus(
    status: ConversationState["status"] | undefined,
): "in_progress" | "completed" | "failed" | "incomplete" {
    if (status === "completed") return "completed";
    if (status === "error") return "failed";
    if (status === "cancelled") return "incomplete";
    return "in_progress";
}

export function wantsStreamUsage(request: GenerateRequest): boolean {
    const raw = asObject(request.extensions?.raw);
    return asObject(raw?.stream_options)?.include_usage === true;
}

export function generationPayload(input: OperationRequest): GenerateRequest {
    const payload = input.payload;
    if (!isObject(payload) || !Array.isArray(payload.messages)) {
        throw new ProtocolError(
            500,
            `OpenAI protocol cannot serialize vocabulary for ${input.operation}`,
            "invalid_internal_payload",
        );
    }
    return payload as GenerateRequest;
}

export function parseModalities(
    value: JsonValue | undefined,
): readonly string[] | undefined {
    if (value === undefined) return undefined;
    if (
        !Array.isArray(value) ||
        value.some((item) => typeof item !== "string" || !item)
    ) {
        throw new ProtocolError(
            400,
            "modalities must be an array of non-empty strings",
        );
    }
    return value as string[];
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
    request: GenerateRequest,
): readonly string[] {
    const capabilities = new Set<string>();
    if (request.tools?.length) capabilities.add("tools");
    if (typeof request.responseFormat === "object") {
        capabilities.add("structured_output");
    }
    for (const modality of inferInputModalities(request.messages)) {
        if (modality !== "text") capabilities.add(`${modality}.input`);
    }
    for (const modality of request.outputModalities ?? []) {
        if (modality !== "text") capabilities.add(`${modality}.output`);
    }
    return [...capabilities].sort();
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

export function toolPartIndex(
    message: Message | undefined,
    partId: string,
): number {
    if (!message) return 0;
    return message.parts
        .filter((part) => part.type === "tool_call")
        .findIndex((part) => part.id === partId);
}

export function enqueueSse(
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder,
    value: unknown,
    event?: string,
): void {
    const prefix = event ? `event: ${event}\n` : "";
    controller.enqueue(
        encoder.encode(`${prefix}data: ${JSON.stringify(value)}\n\n`),
    );
}

export function unknownFields(
    value: JsonObject,
    known: ReadonlySet<string>,
): Record<string, JsonValue> {
    const raw: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
        if (!known.has(key)) raw[key] = item;
    }
    return raw;
}

export function rawExtensions(raw: JsonObject): Extensions | undefined {
    return Object.keys(raw).length > 0 ? { raw } : undefined;
}

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
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") {
        throw new ProtocolError(400, `${label} must be a string`);
    }
    return value;
}

export function parseJsonText(value: string): JsonValue | undefined {
    try {
        const parsed: unknown = JSON.parse(value);
        return isJsonValue(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

export function dataMediaType(value: string): string | undefined {
    if (!value.startsWith("data:")) return undefined;
    const metadata = value.slice(5);
    const semicolon = metadata.indexOf(";");
    const comma = metadata.indexOf(",");
    const end = semicolon < 0
        ? comma
        : comma < 0
        ? semicolon
        : Math.min(semicolon, comma);
    if (end <= 0) return undefined;
    return metadata.slice(0, end) || undefined;
}

export function stripDataUrl(value: string): string {
    const comma = value.indexOf(",");
    return value.startsWith("data:") && comma >= 0
        ? value.slice(comma + 1)
        : value;
}

export function audioMediaType(format: string): string {
    if (format === "mp3" || format === "mpeg") return "audio/mpeg";
    if (format === "wav") return "audio/wav";
    return `audio/${format}`;
}

export function toUnixSeconds(timestamp: string): number {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}
