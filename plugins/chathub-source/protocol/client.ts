import { SignalRMessageType } from "./constants.ts";
import { encodeRecord, encodeRecords, SignalRRecordDecoder } from "./codec.ts";
import {
    ChatHubTextAccumulator,
    completionError,
    normalizeFrame,
} from "./events.ts";
import {
    createAttachToSessionFrame,
    createChatFrame,
    createHandshakeRequest,
    createPingFrame,
    createRequestMetricsFrame,
} from "./frames.ts";
import { buildChatHubUrl } from "./url.ts";
import type {
    AttachOptions,
    ChatCallOptions,
    ChatHubClientOptions,
    ChatHubEvent,
    ChatHubReference,
    ChatHubRequest,
    ChatHubResult,
    ChatHubThrottling,
    ChatHubUrlOptions,
    ReceivedTokenMetrics,
    SignalRFrame,
    SuggestedResponse,
    WebSocketLike,
} from "./types.ts";

const OPEN = 1;

export class ChatHubTransportError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ChatHubTransportError";
    }
}

export class ChatHubTimeoutError extends ChatHubTransportError {
    constructor(message: string) {
        super(message);
        this.name = "ChatHubTimeoutError";
    }
}

export class ChatHubAbortError extends ChatHubTransportError {
    constructor() {
        super("ChatHub operation was aborted");
        this.name = "AbortError";
    }
}

interface RunOptions extends ChatCallOptions {
    initialPayload: string;
}

function eventError(event: Event, fallback: string): Error {
    if (event instanceof ErrorEvent && event.error instanceof Error) {
        return event.error;
    }
    return new ChatHubTransportError(fallback);
}

function messageText(event: Event): string | undefined {
    if (!(event instanceof MessageEvent)) return undefined;
    return typeof event.data === "string" ? event.data : undefined;
}

