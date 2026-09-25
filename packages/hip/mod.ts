/**
 * Heimdall Internal Protocol (HIP) v1 value contract.
 *
 * This module is the canonical, transport-free vocabulary shared by the
 * kernel and protocol/source adapters. It contains value shapes and service
 * ports only; validation, reduction, persistence, and provider behavior live
 * in the host packages.
 */

export const HIP_VERSION = 1 as const;
export type HipVersion = typeof HIP_VERSION;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {
    readonly [key: string]: JsonValue;
};
type JsonObject = Readonly<Record<string, JsonValue>>;
export type Extensions = JsonObject;

/** Open, namespaced identifier such as `generation.create` or `acme.rerank`. */
export type OperationId = string;

export const STANDARD_ROLES = [
    "system",
    "developer",
    "user",
    "assistant",
    "tool",
] as const;
export type StandardRole = typeof STANDARD_ROLES[number];

/** Open string so protocol plugins can introduce roles without a core release. */
export type Role = string;

export interface BlobRef {
    readonly uri?: string;
    readonly mediaType: string;
    readonly bytes?: number;
    readonly sha256?: string;
    readonly dataBase64?: string;
    readonly extensions?: Extensions;
}

export interface PartBase {
    readonly id: string;
    readonly done?: boolean;
    readonly extensions?: Extensions;
}

export interface TextPart extends PartBase {
    readonly type: "text";
    readonly text: string;
}

export type ReasoningVisibility = "public" | "private" | "redacted";

export interface ReasoningPart extends PartBase {
    readonly type: "reasoning";
    readonly text: string;
    /** Adapters must set this explicitly before crossing a client boundary. */
    readonly visibility?: ReasoningVisibility;
    /** Opaque provider integrity data; adapters may forward it only by policy. */
    readonly signature?: string;
}

export interface ImagePart extends PartBase {
    readonly type: "image";
    readonly source: BlobRef;
    readonly detail?: "low" | "high" | "auto";
}

export interface AudioPart extends PartBase {
    readonly type: "audio";
    readonly source: BlobRef;
    readonly transcript?: string;
}

export interface VideoPart extends PartBase {
    readonly type: "video";
    readonly source: BlobRef;
    readonly durationMs?: number;
}

export interface DocumentPart extends PartBase {
    readonly type: "document";
    readonly source: BlobRef;
    readonly title?: string;
}

export interface JsonPart extends PartBase {
    readonly type: "json";
    /** A complete value, when available. */
    readonly value?: JsonValue;
    /** Incremental JSON text is retained until it can be parsed safely. */
    readonly text?: string;
}

export type ToolCallStatus = "in_progress" | "completed" | "failed";

export interface ToolCallPart extends PartBase {
    readonly type: "tool_call";
    readonly callId: string;
    readonly name: string;
    /** Exact provider argument text; parsing is optional and never authoritative. */
    readonly argumentsText: string;
    readonly arguments?: JsonValue;
    readonly status?: ToolCallStatus;
}

export interface ToolResultPart extends PartBase {
    readonly type: "tool_result";
    readonly callId: string;
    readonly result?: JsonValue;
    readonly parts?: readonly ContentPart[];
    readonly isError?: boolean;
    /** Structured failure details when the tool did not produce a result. */
    readonly error?: CanonicalError;
}

export interface RefusalPart extends PartBase {
    readonly type: "refusal";
    readonly text: string;
}

export interface CitationPart extends PartBase {
    readonly type: "citation";
    readonly label?: string;
    readonly url?: string;
    readonly quote?: string;
}

export interface CustomPart extends PartBase {
    readonly type: "custom";
    readonly name: string;
    readonly value?: JsonValue;
}

export type ContentPart =
    | TextPart
    | ReasoningPart
    | ImagePart
    | AudioPart
    | VideoPart
    | DocumentPart
    | JsonPart
    | ToolCallPart
    | ToolResultPart
    | RefusalPart
    | CitationPart
    | CustomPart;

export interface Message {
    readonly id: string;
    readonly role: Role;
    readonly parentId?: string;
    readonly parts: readonly ContentPart[];
    readonly createdAt?: string;
    readonly name?: string;
    readonly status?: "in_progress" | "completed" | "failed";
    readonly finishReason?: string;
    readonly metadata?: JsonObject;
    readonly extensions?: Extensions;
}

