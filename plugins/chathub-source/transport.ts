import type {
    CanonicalError,
    GenerationRequest,
    InferenceSource,
    OperationRequest,
    ResolvedSourceProxy,
    SourceCapability,
    SourceContext,
    StreamEvent,
    StreamFrame,
} from "@heimdall/contracts";
import {
    type ChatHubSourceConfig,
    type ChatHubSourceOptions,
    validateChatHubSourceConfig,
} from "./config.ts";
import { decodeJwtClaims, refreshAccessToken } from "./auth.ts";
import {
    SourceProxyError,
    SourceTransport,
} from "../../packages/source-sdk/mod.ts";
import {
    ChatHubClient,
    type ChatHubEvent,
    type ChatHubSessionIds,
    ChatHubTextAccumulator,
    ChatHubTimeoutError,
    type ChatHubUrlOptions,
    createSessionIds,
    nextChatSessionId,
} from "./protocol/mod.ts";
import { conversationMessages, generationPayload } from "./request.ts";
import {
    flattenConversation,
    modelToolRouterPrompt,
    parseModelToolDecision,
    toneForModel,
    withMemoryOff,
} from "./tools.ts";

interface Session {
    ids: ChatHubSessionIds;
    history: string;
    length: number;
    expiresAt: number;
    busy: boolean;
}

export class ChatHubSource implements InferenceSource {
    readonly id: string;
    readonly capabilities: readonly SourceCapability[];
    #config: ChatHubSourceConfig;
    readonly #options: ChatHubSourceOptions;
    #refreshing?: Promise<void>;
    readonly #sessions = new Map<string, Session>();

    constructor(input: unknown, options: ChatHubSourceOptions = {}) {
        this.#config = validateChatHubSourceConfig(input);
        this.id = this.#config.id;
        this.#options = options;
        this.capabilities = [{
            operation: "generation.create",
            models: this.#config.models,
            streaming: true,
            features: ["tools"],
        }];
    }

