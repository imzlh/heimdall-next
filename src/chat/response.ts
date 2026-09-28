import type { ContentPart, StreamEvent } from "@heimdall/hip";
import type { ToolInvocation } from "@heimdall/contracts";

export type ChatToolCall = ToolInvocation;

/** A generated image emitted by the model, ready to persist as an attachment. */
export interface ChatResponseImage {
    readonly mediaType: string;
    readonly data: Uint8Array;
}

/** A one-line cloud-activity status (search, etc.) surfaced with the reply. */
export interface ChatResponseActivity {
    readonly summary: string;
}

/** A source the reply cited. */
export interface ChatResponseCitation {
    readonly label?: string;
    readonly url?: string;
    readonly ref?: string;
}

/** One capability's remaining allowance, shown in the account quota card. */
export interface ChatResponseQuotaMeter {
    readonly name: string;
    readonly remaining?: number;
    readonly blocked?: boolean;
    readonly error?: string;
}

/** Per-turn account quota snapshot carried on the usage event's extensions. */
export interface ChatResponseQuota {
    readonly meters: readonly ChatResponseQuotaMeter[];
}

/** Keep provider reasoning and tool arguments out of the visible chat reply. */
export class ChatResponse {
    text = "";
    #title = "";
    #suggestions: string[] = [];
    #reasoning = "";
    #quota: ChatResponseQuota | undefined;
    readonly #images: ChatResponseImage[] = [];
    readonly #activity: ChatResponseActivity[] = [];
    readonly #citations: ChatResponseCitation[] = [];
    readonly #parts = new Map<string, ContentPart>();
    readonly #calls = new Map<string, ChatToolCall>();

    get toolCalls(): ChatToolCall[] {
        return [...this.#calls.values()];
    }

    /** Provider-generated images (e.g. Copilot in-chat image generation). */
    get images(): readonly ChatResponseImage[] {
        return this.#images;
    }

    /** Public reasoning transcript, "" when none was streamed. */
    get reasoning(): string {
        return this.#reasoning;
    }

    /** Cloud-activity status lines streamed during the turn. */
    get activity(): readonly ChatResponseActivity[] {
        return this.#activity;
    }

    /** Sources the reply cited, empty when none were streamed. */
    get citations(): readonly ChatResponseCitation[] {
        return this.#citations;
    }

    /** Per-turn account quota snapshot, or undefined when none was reported. */
    get quota(): ChatResponseQuota | undefined {
        return this.#quota;
    }

    /** Provider-suggested conversation title, or "" when none was streamed. */
    get title(): string {
        return this.#title;
    }

    /** Provider-suggested follow-up prompts, empty when none were streamed. */
    get suggestions(): readonly string[] {
        return this.#suggestions;
    }

    append(event: StreamEvent): string {
        let delta = "";
        if (event.kind === "title") {
            if (event.title.trim().length > 0) this.#title = event.title.trim();
        } else if (event.kind === "suggestions") {
            this.#suggestions = event.suggestions.filter((item) =>
                item.trim().length > 0
            );
        } else if (event.kind === "part.started") {
            this.#parts.set(
                partKey(event.messageId, event.part.id),
                event.part,
            );
            if (event.part.type === "text" || event.part.type === "refusal") {
                delta = event.part.text;
            } else if (event.part.type === "tool_call") {
                this.#calls.set(event.part.callId, {
                    callId: event.part.callId,
                    name: event.part.name,
                    argumentsText: event.part.argumentsText,
                });
            } else if (
                event.part.type === "image" && event.part.source.data
            ) {
                this.#images.push({
                    mediaType: event.part.source.mediaType,
                    data: event.part.source.data,
                });
            } else if (
                event.part.type === "reasoning" &&
                event.part.visibility === "public"
            ) {
                // Public reasoning is shown, but never mixed into the answer.
                this.#reasoning += event.part.text;
            } else if (
                event.part.type === "custom" && event.part.name === "status"
            ) {
                const summary = statusSummary(event.part.value);
                if (summary) this.#activity.push({ summary });
            } else if (event.part.type === "citation") {
                this.#citations.push({
                    ...(event.part.label !== undefined
                        ? { label: event.part.label }
                        : {}),
                    ...(event.part.url !== undefined
                        ? { url: event.part.url }
                        : {}),
                    ...(event.part.ref !== undefined
                        ? { ref: event.part.ref }
                        : {}),
                });
            }
        } else if (
            event.kind === "part.delta" && typeof event.delta === "string"
        ) {
            const part = this.#parts.get(
                partKey(event.messageId, event.partId),
            );
            if (part?.type === "tool_call") {
                const call = this.#calls.get(part.callId)!;
                this.#calls.set(part.callId, {
                    ...call,
                    argumentsText: call.argumentsText + event.delta,
                });
            } else if (
                part?.type === "reasoning" && part.visibility === "public"
            ) {
                this.#reasoning += event.delta;
            } else if (
                part === undefined || part.type === "text" ||
                part.type === "refusal"
            ) {
                // Legacy sources can emit plain text deltas without announcing
                // a part. Announced non-text parts never use this fallback.
                delta = event.delta;
            }
        } else if (event.kind === "tool.call") {
            const previous = this.#calls.get(event.callId);
            this.#calls.set(event.callId, {
                callId: event.callId,
                name: event.name,
                argumentsText: event.argumentsText ??
                    (event.arguments === undefined
                        ? previous?.argumentsText ?? ""
                        : JSON.stringify(event.arguments)),
            });
        } else if (event.kind === "usage") {
            // The account quota snapshot rides on the usage event's extensions
            // (a HIP-native channel, not a chat-only bypass); surface it so the
            // reply can show the remaining message/image allowance.
            const quota = readQuota(event.usage.extensions?.quota);
            if (quota) this.#quota = quota;
        }
        this.text += delta;
        return delta;
    }
}

function partKey(messageId: string, partId: string): string {
    return JSON.stringify([messageId, partId]);
}

/** Pull the pre-rendered one-line text off a `status` custom part's value. */
function statusSummary(value: unknown): string | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const summary = (value as { summary?: unknown }).summary;
    return typeof summary === "string" && summary.trim().length > 0
        ? summary.trim()
        : undefined;
}

/** Validate the quota object carried on `usage.extensions.quota`. */
function readQuota(value: unknown): ChatResponseQuota | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const meters = (value as { meters?: unknown }).meters;
    if (!Array.isArray(meters)) return undefined;
    const parsed: ChatResponseQuotaMeter[] = [];
    for (const entry of meters) {
        if (typeof entry !== "object" || entry === null) continue;
        const meter = entry as Record<string, unknown>;
        if (typeof meter.name !== "string" || meter.name.length === 0) continue;
        parsed.push({
            name: meter.name,
            ...(typeof meter.remaining === "number"
                ? { remaining: meter.remaining }
                : {}),
            ...(meter.blocked === true ? { blocked: true } : {}),
            ...(typeof meter.error === "string" ? { error: meter.error } : {}),
        });
    }
    return parsed.length > 0 ? { meters: parsed } : undefined;
}
