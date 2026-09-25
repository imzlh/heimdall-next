import type { SignalRMessageTypeValue } from "./constants.ts";

export type JsonObject = Record<string, unknown>;

export interface SignalRHandshakeRequest {
    protocol: "json";
    version: 1;
}

export interface SignalRHandshakeResponse {
    error?: string;
    [key: string]: unknown;
}

export interface SignalRFrame {
    type?: SignalRMessageTypeValue | number;
    invocationId?: string;
    target?: string;
    arguments?: unknown[];
    item?: unknown;
    result?: unknown;
    error?: unknown;
    allowReconnect?: boolean;
    [key: string]: unknown;
}

export interface ChatHubAccount {
    oid: string;
    tid: string;
    accessToken: string;
}

export interface ChatHubSessionIds {
    /** Page or logical-session scope. */
    sessionId: string;
    /** Multi-turn conversation scope. */
    conversationId: string;
    /** Single ChatHub invocation scope; reused only when attaching. */
    chatSessionId: string;
}

export interface ChatHubUrlOptions extends ChatHubAccount, ChatHubSessionIds {
    clientRequestId?: string;
    licenseType?: string;
    scenario?: string;
    disableMemory?: boolean;
    endpoint?: string;
    query?: Record<string, string | number | boolean | undefined>;
}

export interface ChatHubPlugin {
    Id: string;
    Source: "BuiltIn" | "API" | "MCPServer" | string;
    Description?: string;
    Parameters?: unknown;
    [key: string]: unknown;
}

export interface MessageAnnotationMetadata {
    "@type"?: string;
    annotationType?: string;
    fileType?: string;
    fileName?: string;
    [key: string]: unknown;
}

export interface MessageAnnotation {
    id: string;
    messageAnnotationMetadata?: MessageAnnotationMetadata;
    messageAnnotationType?: string;
    [key: string]: unknown;
}

/**
 * One entry of `contentGenerationProgressList` (image generation progress).
 * Only the fields confirmed by the HAR evidence are typed; the pollUrl is a
 * base64-encoded credentials object, not a directly fetchable HTTP URL.
 */
export interface GenerationProgress {
    contentType?: string;
    size?: string;
    orientation?: string;
    pollUrl?: string;
    fileToken?: string;
    status?: number | null;
    ImageReferenceUrls?: string[];
    [key: string]: unknown;
}

export interface ChatMessage {
    id?: string;
    author?: string;
    text?: string;
    hiddenText?: string;
    contentType?: string;
    messageType?: string;
    contentOrigin?: string;
    createdAt?: string;
    locale?: string;
    searchQueries?: string[];
    adaptiveCards?: unknown[];
    messageAnnotations?: MessageAnnotation[];
    /** Cumulative reference dictionary keyed by reference id. */
    references?: Record<string, unknown>;
    suggestedResponses?: SuggestedResponse[];
    spokenText?: string;
    contentGenerationProgressList?: GenerationProgress[];
    scores?: unknown[];
    responseIdentifier?: string;
    turnCount?: number;
    storageMessageId?: string;
    [key: string]: unknown;
}

/**
 * A reference as it appears on a bot message. In observed traffic the value
 * under each reference id is an object with `targetLink` and a `displayData`
 * whose `content` is a JSON string that must be parsed a second time for
 * `Title`/`snippet`/`label`/`metadata`.
 */