export type ToolExecution = "server" | "client" | "either";

export interface ToolDefinition {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: JsonValue;
    readonly outputSchema?: JsonValue;
    readonly execution?: ToolExecution;
    readonly extensions?: Extensions;
}

/** Standard generation payload carried by an OperationRequest. */
export interface GenerationRequest {
    readonly messages: readonly Message[];
    readonly model?: string;
    readonly instructions?: string;
    readonly tools?: readonly ToolDefinition[];
    readonly toolChoice?: "auto" | "none" | "required" | {
        readonly name: string;
    };
    readonly responseFormat?: "text" | "json" | { readonly schema: JsonValue };
    readonly outputModalities?: readonly string[];
    readonly sampling?: Readonly<Record<string, number>>;
    readonly stream?: boolean;
    readonly metadata?: JsonObject;
    readonly extensions?: Extensions;
}

/** Escape hatch for an operation without a shared HIP payload vocabulary. */
export interface CustomOperationPayload {
    /** Stable plugin or protocol namespace for interpreting `value`. */
    readonly vocabulary: string;
    readonly value: JsonValue;
    readonly extensions?: Extensions;
}

export type OperationPayload = GenerationRequest | CustomOperationPayload;

/** Facts needed for routing and safety; the kernel does not inspect payload fields. */
export interface OperationTraits {
    readonly model?: string;
    readonly streaming?: boolean;
    readonly inputModalities?: readonly string[];
    readonly outputModalities?: readonly string[];
    readonly requiredCapabilities?: readonly string[];
    readonly idempotent?: boolean;
}

/** Universal request envelope exchanged by protocol and source adapters. */
export interface OperationRequest<
    Payload extends OperationPayload = OperationPayload,
> {
    readonly version: HipVersion;
    readonly requestId: string;
    readonly operation: OperationId;
    readonly payload: Payload;
    readonly traits: OperationTraits;
    readonly metadata?: JsonObject;
    readonly extensions?: Extensions;
}

/** A control message requesting that an active operation stop. */
export interface CancelRequest {
    readonly version: HipVersion;
    readonly requestId: string;
    readonly streamId?: string;
    readonly reason?: string;
    readonly metadata?: JsonObject;
    readonly extensions?: Extensions;
}

/** @deprecated Use `CancelRequest`; retained for migration compatibility. */
export type OperationCancelRequest = CancelRequest;
/** @deprecated Use `CancelRequest`; retained for migration compatibility. */
export type CancellationRequest = CancelRequest;

export interface Usage {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly reasoningTokens?: number;
    readonly cachedInputTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly totalTokens?: number;
    /** Decimal string avoids floating point differences between adapters. */
    readonly cost?: string;
    readonly currency?: string;
    readonly extensions?: Extensions;
}

/** Provider-independent error envelope used by `run.error`. */
export interface CanonicalError {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
    readonly providerCode?: string;
    readonly status?: number;
    readonly details?: JsonValue;
    readonly cause?: CanonicalError;
    readonly extensions?: Extensions;
}

export interface RunStartedEvent {
    readonly kind: "run.started";
    readonly request: OperationRequest;
}
export interface MessageStartedEvent {
    readonly kind: "message.started";
    readonly message: Message;
}
export interface PartStartedEvent {
    readonly kind: "part.started";
    readonly messageId: string;
    readonly part: ContentPart;
}
export interface PartDeltaEvent {
    readonly kind: "part.delta";
    readonly messageId: string;
    readonly partId: string;
    /** Append-only delta; v1 reducers define portable merging for string deltas. */
    readonly delta: string | JsonValue | BlobRef;
}
export interface PartCompletedEvent {
    readonly kind: "part.completed";
    readonly messageId: string;
    readonly partId: string;
    /** Adapter hint; generic reducers close the part without replacing its value. */
    readonly value?: JsonValue;
}
export interface MessageCompletedEvent {
    readonly kind: "message.completed";
    readonly messageId: string;
    readonly finishReason?: string;
}
export interface ToolCallEvent {
    readonly kind: "tool.call";
    readonly messageId: string;
    readonly callId: string;
    readonly name: string;
    readonly arguments?: JsonValue;
    readonly argumentsText?: string;
}
export interface ToolResultEvent {
    readonly kind: "tool.result";
    readonly messageId: string;
    readonly callId: string;
    readonly result?: JsonValue;
    readonly parts?: readonly ContentPart[];
    readonly isError?: boolean;
    readonly error?: CanonicalError;
}
export interface UsageEvent {
    readonly kind: "usage";
    readonly usage: Usage;
}
export interface CheckpointEvent {
    readonly kind: "checkpoint";
    readonly stateHash: string;
}
export interface RunCompletedEvent {
    readonly kind: "run.completed";
    readonly finishReason?: string;
}
export interface RunErrorEvent {
    readonly kind: "run.error";
    readonly error: CanonicalError;
}
/** Records the executor's acknowledgement that the operation stopped. */
export interface RunCancelledEvent {
    readonly kind: "run.cancelled";
    readonly reason?: string;
}
/** Records cancellation intent; it does not make the run terminal by itself. */
export interface RunCancelRequestedEvent {
    readonly kind: "run.cancel.requested";
    readonly reason?: string;
}
export interface CustomStreamEvent {
    readonly kind: "custom";
    readonly name: string;
    readonly value?: JsonValue;
    readonly extensions?: Extensions;
}

