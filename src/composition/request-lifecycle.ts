import type { OperationRequest, StreamFrame, Usage } from "@heimdall/hip";
import type { LifecyclePort } from "@heimdall/kernel";
import type { JsonObject, JsonValue, RequestStore } from "@heimdall/storage";

const SECRET_KEY =
    /^(api[-_]?key|authorization|proxy[-_]?authorization|password|passwd|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|credential|credentials|cookie|set-cookie|x-api-key|token)$/i;

export interface RequestLifecycleOptions {
    /** Clock used when a run completes. Defaults to the current time. */
    readonly now?: () => Date;
}

/**
 * Map kernel lifecycle callbacks onto the request journal.
 *
 * HIP values are redacted here, before they become stored JSON. The kernel
 * stays free of SQLite, and the store stays free of HIP types.
 */
export function createRequestLifecycle(
    store: RequestStore,
    options: RequestLifecycleOptions = {},
): LifecyclePort {
    const now = options.now ?? (() => new Date());
    return {
        begin(request, lifecycle) {
            const metadata = metadataRecord(request.metadata);
            store.createRequest({
                requestId: request.requestId,
                streamId: lifecycle.streamId,
                operation: request.operation,
                model: modelOf(request),
                protocolPluginId: metadataString(metadata, "protocolPluginId"),
                upstreamPluginId: metadataString(metadata, "upstreamPluginId"),
                receivedAt: lifecycle.startedAt,
                request: redactJson(request),
                metadata: redactMetadata(metadata),
            });
        },
        append(frame) {
            const redacted = redactFrame(frame);
            store.appendFrame({
                version: redacted.version,
                streamId: redacted.streamId,
                requestId: redacted.requestId,
                seq: redacted.seq,
                eventId: redacted.eventId,
                timestamp: redacted.timestamp,
                event: redacted.event,
                causationId: redacted.causationId,
                extensions: redacted.extensions,
            });
            if (frame.event.kind === "usage") {
                store.putUsage({
                    requestId: frame.requestId,
                    ...usageFields(frame.event.usage),
                    updatedAt: frame.timestamp,
                });
            }
        },
        complete(requestId, outcome) {
            store.updateRequest(requestId, {
                status: outcome,
                completedAt: now().toISOString(),
            });
        },
    };
}

/**
 * Remove credentials and inline binary payloads before a value is stored.
 * `dataBase64` is dropped because request history must not keep raw bytes.
 */
export function redactJson(value: unknown): JsonValue {
    const redacted = redactValue(value);
    if (redacted === undefined) return null;
    return redacted;
}

function redactFrame(frame: StreamFrame): {
    version: number;
    streamId: string;
    requestId: string;
    seq: number;
    eventId: string;
    timestamp: string;
    event: JsonValue;
    causationId?: string;
    extensions?: JsonObject;
} {
    const extensions = frame.extensions === undefined
        ? undefined
        : asObject(redactJson(frame.extensions));
    return {
        version: frame.version,
        streamId: frame.streamId,
        requestId: frame.requestId,
        seq: frame.seq,
        eventId: frame.eventId,
        timestamp: frame.timestamp,
        event: redactJson(frame.event),
        causationId: frame.causationId,
        extensions,
    };
}

function redactMetadata(
    metadata: Readonly<Record<string, unknown>> | undefined,
): JsonObject | undefined {
    if (metadata === undefined) return undefined;
    const redacted = asObject(redactJson(metadata));
    return redacted === undefined || Object.keys(redacted).length === 0
        ? undefined
        : redacted;
}

function redactValue(value: unknown): JsonValue | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) {
        return value.map((entry) => redactValue(entry) ?? null);
    }
    if (typeof value === "object") {
        const output: Record<string, JsonValue> = {};
        for (const [key, entry] of Object.entries(value)) {
            if (SECRET_KEY.test(key) || key === "dataBase64") continue;
            const next = redactValue(entry);
            if (next !== undefined) output[key] = next;
        }
        return output;
    }
    return null;
}

function usageFields(usage: Usage): Omit<Usage, "extensions"> & {
    extensions?: JsonObject;
} {
    return {
        inputTokens: count(usage.inputTokens),
        outputTokens: count(usage.outputTokens),
        reasoningTokens: count(usage.reasoningTokens),
        cachedInputTokens: count(usage.cachedInputTokens),
        cacheWriteTokens: count(usage.cacheWriteTokens),
        totalTokens: count(usage.totalTokens),
        cost: typeof usage.cost === "string" ? usage.cost : undefined,
        currency: typeof usage.currency === "string"
            ? usage.currency
            : undefined,
        extensions: usage.extensions === undefined
            ? undefined
            : asObject(redactJson(usage.extensions)),
    };
}

function count(value: number | undefined): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
}

function modelOf(request: OperationRequest): string | undefined {
    if (typeof request.traits.model === "string") return request.traits.model;
    const payload = request.payload as { model?: unknown };
    return typeof payload.model === "string" ? payload.model : undefined;
}

function metadataRecord(
    metadata: OperationRequest["metadata"],
): Readonly<Record<string, unknown>> | undefined {
    return metadata;
}

function metadataString(
    metadata: Readonly<Record<string, unknown>> | undefined,
    key: string,
): string | undefined {
    const value = metadata?.[key];
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined;
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
    if (value === undefined || value === null || Array.isArray(value)) {
        return undefined;
    }
    if (typeof value !== "object") return undefined;
    return value;
}
