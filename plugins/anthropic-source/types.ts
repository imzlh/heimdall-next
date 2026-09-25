import type {
    JsonValue,
    OperationRequest,
    SourceContext as ContractSourceContext,
    StreamEvent,
    StreamFrame,
} from "@heimdall/contracts";

/** Loose object used while validating provider-owned JSON. */
export type WireObject = Record<string, unknown>;

/** The host used to expose unknown metadata during the initial migration. */
export type SourceContext = Omit<ContractSourceContext, "metadata"> & {
    readonly metadata: Readonly<Record<string, unknown>>;
};

export type FetchLike = typeof fetch;
export type FrameEmitter = (event: StreamEvent) => StreamFrame;
export type GenerationOperation = OperationRequest;

export const SSE_DONE = Symbol("sse-done");

export function isRecord(value: unknown): value is WireObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
    if (
        value === null || typeof value === "string" ||
        typeof value === "boolean"
    ) return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJsonValue);
    return isRecord(value) && Object.values(value).every(isJsonValue);
}
