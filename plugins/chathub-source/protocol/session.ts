import type {
    AttachOptions,
    ChatHubResult,
    ChatHubSessionIds,
    ChatHubUrlOptions,
} from "./types.ts";
import {
    ChatHubAbortError,
    ChatHubClient,
    ChatHubTransportError,
} from "./client.ts";

export interface SessionIdFactory {
    randomUUID(): string;
}

export interface ResumeOptions extends AttachOptions {
    maxReconnectAttempts?: number;
    reconnectDelayMs?: number;
}

export function createSessionIds(
    factory: SessionIdFactory = crypto,
): ChatHubSessionIds {
    return {
        sessionId: factory.randomUUID(),
        conversationId: factory.randomUUID(),
        chatSessionId: factory.randomUUID(),
    };
}

export function nextChatSessionId(
    ids: ChatHubSessionIds,
    factory: SessionIdFactory = crypto,
): ChatHubSessionIds {
    return {
        ...ids,
        chatSessionId: factory.randomUUID(),
    };
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new ChatHubAbortError());

    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(new ChatHubAbortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export async function resumeChatHubSession(
    client: ChatHubClient,
    connection: ChatHubUrlOptions,
    options: ResumeOptions = {},
): Promise<ChatHubResult> {
    const maxAttempts = Math.max(1, options.maxReconnectAttempts ?? 1);
    const delayMs = Math.max(0, options.reconnectDelayMs ?? 500);
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await client.attach(connection, options);
        } catch (error) {
            lastError = error;
            if (options.signal?.aborted) throw new ChatHubAbortError();
            if (!(error instanceof ChatHubTransportError)) throw error;
            if (attempt + 1 < maxAttempts) {
                await abortableDelay(delayMs * (attempt + 1), options.signal);
            }
        }
    }

    throw lastError;
}