export type StreamEvent =
    | RunStartedEvent
    | MessageStartedEvent
    | PartStartedEvent
    | PartDeltaEvent
    | PartCompletedEvent
    | MessageCompletedEvent
    | ToolCallEvent
    | ToolResultEvent
    | UsageEvent
    | CheckpointEvent
    | RunCompletedEvent
    | RunErrorEvent
    | RunCancelledEvent
    | RunCancelRequestedEvent
    | CustomStreamEvent;

export type StreamTerminalEvent =
    | RunCompletedEvent
    | RunErrorEvent
    | RunCancelledEvent;

export type StreamLifecycleEvent =
    | RunStartedEvent
    | RunCompletedEvent
    | RunErrorEvent
    | RunCancelledEvent
    | RunCancelRequestedEvent;

/** Ordered, append-only event envelope. */
export interface StreamFrame<E extends StreamEvent = StreamEvent> {
    readonly version: HipVersion;
    readonly streamId: string;
    readonly requestId: string;
    readonly seq: number;
    readonly eventId: string;
    readonly timestamp: string;
    readonly event: E;
    readonly causationId?: string;
    readonly extensions?: Extensions;
}

export type HipFrame = StreamFrame;

export type RunStatus =
    | "idle"
    | "running"
    | "completed"
    | "error"
    | "cancelled";

/** Generic state projection used by reducers and checkpoint implementations. */
export interface HipState {
    readonly streamId: string;
    readonly requestId: string;
    readonly seq: number;
    readonly status: RunStatus;
    readonly checkpointHash?: string;
    readonly [key: string]: unknown;
}

/** Conventional message projection for adapters that materialize a run. */
export interface ConversationState extends HipState {
    readonly messages: Readonly<Record<string, Message>>;
    readonly usage?: Usage;
    readonly error?: CanonicalError;
    readonly finishReason?: string;
    readonly seenEventIds: readonly string[];
    readonly seenEventSignatures: Readonly<Record<string, string>>;
}

export interface HipReducer<State extends HipState = HipState> {
    initial(streamId: string, requestId: string): State;
    apply(state: State, frame: StreamFrame): State;
}

export interface HipValidator<T> {
    validate(value: unknown): asserts value is T;
}

export interface HipHasher<State extends HipState = HipState> {
    hash(state: State): string | PromiseLike<string>;
}

export interface HipCodec<Request = OperationRequest, Frame = StreamFrame> {
    encodeRequest(request: Request): Uint8Array | string;
    decodeRequest(value: Uint8Array | string): Request;
    encodeFrame(frame: Frame): Uint8Array | string;
    decodeFrame(value: Uint8Array | string): Frame;
}

/** @deprecated Use `GenerationRequest`; retained for protocol plugin migration. */
export type GenerateRequest = GenerationRequest;

export { applyFrame, HipProtocolError, initialState } from "./reducer.ts";
export {
    checkpointState,
    computeStateHash,
    sha256Hex,
    stableJson,
} from "./hash.ts";
export {
    assertJsonSafe,
    HipValidationError,
    validateOperationRequest,
    validateStreamFrame,
} from "./validation.ts";