    async #credentials(
        signal: AbortSignal,
        selection: ResolvedSourceProxy | undefined,
    ): Promise<ChatHubSourceConfig> {
        signal.throwIfAborted();
        const config = this.#config;
        const expiry = config.expiresAt
            ? Date.parse(config.expiresAt)
            : Number(decodeJwtClaims(config.accessToken).exp) * 1000;
        if (
            config.refreshToken && Number.isFinite(expiry) &&
            expiry <= Date.now() + 60_000
        ) {
            this.#refreshing ??= (async () => {
                // One caller cancelling must not abort renewal needed by other callers.
                const refreshSignal = AbortSignal.timeout(20_000);
                await using transport = new SourceTransport({
                    getProxy: selection === undefined
                        ? undefined
                        : () => selection,
                    signal: refreshSignal,
                    client: this.#options.httpClient,
                    fetch: this.#options.fetch,
                    secrets: [config.accessToken, config.refreshToken],
                });
                const renewed =
                    await (this.#options.refresh ?? refreshAccessToken)(
                        config.refreshToken!,
                        refreshSignal,
                        transport.fetch,
                        (message) => transport.redact(message),
                    );
                if (!renewed.ok) {
                    throw new Error(transport.redact(renewed.error));
                }
                if (renewed.oid !== config.oid || renewed.tid !== config.tid) {
                    throw new Error(
                        "ChatHub token renewal returned a different account",
                    );
                }
                const next = validateChatHubSourceConfig({
                    ...config,
                    accessToken: renewed.accessToken,
                    refreshToken: renewed.refreshToken || config.refreshToken,
                    accountEmail: renewed.email || config.accountEmail,
                    expiresAt: renewed.expiresAt,
                });
                await this.#options.onConfigUpdate?.(next, config);
                this.#config = next;
            })().finally(() => {
                this.#refreshing = undefined;
            });
            await waitFor(this.#refreshing, signal);
        }
        signal.throwIfAborted();
        return this.#config;
    }

    async *execute(
        input: OperationRequest,
        context: SourceContext,
    ): AsyncIterable<StreamFrame> {
        const streamId = "chathub:" + crypto.randomUUID();
        let seq = 0;
        const emit = (event: StreamEvent): StreamFrame => ({
            version: 1,
            streamId,
            requestId: input.requestId,
            seq: ++seq,
            eventId: streamId + ":" + seq,
            timestamp: new Date().toISOString(),
            event,
        });
        yield emit({ kind: "run.started", request: input });
        const abort = new AbortController();
        const signal = AbortSignal.any([context.signal, abort.signal]);
        let selected: Session | undefined;
        let transport: SourceTransport | undefined;
        try {
            transport = new SourceTransport({
                getProxy: this.#options.getProxy,
                client: this.#options.httpClient,
                fetch: this.#options.fetch,
                signal,
                secrets: [this.#config.accessToken, this.#config.refreshToken],
            });
            const client = new ChatHubClient({
                ...this.#options,
                webSocketFactory: this.#options.webSocketFactory
                    ? (url) =>
                        this.#options.webSocketFactory!(
                            url,
                            this.#options.getProxy
                                ? undefined
                                : this.#options.httpClient,
                        )
                    : (url) => transport!.webSocket(url),
            });
            const request = generationPayload(input);
            const model = request.model ?? this.#config.models[0];
            if (!this.#config.models.includes(model!)) {
                throw new TypeError("ChatHub model is not configured");
            }
            const config = await this.#credentials(signal, transport.selection);
            const messages = conversationMessages(request);
            const fullText = flattenConversation(messages);
            if (!fullText) {
                throw new TypeError(
                    "ChatHub requires a non-empty text conversation",
                );
            }
            const makeConnection = (
                ids = createSessionIds(),
            ): ChatHubUrlOptions => ({
                oid: config.oid,
                tid: config.tid,
                accessToken: config.accessToken,
                endpoint: config.endpoint,
                licenseType: config.licenseType,
                scenario: config.scenario,
                // Session-level memory block: no personalization memory or
                // custom instructions are read or written for this turn.
                disableMemory: true,
                ...ids,
            });
            const upstream = (text: string) => ({
                text,
                tone: toneForModel(model),
                locale: config.locale ?? "en-us",
                timezone: config.timezone ?? "UTC",
                licenseType: config.licenseType,
                scenario: config.scenario,
            });
            const messageId = streamId + ":message";
            const tools = request.tools?.map((tool) => ({
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                },
            })) ?? [];
            if (tools.length && request.toolChoice !== "none") {
                const choice = typeof request.toolChoice === "object"
                    ? {
                        type: "function",
                        function: { name: request.toolChoice.name },
                    }
                    : request.toolChoice;
                const result = await client.chat(
                    makeConnection(),
                    upstream(modelToolRouterPrompt(fullText, tools, choice)),
                    { signal },
                );
                const decision = parseModelToolDecision(
                    result.finalText ?? result.text,
                    tools,
                    choice,
                );
                if (
                    !decision.parsed ||
                    (!decision.calls.length &&
                        (request.toolChoice === "required" ||
                            typeof request.toolChoice === "object"))
                ) {
                    throw new Error(
                        "ChatHub returned an invalid tool routing decision",
                    );
                }
                if (decision.calls.length) {
                    yield emit({
                        kind: "message.started",
                        message: {
                            id: messageId,
                            role: "assistant",
                            parts: [],
                            status: "in_progress",
                        },
                    });
                    for (const call of decision.calls) {
                        const partId = messageId + ":" + call.id;
                        yield emit({
                            kind: "part.started",
                            messageId,
                            part: {
                                id: partId,
                                type: "tool_call",
                                callId: call.id,
                                name: call.name,
                                argumentsText: "",
                                status: "in_progress",
                            },
                        });
                        yield emit({
                            kind: "part.delta",
                            messageId,
                            partId,
                            delta: call.arguments,
                        });
                        yield emit({
                            kind: "part.completed",
                            messageId,
                            partId,
                        });
                    }
                    yield emit({
                        kind: "message.completed",
                        messageId,
                        finishReason: "tool_calls",
                    });
                    yield emit({
                        kind: "run.completed",
                        finishReason: "tool_calls",
                    });
                    return;
                }
            }
            const key = sessionKey(request);
            for (const [id, session] of this.#sessions) {
                if (session.expiresAt <= Date.now()) this.#sessions.delete(id);
            }
            const existing = key ? this.#sessions.get(key) : undefined;
            const reuse = existing && !existing.busy &&
                messages.length > existing.length &&
                JSON.stringify(messages.slice(0, existing.length)) ===
                    existing.history;
            selected = reuse ? existing : undefined;
            if (selected) selected.busy = true;
            const ids = selected
                ? nextChatSessionId(selected.ids)
                : createSessionIds();
            const prompt = flattenConversation(
                selected ? messages.slice(selected.length) : messages,
            );
            yield emit({
                kind: "message.started",
                message: {
                    id: messageId,
                    role: "assistant",
                    parts: [],
                    status: "in_progress",
                },
            });
            const text = new ChatHubTextAccumulator();
            const reasoning = new ChatHubTextAccumulator();
            const started = new Set<string>();
            const queue: ChatHubEvent[] = [];
            let wake: (() => void) | undefined;
            let settled = false;
            let failure: unknown;
            let answer = "";
            const run = client.chat(
                makeConnection(ids),
                upstream(withMemoryOff(prompt)),
                {
                    signal,
                    onEvent(event) {
                        queue.push(event);
                        wake?.();
                    },
                },
            ).then((result) => {
                answer = result.finalText ?? result.text;
                queue.push({
                    kind: "completion",
                    frame: {},
                    raw: null,
                    text: answer,
                    reasoning: result.reasoning,
                });
            }).catch((error) => {
                failure = error;
            }).finally(() => {
                settled = true;
                wake?.();
            });
            try {
                while (!settled || queue.length) {
                    if (!queue.length) {
                        await new Promise<void>((resolve) => {
                            wake = resolve;
                        });
                        wake = undefined;
                    }
                    while (queue.length) {
                        const event = queue.shift()!;
                        for (
                            const [kind, delta] of [[
                                "reasoning",
                                reasoning.update(event.reasoning),
                            ], ["text", text.update(event.text)]] as const
                        ) {
                            if (!delta) continue;
                            const partId = messageId + ":" + kind;
                            if (!started.has(kind)) {
                                started.add(kind);
                                yield emit({
                                    kind: "part.started",
                                    messageId,
                                    part: kind === "text"
                                        ? { id: partId, type: "text", text: "" }
                                        : {
                                            id: partId,
                                            type: "reasoning",
                                            text: "",
                                            visibility: "private",
                                        },
                                });
                            }
                            yield emit({
                                kind: "part.delta",
                                messageId,
                                partId,
                                delta,
                            });
                        }
                    }
                }
                if (failure) throw failure;
                signal.throwIfAborted();
            } finally {
                if (!settled) abort.abort();
                await run;
            }
            for (const kind of started) {
                yield emit({
                    kind: "part.completed",
                    messageId,
                    partId: messageId + ":" + kind,
                });
            }
            if (key) {
                if (this.#sessions.size >= 128) {
                    this.#sessions.delete(this.#sessions.keys().next().value!);
                }
                const history = [...messages, {
                    role: "assistant",
                    content: answer,
                }];
                this.#sessions.set(key, {
                    ids,
                    history: JSON.stringify(history),
                    length: history.length,
                    expiresAt: Date.now() + 3_600_000,
                    busy: false,
                });
            }
            yield emit({
                kind: "message.completed",
                messageId,
                finishReason: "stop",
            });
            yield emit({ kind: "run.completed", finishReason: "stop" });
        } catch (error) {
            if (
                signal.aborted ||
                (error instanceof Error && error.name === "AbortError")
            ) {
                yield emit({
                    kind: "run.cancelled",
                    reason: "request aborted",
                });
            } else {
                yield emit({
                    kind: "run.error",
                    error: canonicalError(error, this.#config, transport),
                });
            }
        } finally {
            abort.abort();
            await transport?.close();
            if (selected) selected.busy = false;
        }
    }
}

