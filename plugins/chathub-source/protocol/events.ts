import { ChatHubTarget, SignalRMessageType } from "./constants.ts";
import type {
    ChatHubEvent,
    ChatHubReference,
    ChatHubThrottling,
    ChatMessage,
    SignalRFrame,
    SuggestedResponse,
} from "./types.ts";

export class ChatHubProtocolError extends Error {
    constructor(
        message: string,
        public readonly frame: SignalRFrame,
    ) {
        super(message);
        this.name = "ChatHubProtocolError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asMessages(value: unknown): ChatMessage[] {
    if (!Array.isArray(value)) return [];
    return value.filter(isRecord) as ChatMessage[];
}

function collectMessages(
    value: unknown,
    output: ChatMessage[] = [],
): ChatMessage[] {
    if (Array.isArray(value)) {
        for (const item of value) collectMessages(item, output);
        return output;
    }
    if (!isRecord(value)) return output;

    const messages = asMessages(value.messages);
    output.push(...messages);
    for (const nested of Object.values(value)) {
        if (nested !== value.messages) collectMessages(nested, output);
    }
    return output;
}

function collectReferences(value: unknown): ChatHubReference[] {
    const references: ChatHubReference[] = [];
    const visit = (item: unknown): void => {
        if (Array.isArray(item)) {
            for (const child of item) visit(child);
            return;
        }
        if (!isRecord(item)) return;

        if (
            typeof item.targetLink === "string" ||
            typeof item.url === "string"
        ) {
            references.push(item as ChatHubReference);
        }
        for (const child of Object.values(item)) visit(child);
    };
    visit(value);
    return references;
}

function collectSuggestions(messages: ChatMessage[]): SuggestedResponse[] {
    const suggestions: SuggestedResponse[] = [];
    for (const message of messages) {
        const value = message.suggestedResponses;
        if (!Array.isArray(value)) continue;
        suggestions.push(...value.filter(isRecord) as SuggestedResponse[]);
    }
    return suggestions;
}

/**
 * True when a message carries genuine answer text rather than the reasoning
 * transcript or a status/progress frame. ChatHub marks the multi-step
 * chain-of-thought with contentOrigin=ChainOfThoughtSummary / addToChainOfThought
 * and streams search/code/tool status as Progress frames; surfacing either as
 * the answer drops the real reply and leaks the thinking out as content.
 */
function isAnswerText(message: ChatMessage): boolean {
    const text = message.text;
    if (typeof text !== "string" || text.length === 0) return false;
    if (
        message.contentOrigin === "ChainOfThoughtSummary" ||
        (message as Record<string, unknown>).addToChainOfThought === true
    ) {
        return false;
    }
    if (message.messageType === "Progress") return false;
    const contentType = message.contentType;
    if (
        contentType === "SearchResults" || contentType === "Code" ||
        contentType === "ToolCall"
    ) {
        return false;
    }
    return true;
}

function latestText(messages: ChatMessage[]): string | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (isAnswerText(messages[index]!)) return messages[index]!.text;
    }
    return undefined;
}

/** True when a message is part of the chain-of-thought transcript. */
function isReasoningText(message: ChatMessage): boolean {
    const text = message.text;
    if (typeof text !== "string" || text.length === 0) return false;
    return message.contentOrigin === "ChainOfThoughtSummary" ||
        (message as Record<string, unknown>).addToChainOfThought === true;
}

/**
 * The frame's reasoning messages joined in order. ChatHub emits the multi-step
 * chain-of-thought as separate cards; concatenating them gives the transcript
 * so far, which grows monotonically across cumulative snapshot frames.
 */
function reasoningText(messages: ChatMessage[]): string | undefined {
    const parts: string[] = [];
    for (const message of messages) {
        if (isReasoningText(message)) parts.push(message.text as string);
    }
    return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * The per-turn quota table lives on the terminal StreamItem's `item.throttling`
 * (counters plus a per-capability `metering` map). Only present on that frame,
 * so this returns undefined for the streaming `update` frames.
 */
function throttlingOf(payload: unknown): ChatHubThrottling | undefined {
    if (!isRecord(payload)) return undefined;
    const throttling = payload.throttling;
    return isRecord(throttling) ? throttling as ChatHubThrottling : undefined;
}

/** Server-suggested conversation title on the StreamItem's `item.defaultChatName`. */
function chatNameOf(payload: unknown): string | undefined {
    if (!isRecord(payload)) return undefined;
    const name = payload.defaultChatName;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

export function normalizeFrame(raw: unknown): ChatHubEvent {
    if (!isRecord(raw)) {
        return {
            kind: "unknown",
            frame: {},
            raw,
        };
    }

    const frame = raw as SignalRFrame;
    const payload = frame.type === SignalRMessageType.StreamItem
        ? frame.item
        : frame.arguments;
    const messages = collectMessages(payload);
    const references = collectReferences(payload);
    const suggestions = collectSuggestions(messages);
    const common = {
        frame,
        raw,
        text: latestText(messages),
        reasoning: reasoningText(messages),
        throttling: throttlingOf(payload),
        chatName: chatNameOf(payload),
        messages: messages.length > 0 ? messages : undefined,
        references: references.length > 0 ? references : undefined,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
    };

    if (frame.type === SignalRMessageType.Ping) {
        return { kind: "ping", ...common };
    }
    if (
        frame.type === SignalRMessageType.Invocation &&
        frame.target === ChatHubTarget.Update
    ) {
        return { kind: "update", ...common };
    }
    if (frame.type === SignalRMessageType.StreamItem) {
        return { kind: "stream-item", ...common };
    }
    if (
        frame.type === SignalRMessageType.Completion &&
        frame.error !== undefined
    ) {
        return { kind: "error", error: frame.error, ...common };
    }
    if (frame.type === SignalRMessageType.Completion) {
        return { kind: "completion", ...common };
    }
    if (typeof frame.target === "string") {
        return { kind: "target", ...common };
    }
    return { kind: "unknown", ...common };
}

export function completionError(
    frame: SignalRFrame,
): ChatHubProtocolError | undefined {
    if (
        frame.type !== SignalRMessageType.Completion ||
        frame.error === undefined
    ) {
        return undefined;
    }
    const detail = typeof frame.error === "string"
        ? frame.error
        : JSON.stringify(frame.error);
    return new ChatHubProtocolError(
        `ChatHub invocation ${
            frame.invocationId ?? "unknown"
        } failed: ${detail}`,
        frame,
    );
}

export class ChatHubTextAccumulator {
    #text = "";

    get text(): string {
        return this.#text;
    }

    update(candidate: string | undefined): string {
        if (!candidate) return "";
        if (candidate.startsWith(this.#text)) {
            const delta = candidate.slice(this.#text.length);
            this.#text = candidate;
            return delta;
        }
        if (this.#text.endsWith(candidate)) return "";
        this.#text += candidate;
        return candidate;
    }

    finalize(authoritative: string | undefined): string {
        if (authoritative !== undefined) this.#text = authoritative;
        return this.#text;
    }
}
