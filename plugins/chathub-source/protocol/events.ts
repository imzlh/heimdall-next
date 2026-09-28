import { ChatHubTarget, SignalRMessageType } from "./constants.ts";
import type {
    ChatHubEvent,
    ChatHubMeterError,
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

/**
 * The turn's citations, taken only from `references` dictionaries (both the
 * message-level and the argument-level ones), never from every url-bearing
 * object in the payload — search cards, image tiles and the like are not
 * citations, and scanning the whole tree is what bloated the source list. Each
 * dictionary is keyed by the id the inline `cite` markers point at (e.g.
 * `turn1search42`); that key is stamped onto the reference as `id` when it has
 * none, so the source can tie a marker to the exact reference it cites.
 */
function collectReferences(value: unknown): ChatHubReference[] {
    const references: ChatHubReference[] = [];
    const push = (key: string | undefined, ref: unknown): void => {
        if (
            !isRecord(ref) ||
            (typeof ref.targetLink !== "string" && typeof ref.url !== "string")
        ) return;
        references.push(
            key !== undefined && typeof ref.id !== "string"
                ? { ...ref, id: key } as ChatHubReference
                : ref as ChatHubReference,
        );
    };
    const visit = (item: unknown): void => {
        if (Array.isArray(item)) {
            for (const child of item) visit(child);
            return;
        }
        if (!isRecord(item)) return;
        const refs = item.references;
        if (isRecord(refs)) {
            for (const [key, ref] of Object.entries(refs)) push(key, ref);
        } else if (Array.isArray(refs)) {
            for (const ref of refs) push(undefined, ref);
        }
        for (const child of Object.values(item)) visit(child);
    };
    visit(value);
    return references;
}

/**
 * Cloud search queries the model ran, from `message.searchQueries` and from
 * dedicated SearchQuery/InternalSearchQuery status messages. Surfaced as a
 * one-line status so the wait before the first answer token is explainable.
 */
function collectSearchQueries(messages: ChatMessage[]): string[] {
    const queries: string[] = [];
    const add = (value: unknown): void => {
        if (typeof value !== "string") return;
        const query = value.trim();
        if (query.length > 0 && !queries.includes(query)) queries.push(query);
    };
    for (const message of messages) {
        if (Array.isArray(message.searchQueries)) {
            for (const query of message.searchQueries) add(query);
        }
        if (
            message.messageType === "SearchQuery" ||
            message.messageType === "InternalSearchQuery"
        ) {
            add(message.text);
        }
    }
    return queries;
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
 * Generated-image URLs from `contentGenerationProgressList[].ImageReferenceUrls`.
 * Copilot fills these on later update frames of an image-generation turn; the
 * source downloads them to bytes. Only https image references are kept.
 */
function collectImageUrls(messages: ChatMessage[]): string[] {
    const urls: string[] = [];
    for (const message of messages) {
        const list = message.contentGenerationProgressList;
        if (!Array.isArray(list)) continue;
        for (const progress of list) {
            const refs = progress?.ImageReferenceUrls;
            if (!Array.isArray(refs)) continue;
            for (const ref of refs) {
                if (typeof ref === "string" && ref.startsWith("https://")) {
                    urls.push(ref);
                }
            }
        }
    }
    return urls;
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

/**
 * Copilot wraps inline citation markers in private-use control characters, e.g.
 * `citeturn1search42`. Left in place they render as tofu boxes
 * and keep the marker from being recognized. Dropping the U+E200–U+E20F control
 * block collapses each run to the contiguous `citeturn1search42` form the chat
 * renderer turns into a badge, while the references travel as citation parts.
 */
function normalizeCitations(text: string): string {
    return text.replace(/[\u{e200}-\u{e20f}]/gu, "");
}

function latestText(messages: ChatMessage[]): string | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (isAnswerText(messages[index]!)) {
            return normalizeCitations(messages[index]!.text as string);
        }
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
    return parts.length > 0
        ? normalizeCitations(parts.join("\n\n"))
        : undefined;
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

/** Terminal turn state (e.g. "Completed"/"Failed") on the StreamItem's `item`. */
function turnStateOf(payload: unknown): string | undefined {
    if (!isRecord(payload)) return undefined;
    const state = payload.turnState;
    return typeof state === "string" && state.trim() ? state.trim() : undefined;
}

/**
 * The StreamItem's `item.result`: `value` (e.g. "Success"), the authoritative
 * `message` text fallback, and the reliable `meteringInformation[]` access
 * signals. ChatHub reports soft-rejects here — HTTP/WS stay 200 and `value` is
 * still "Success" while a `meteringInformation` entry carries `hasAccess:false`
 * (copilot2api docs 07 §1.1) — so callers must inspect it, not just the status.
 */
function resultOf(payload: unknown): {
    value?: string;
    message?: string;
    meteringInformation?: ChatHubMeterError[];
} | undefined {
    if (!isRecord(payload)) return undefined;
    const result = payload.result;
    if (!isRecord(result)) return undefined;
    const value = typeof result.value === "string" ? result.value : undefined;
    const message = typeof result.message === "string" && result.message.trim()
        ? result.message
        : undefined;
    const meteringInformation = Array.isArray(result.meteringInformation)
        ? result.meteringInformation.filter(isRecord) as ChatHubMeterError[]
        : undefined;
    if (
        value === undefined && message === undefined &&
        meteringInformation === undefined
    ) return undefined;
    return {
        ...(value !== undefined ? { value } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(meteringInformation && meteringInformation.length > 0
            ? { meteringInformation }
            : {}),
    };
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
    const images = collectImageUrls(messages);
    const searchQueries = collectSearchQueries(messages);
    const result = resultOf(payload);
    const common = {
        frame,
        raw,
        text: latestText(messages),
        reasoning: reasoningText(messages),
        throttling: throttlingOf(payload),
        chatName: chatNameOf(payload),
        turnState: turnStateOf(payload),
        resultValue: result?.value,
        resultMessage: result?.message,
        meteringInformation: result?.meteringInformation,
        messages: messages.length > 0 ? messages : undefined,
        references: references.length > 0 ? references : undefined,
        searchQueries: searchQueries.length > 0 ? searchQueries : undefined,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        images: images.length > 0 ? images : undefined,
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
        // ChatHub streams the reply on two redundant channels (see
        // protocol/README and copilot2api docs 05 §3): the DeepLeo `messages[].text`
        // snapshot channel is a cumulative, strictly prefix-monotonic full text,
        // while writeAtCursor re-sends the same reply as append fragments. Only a
        // candidate that extends the accumulated text advances it, and we emit
        // just the new tail. Anything else — a writeAtCursor fragment, a
        // stale/shorter snapshot, or a divergent rewrite — is dropped, never
        // appended: concatenating the two channels double-counts the answer (the
        // bug that made the reply repeat itself mid-stream). A later snapshot and
        // the authoritative finalize still carry the canonical text.
        if (
            candidate.length <= this.#text.length ||
            !candidate.startsWith(this.#text)
        ) {
            return "";
        }
        const delta = candidate.slice(this.#text.length);
        this.#text = candidate;
        return delta;
    }

    finalize(authoritative: string | undefined): string {
        if (authoritative !== undefined) this.#text = authoritative;
        return this.#text;
    }
}