export function createChatHubSource(
    config: unknown,
    options?: ChatHubSourceOptions,
): ChatHubSource {
    return new ChatHubSource(config, options);
}

function sessionKey(request: GenerationRequest): string | undefined {
    const key = request.metadata?.conversationId ??
        request.metadata?.conversation_id;
    return typeof key === "string" && key.length <= 256 && key.trim()
        ? key
        : undefined;
}

function canonicalError(
    error: unknown,
    config: ChatHubSourceConfig,
    transport?: SourceTransport,
): CanonicalError {
    if (error instanceof SourceProxyError) {
        return {
            code: error.code,
            message: error.message,
            retryable: false,
            status: 503,
        };
    }
    let message = error instanceof Error
        ? error.message
        : "ChatHub request failed";
    for (const secret of [config.accessToken, config.refreshToken]) {
        if (secret) {
            message = message.replaceAll(secret, "[redacted]").replaceAll(
                encodeURIComponent(secret),
                "[redacted]",
            );
        }
    }
    // Redact before truncation: a cut credential would no longer match the
    // complete secret and could expose its prefix in the operator response.
    message = transport?.redact(message) ?? message;
    const invalid = error instanceof TypeError;
    const timeout = error instanceof ChatHubTimeoutError;
    const throttled = /throttl|rate.?limit|quota|429/i.test(message);
    const auth = /unauthori|forbidden|invalid_grant|token|令牌|401|403/i.test(
        message,
    );
    return {
        code: invalid
            ? "invalid_request"
            : timeout
            ? "upstream_timeout"
            : throttled
            ? "rate_limited"
            : auth
            ? "upstream_auth_error"
            : "upstream_error",
        status: invalid ? 400 : timeout ? 504 : throttled ? 429 : 502,
        retryable: !invalid && !auth,
        message: message.slice(0, 512),
    };
}

async function waitFor<T>(
    promise: Promise<T>,
    signal: AbortSignal,
): Promise<T> {
    signal.throwIfAborted();
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
    });
    try {
        return await Promise.race([promise, cancelled]);
    } finally {
        signal.removeEventListener("abort", abort);
    }
}
