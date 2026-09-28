import type {
    OperationRequest,
    StreamEvent,
    StreamFrame,
    Usage,
} from "@heimdall/hip";
import type { LifecyclePort } from "@heimdall/kernel";
import type { JsonObject, JsonValue, RequestStore } from "@heimdall/storage";
import { addText, newTally, tokensOf, type TokenTally } from "@heimdall/tokens";

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
    // Per-request token tallies, used to synthesize an estimated usage record
    // for any source that never emits a `usage` event (e.g. ChatHub). Cleared
    // when the run completes.
    const estimates = new Map<string, TokenEstimateState>();
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
            estimates.set(request.requestId, {
                input: inputTally(request),
                output: newTally(),
                reasoning: newTally(),
                parts: new Map(),
                seenUsage: false,
                firstToken: false,
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
                const tracked = estimates.get(frame.requestId);
                if (tracked) tracked.seenUsage = true;
                store.putUsage({
                    requestId: frame.requestId,
                    ...usageFields(frame.event.usage),
                    updatedAt: frame.timestamp,
                });
                return;
            }
            if (frame.event.kind === "run.error") {
                // Keep the reason so `complete` can stamp it on the request,
                // turning a bare "error" status into something diagnosable.
                const tracked = estimates.get(frame.requestId);
                if (tracked) {
                    tracked.error = asObject(redactJson(frame.event.error));
                }
            }
            const tracked = estimates.get(frame.requestId);
            // Stamp time-to-first-token once, when the first content frame lands.
            if (tracked && !tracked.firstToken && isContentFrame(frame.event)) {
                tracked.firstToken = true;
                store.markFirstToken(frame.requestId, frame.timestamp);
            }
            trackTokens(tracked, frame.event);
        },
        complete(requestId, outcome) {
            const tracked = estimates.get(requestId);
            estimates.delete(requestId);
            store.updateRequest(requestId, {
                status: outcome,
                completedAt: now().toISOString(),
                ...(outcome === "error" && tracked?.error !== undefined
                    ? { error: tracked.error }
                    : {}),
            });
            // Guarantee token stats for every source: when none reported usage,
            // record a rule-based estimate rather than leaving the request blank.
            if (tracked === undefined || tracked.seenUsage) return;
            const inputTokens = tokensOf(tracked.input);
            const outputTokens = tokensOf(tracked.output);
            const reasoningTokens = tokensOf(tracked.reasoning);
            if (inputTokens + outputTokens + reasoningTokens === 0) return;
            store.putUsage({
                requestId,
                inputTokens,
                outputTokens,
                ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
                totalTokens: inputTokens + outputTokens + reasoningTokens,
                updatedAt: now().toISOString(),
                // Marks a heuristic count so consumers can distinguish it from
                // provider-reported usage.
                extensions: { estimated: true },
            });
        },
    };
}

/**
 * Remove credentials and inline binary payloads before a value is stored.
 * `data` (raw image/audio bytes) is dropped because request history must not
 * keep binary blobs.
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
    // Raw binary (BlobRef.data) is never persisted to the journal.
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return null;
    if (Array.isArray(value)) {
        return value.map((entry) => redactValue(entry) ?? null);
    }
    if (typeof value === "object") {
        const output: Record<string, JsonValue> = {};
        for (const [key, entry] of Object.entries(value)) {
            // `data` binary is caught by the view guard above; a lingering
            // base64 `dataBase64` string is dropped here for defense in depth.
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

interface TokenEstimateState {
    input: TokenTally;
    output: TokenTally;
    reasoning: TokenTally;
    /** part key (`messageId:partId`) → which tally its deltas feed. */
    readonly parts: Map<string, "text" | "reasoning" | "other">;
    seenUsage: boolean;
    /** Set once the first content frame has stamped `firstTokenAt`. */
    firstToken: boolean;
    /** Redacted `run.error` payload, stamped onto the request on completion. */
    error?: JsonObject;
}

/**
 * Does this event carry the run's first generated content? A streamed delta or
 * the start of a text/reasoning/refusal/tool-call part counts; lifecycle and
 * empty scaffolding frames do not, so the stamp reflects real output latency.
 */
function isContentFrame(event: StreamEvent): boolean {
    if (event.kind === "part.delta") {
        return typeof event.delta === "string" && event.delta.length > 0;
    }
    if (event.kind === "part.started") {
        const part = event.part;
        if (part.type === "tool_call") return true;
        if (
            part.type === "text" || part.type === "reasoning" ||
            part.type === "refusal"
        ) {
            return part.text.length > 0;
        }
        return false;
    }
    return false;
}

function inputTally(request: OperationRequest): TokenTally {
    const tally = newTally();
    const payload = request.payload as {
        messages?: unknown;
        instructions?: unknown;
    };
    if (typeof payload.instructions === "string") {
        addText(tally, payload.instructions);
    }
    if (Array.isArray(payload.messages)) {
        for (const message of payload.messages) {
            const parts = (message as { parts?: unknown }).parts;
            if (!Array.isArray(parts)) continue;
            for (const part of parts) {
                const text = (part as { text?: unknown }).text;
                if (typeof text === "string") addText(tally, text);
            }
        }
    }
    return tally;
}

/** Accumulate generated text so a missing usage event can be estimated. */
function trackTokens(
    state: TokenEstimateState | undefined,
    event: StreamEvent,
): void {
    if (state === undefined) return;
    if (event.kind === "part.started") {
        const part = event.part;
        const key = `${event.messageId}:${part.id}`;
        if (part.type === "text" || part.type === "refusal") {
            state.parts.set(key, "text");
            addText(state.output, part.text);
        } else if (part.type === "reasoning") {
            state.parts.set(key, "reasoning");
            addText(state.reasoning, part.text);
        } else if (part.type === "tool_call") {
            // A tool call is generated output: the model produces the function
            // name and its argument JSON. Later deltas stream the arguments, so
            // route them to the output tally too (a tool-only turn is otherwise
            // counted as zero output).
            state.parts.set(key, "text");
            addText(state.output, part.name);
            addText(state.output, part.argumentsText);
        } else {
            state.parts.set(key, "other");
        }
        return;
    }
    if (event.kind === "part.delta" && typeof event.delta === "string") {
        const type = state.parts.get(`${event.messageId}:${event.partId}`);
        if (type === "text") addText(state.output, event.delta);
        else if (type === "reasoning") addText(state.reasoning, event.delta);
    }
}