export interface ChatHubReference {
    id?: string;
    title?: string;
    targetLink?: string;
    url?: string;
    displayData?: {
        type?: string;
        renderType?: string;
        content?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export interface SuggestedResponse extends ChatMessage {
    commandText?: string;
    suggestionCategory?: string;
}

export interface ChatHubRequest {
    text: string;
    invocationId?: string;
    /** Upstream engine selector (e.g. Claude_Sonnet_Reasoning); "Magic" when unset. */
    tone?: string;
    locale?: string;
    timezone?: string;
    timezoneOffset?: number;
    scenario?: string;
    licenseType?: string;
    plugins?: readonly ChatHubPlugin[];
    messageAnnotations?: MessageAnnotation[];
    previousMessages?: ChatMessage[];
    /** Extra argument-layer fields merged onto the chat payload. */
    extraArguments?: JsonObject;
}

export interface MetricsTimestamps {
    ConnectionStart?: string;
    UserInputStart?: string;
    ConnectionEstablished?: string;
    UserInputSubmit?: string;
    RequestSent?: string;
    FirstServiceResponseReceived?: string;
    FirstServiceResponseRendered?: string;
    FirstTokenReceived?: string;
    LastTokenReceived?: string;
    FirstTokenRendered?: string;
    SuggestionsRendered?: string;
    SuggestionsReceived?: string;
    [key: string]: string | undefined;
}

export interface TokenTimingStatistics {
    Mean: number;
    Median: number;
    Sd: number;
    Variance: number;
    Max: number;
    Min: number;
}

export interface ReceivedTokenMetrics {
    TokenCount: number;
    CharCount: number;
    TimeBetweenTokens: TokenTimingStatistics;
    AverageChunkSize: number;
    BurstRate: number;
    StallRate: number;
}

export interface SuggestedResponse extends ChatMessage {
    commandText?: string;
    suggestionCategory?: string;
}

export type ChatHubEventKind =
    | "handshake"
    | "ping"
    | "update"
    | "stream-item"
    | "completion"
    | "error"
    | "target"
    | "unknown";

export interface ChatHubEvent {
    kind: ChatHubEventKind;
    frame: SignalRFrame;
    raw: unknown;
    /** Genuine answer text for this frame (reasoning/progress excluded). */
    text?: string;
    /**
     * Chain-of-thought transcript for this frame, concatenated across the
     * frame's reasoning messages. Kept separate from `text` so the answer never
     * carries the thinking and consumers can surface it as reasoning.
     */
    reasoning?: string;
    /** Per-turn quota table; present only on the terminal StreamItem frame. */
    throttling?: ChatHubThrottling;
    /** Server-suggested conversation title; present only on the StreamItem frame. */
    chatName?: string;
    messages?: ChatMessage[];
    references?: ChatHubReference[];
    suggestions?: SuggestedResponse[];
    error?: unknown;
}

export interface ChatHubResult {
    text: string;
    events: ChatHubEvent[];
    references: ChatHubReference[];
    suggestions: SuggestedResponse[];
    completion: SignalRFrame;
    /** Metric snapshot for the optional second Metrics frame. */
    receivedTokenMetrics?: ReceivedTokenMetrics;
    /** The authoritative final text (from the stream item). */
    finalText?: string;
    /** The full chain-of-thought transcript accumulated across the turn. */
    reasoning?: string;
    /**
     * Per-turn quota counters and metering table from the terminal StreamItem
     * frame's `item.throttling`. The metering table lists each capability's
     * remaining allowance; a value of 0 means that capability is hard-disabled
     * for the account rather than temporarily throttled.
     */
    throttling?: ChatHubThrottling;
    /** Server-suggested conversation title (`item.defaultChatName`), ~the first prompt. */
    chatName?: string;
}

/** One capability's remaining allowance in the metering table. */
export interface ChatHubMeteringEntry {
    remainingAllowance?: number;
    [key: string]: unknown;
}

/** Per-turn quota counters plus the account's capability metering table. */
export interface ChatHubThrottling {
    maxNumUserMessagesInConversation?: number;
    numUserMessagesInConversation?: number;
    numLongDocSummaryUserMessagesInConversation?: number;
    /** Capability → remaining allowance (LLMOnly, ImageGeneration, ClaudeOpusQuery, …). */
    metering?: Record<string, ChatHubMeteringEntry>;
    [key: string]: unknown;
}

export interface WebSocketLike extends EventTarget {
    readonly readyState: number;
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
    close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface ChatHubClientOptions {
    webSocketFactory?: WebSocketFactory;
    connectTimeoutMs?: number;
    handshakeTimeoutMs?: number;
    idleTimeoutMs?: number;
    maxReconnectAttempts?: number;
    reconnectDelayMs?: number;
    clock?: () => Date;
}

export interface ChatCallOptions {
    signal?: AbortSignal;
    onEvent?: (event: ChatHubEvent) => void | Promise<void>;
}

export interface AttachOptions extends ChatCallOptions {
    maxReconnectAttempts?: number;
}