function uniqueByJson<T>(items: T[]): T[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export class ChatHubClient {
    readonly #factory: (url: string) => WebSocketLike;
    readonly #connectTimeoutMs: number;
    readonly #handshakeTimeoutMs: number;
    readonly #idleTimeoutMs: number;
    readonly #clock: () => Date;

    constructor(options: ChatHubClientOptions = {}) {
        this.#factory = options.webSocketFactory ??
            ((url) => new WebSocket(url));
        this.#connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
        this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000;
        this.#idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
        this.#clock = options.clock ?? (() => new Date());
    }

    async chat(
        connection: ChatHubUrlOptions,
        request: ChatHubRequest,
        options: ChatCallOptions = {},
    ): Promise<ChatHubResult> {
        const now = this.#clock().toISOString();
        const chat = createChatFrame(request, {
            sessionId: connection.sessionId,
            conversationId: connection.conversationId,
            chatSessionId: connection.chatSessionId,
            clientRequestId: connection.clientRequestId,
            clock: this.#clock,
        });
        const metrics = createRequestMetricsFrame({
            ConnectionStart: now,
            UserInputStart: now,
            ConnectionEstablished: now,
            UserInputSubmit: now,
            RequestSent: now,
        });

        return await this.#run(buildChatHubUrl(connection), {
            ...options,
            initialPayload: encodeRecord(createPingFrame()) +
                encodeRecords([chat, metrics]),
        });
    }

    async attach(
        connection: ChatHubUrlOptions,
        options: AttachOptions = {},
    ): Promise<ChatHubResult> {
        return await this.#run(buildChatHubUrl(connection), {
            ...options,
            initialPayload: encodeRecords([
                createPingFrame(),
                createAttachToSessionFrame(connection.chatSessionId),
            ]),
        });
    }

    async #run(url: string, options: RunOptions): Promise<ChatHubResult> {
        if (options.signal?.aborted) throw new ChatHubAbortError();

        const socket = this.#factory(url);
        const decoder = new SignalRRecordDecoder();
        const accumulator = new ChatHubTextAccumulator();
        const reasoningAccumulator = new ChatHubTextAccumulator();
        const events: ChatHubEvent[] = [];
        const references: ChatHubReference[] = [];
        const suggestions: SuggestedResponse[] = [];
        const timings: number[] = [];
        let handshakeComplete = false;
        let connectTimer: ReturnType<typeof setTimeout> | undefined;
        let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        let responsesSent = 0;
        let lastReceivedAt: Date | undefined;
        let finalText: string | undefined;
        let throttling: ChatHubThrottling | undefined;
        let chatName: string | undefined;

        const recordTiming = (): void => {
            const now = this.#clock();
            if (lastReceivedAt !== undefined) {
                timings.push(now.getTime() - lastReceivedAt.getTime());
            }
            lastReceivedAt = now;
        };

        const receivedTokenMetricsResult = ():
            | ReceivedTokenMetrics
            | undefined => {
            if (timings.length === 0) return undefined;
            const sorted = [...timings].sort((a, b) => a - b);
            const mean = timings.reduce((a, b) => a + b, 0) / timings.length;
            const variance = timings.reduce(
                (acc, value) => acc + (value - mean) ** 2,
                0,
            ) / timings.length;
            const max = sorted[sorted.length - 1] ?? 0;
            const min = sorted[0] ?? 0;
            return {
                TokenCount: responsesSent,
                CharCount: accumulator.text.length,
                TimeBetweenTokens: {
                    Mean: mean,
                    Median: sorted[Math.floor(sorted.length / 2)] ?? 0,
                    Sd: Math.sqrt(variance),
                    Variance: variance,
                    Max: max,
                    Min: min,
                },
                AverageChunkSize: responsesSent > 0
                    ? accumulator.text.length / responsesSent
                    : 0,
                BurstRate: 0,
                StallRate: 0,
            };
        };

        return await new Promise<ChatHubResult>((resolve, reject) => {
            const clearTimers = (): void => {
                if (connectTimer !== undefined) clearTimeout(connectTimer);
                if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
                if (idleTimer !== undefined) clearTimeout(idleTimer);
            };

            const cleanup = (): void => {
                clearTimers();
                socket.removeEventListener("open", onOpen);
                socket.removeEventListener("message", onMessage);
                socket.removeEventListener("error", onError);
                socket.removeEventListener("close", onClose);
                options.signal?.removeEventListener("abort", onAbort);
            };

            const finishReject = (error: unknown): void => {
                if (settled) return;
                settled = true;
                cleanup();
                if (socket.readyState === OPEN) {
                    socket.close(1000, "operation failed");
                }
                reject(error);
            };

            const finishResolve = (completion: SignalRFrame): void => {
                if (settled) return;
                settled = true;
                cleanup();
                if (socket.readyState === OPEN) socket.close(1000, "complete");
                resolve({
                    text: accumulator.text,
                    events,
                    references: uniqueByJson(references),
                    suggestions: uniqueByJson(suggestions),
                    completion,
                    finalText: finalText,
                    reasoning: reasoningAccumulator.text || undefined,
                    throttling,
                    chatName,
                    receivedTokenMetrics: receivedTokenMetricsResult(),
                });
            };

            const resetIdleTimer = (): void => {
                if (idleTimer !== undefined) clearTimeout(idleTimer);
                idleTimer = setTimeout(
                    () =>
                        finishReject(
                            new ChatHubTimeoutError("ChatHub receive timeout"),
                        ),
                    this.#idleTimeoutMs,
                );
            };

            const publish = async (event: ChatHubEvent): Promise<void> => {
                events.push(event);
                if (event.references && event.references.length > 0) {
                    references.push(...event.references);
                }
                if (event.suggestions && event.suggestions.length > 0) {
                    suggestions.push(...event.suggestions);
                }
                responsesSent++;
                recordTiming();
                if (event.kind === "stream-item") {
                    finalText = event.text;
                    accumulator.finalize(event.text);
                } else {
                    accumulator.update(event.text);
                }
                if (event.reasoning) {
                    reasoningAccumulator.update(event.reasoning);
                }
                if (event.throttling) throttling = event.throttling;
                if (event.chatName) chatName = event.chatName;
                await options.onEvent?.(event);
            };

            const handleRecord = async (raw: unknown): Promise<void> => {
                if (!handshakeComplete) {
                    if (
                        typeof raw !== "object" || raw === null ||
                        Array.isArray(raw)
                    ) {
                        throw new ChatHubTransportError(
                            "Invalid SignalR handshake response",
                        );
                    }
                    const error = (raw as { error?: unknown }).error;
                    if (error !== undefined) {
                        throw new ChatHubTransportError(
                            `SignalR handshake failed: ${String(error)}`,
                        );
                    }
                    handshakeComplete = true;
                    if (handshakeTimer !== undefined) {
                        clearTimeout(handshakeTimer);
                    }
                    socket.send(options.initialPayload);
                    resetIdleTimer();
                    return;
                }

                const event = normalizeFrame(raw);
                await publish(event);
                const frame = event.frame;
                const protocolError = completionError(frame);
                if (protocolError) throw protocolError;
                if (frame.type === SignalRMessageType.Completion) {
                    finishResolve(frame);
                }
            };

            const onOpen = (): void => {
                if (connectTimer !== undefined) clearTimeout(connectTimer);
                socket.send(encodeRecord(createHandshakeRequest()));
                handshakeTimer = setTimeout(
                    () =>
                        finishReject(
                            new ChatHubTimeoutError(
                                "SignalR handshake timeout",
                            ),
                        ),
                    this.#handshakeTimeoutMs,
                );
            };

            const onMessage = (event: Event): void => {
                const chunk = messageText(event);
                if (chunk === undefined) {
                    finishReject(
                        new ChatHubTransportError("ChatHub sent non-text data"),
                    );
                    return;
                }
                resetIdleTimer();
                try {
                    const records = decoder.push(chunk);
                    void (async () => {
                        for (const record of records) {
                            await handleRecord(record);
                        }
                    })().catch(finishReject);
                } catch (error) {
                    finishReject(error);
                }
            };

            const onError = (event: Event): void => {
                finishReject(eventError(event, "ChatHub WebSocket error"));
            };

            const onClose = (): void => {
                if (!settled) {
                    finishReject(
                        new ChatHubTransportError(
                            "ChatHub WebSocket closed before completion",
                        ),
                    );
                }
            };

            const onAbort = (): void => finishReject(new ChatHubAbortError());

            socket.addEventListener("open", onOpen);
            socket.addEventListener("message", onMessage);
            socket.addEventListener("error", onError);
            socket.addEventListener("close", onClose);
            options.signal?.addEventListener("abort", onAbort, { once: true });

            connectTimer = setTimeout(
                () =>
                    finishReject(
                        new ChatHubTimeoutError("ChatHub connection timeout"),
                    ),
                this.#connectTimeoutMs,
            );
        });
    }
}
