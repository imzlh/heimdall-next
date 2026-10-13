import type {
    BlobRef,
    ContentPart,
    GenerationRequest,
    OperationRequest,
} from "@heimdall/contracts";
import { flattenConversation } from "./tools.ts";

export function generationPayload(input: OperationRequest): GenerationRequest {
    if (
        input.operation !== "generation.create" ||
        !("messages" in input.payload)
    ) {
        throw new TypeError("ChatHub supports generation.create only");
    }
    const request = input.payload;
    if (request.responseFormat && request.responseFormat !== "text") {
        throw new TypeError("ChatHub does not guarantee structured output");
    }
    for (const message of request.messages) {
        for (const part of message.parts) {
            if (
                ![
                    "text",
                    "reasoning",
                    "tool_call",
                    "tool_result",
                    "json",
                    "refusal",
                    "image",
                ].includes(part.type)
            ) {
                throw new TypeError(
                    "ChatHub currently supports text, image and tool messages only",
                );
            }
        }
    }
    return {
        ...request,
        ...(input.traits.model === undefined
            ? {}
            : { model: input.traits.model }),
    };
}

export function conversationMessages(
    request: GenerationRequest,
): Record<string, unknown>[] {
    const messages: Record<string, unknown>[] = [];
    if (request.instructions) {
        messages.push({ role: "system", content: request.instructions });
    }
    const callNames = new Map<string, string>();
    for (const message of request.messages) {
        let text: string[] = [];
        let calls: unknown[] = [];
        const flush = () => {
            if (text.length || calls.length) {
                messages.push({
                    role: message.role,
                    content: text.join("\n"),
                    ...(calls.length ? { tool_calls: calls } : {}),
                });
                text = [];
                calls = [];
            }
        };
        for (const part of message.parts) {
            if (part.type === "text" || part.type === "refusal") {
                if (calls.length) flush();
                text.push(part.text);
            }
            if (part.type === "json") {
                if (calls.length) flush();
                text.push(part.text ?? JSON.stringify(part.value ?? null));
            }
            if (part.type === "tool_call") {
                callNames.set(part.callId, part.name);
                calls.push({
                    id: part.callId,
                    type: "function",
                    function: {
                        name: part.name,
                        arguments: part.argumentsText,
                    },
                });
            }
            if (part.type === "tool_result") {
                flush();
                const name = callNames.get(part.callId);
                const content = part.parts?.map(resultPartText).filter(Boolean)
                    .join("\n");
                const images = part.parts?.flatMap((item) =>
                    item.type === "image" ? [item.source] : []
                ) ?? [];
                messages.push({
                    role: "tool",
                    tool_call_id: part.callId,
                    ...(name ? { name } : {}),
                    is_error: part.isError === true || part.error !== undefined,
                    ...(images.length ? { images } : {}),
                    content: content ||
                        JSON.stringify(part.result ?? part.error ?? null),
                });
            }
            if (part.type === "image") {
                flush();
                const available = message.role === "user" &&
                    (part.source.data || part.source.uri?.startsWith("data:"));
                messages.push({
                    role: message.role,
                    content: available
                        ? `[image attachment: ${part.source.mediaType}; use only when its pixels are available]`
                        : `[unavailable image: ${part.source.mediaType}; pixels were not uploaded]`,
                    image: part.source,
                });
            }
        }
        flush();
    }
    return messages;
}

function resultPartText(part: ContentPart): string {
    if (part.type === "text" || part.type === "refusal") return part.text;
    if (part.type === "json") {
        return part.text ?? JSON.stringify(part.value ?? null);
    }
    if (part.type === "image") {
        return `[unavailable tool image: ${part.source.mediaType}; pixels were not uploaded]`;
    }
    return "";
}

/** Hash retained history rather than keeping another full copy in each session. */
export async function conversationHistoryHash(
    messages: Record<string, unknown>[],
): Promise<string> {
    const normalized = await Promise.all(messages.map(async (message) => {
        const image = message.image as BlobRef | undefined;
        const images = message.images as BlobRef[] | undefined;
        if (!image && !images) return message;
        return {
            ...message,
            ...(image ? { image: await imageIdentity(image) } : {}),
            ...(images
                ? { images: await Promise.all(images.map(imageIdentity)) }
                : {}),
        };
    }));
    return digest(new TextEncoder().encode(JSON.stringify(normalized)));
}

async function imageIdentity(image: BlobRef): Promise<unknown> {
    return {
        mediaType: image.mediaType,
        ...(image.data
            ? { digest: await digest(image.data) }
            : { uri: image.uri }),
    };
}

async function digest(bytes: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
    return Array.from(
        new Uint8Array(hash),
        (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
}

export function conversationText(request: GenerationRequest): string {
    return flattenConversation(conversationMessages(request));
}

export type ReasoningEffort =
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";

/** Accept the Chat Completions and Responses spellings, with a bounded vocabulary. */
export function reasoningEffortOf(
    request: GenerationRequest,
): ReasoningEffort | undefined {
    const raw = (request.extensions as Record<string, unknown> | undefined)
        ?.raw as Record<string, unknown> | undefined;
    const reasoning = raw?.reasoning as Record<string, unknown> | undefined;
    for (const value of [raw?.reasoning_effort, reasoning?.effort]) {
        if (typeof value !== "string") continue;
        const effort = value.trim().toLowerCase();
        switch (effort) {
            case "none":
            case "minimal":
            case "low":
            case "medium":
            case "high":
            case "xhigh":
            case "max":
                return effort;
        }
    }
    return undefined;
}
