import type {
    CanonicalError,
    GenerationRequest,
    InferenceSource,
    JsonObject,
    OperationRequest,
    ResolvedSourceProxy,
    SourceCapability,
    SourceContext,
    StreamEvent,
    StreamFrame,
} from "@heimdall/contracts";
import {
    buildChatHubQuota,
    chatHubAccountSnapshot,
    type ChatHubQuota,
    redactChatHubAccount,
} from "./account.ts";
import {
    type ChatHubSourceConfig,
    type ChatHubSourceOptions,
    validateChatHubSourceConfig,
} from "./config.ts";
import { decodeJwtClaims, refreshAccessToken } from "./auth.ts";
import { SourceProxyError, SourceTransport } from "@heimdall/source-sdk/mod.ts";
import { estimateTokens } from "@heimdall/tokens";
import {
    ChatHubClient,
    type ChatHubEvent,
    type ChatHubReference,
    type ChatHubSessionIds,
    ChatHubTextAccumulator,
    ChatHubTimeoutError,
    ChatHubTransportError,
    type ChatHubUrlOptions,
    createSessionIds,
    type MessageAnnotation,
    nextChatSessionId,
    resumeChatHubSession,
} from "./protocol/mod.ts";
import {
    conversationMessages,
    generationPayload,
    reasoningEffortOf,
} from "./request.ts";
import {
    collectImages,
    downloadGeneratedImages,
    uploadImages,
} from "./images.ts";
import {
    ChatHubContentFilterError,
    flattenConversation,
    isContentPolicyBlock,
    modelToolRouterPrompt,
    parseModelToolDecision,
    toneForModel,
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
    #quota?: ChatHubQuota;
    #quotaUpdatedAt?: string;
    readonly #sessions = new Map<string, Session>();

    constructor(input: unknown, options: ChatHubSourceOptions = {}) {
        this.#config = validateChatHubSourceConfig(input);
        this.id = this.#config.id;
        this.#options = options;
        this.capabilities = [{
            operation: "generation.create",
            models: this.#config.models,
            streaming: true,
            features: ["tools", "image.input"],
        }];
    }

    uiSnapshot(): JsonObject {
        const label = this.#config.accountEmail
            ? redactChatHubAccount(this.#config.accountEmail, this.#config)
            : undefined;
        const now = this.#sessionTime();
        let warmContexts = 0;
        let busyContexts = 0;
        for (const session of this.#sessions.values()) {
            if (session.expiresAt <= now) continue;
            if (session.busy) busyContexts++;
            else warmContexts++;
        }
        return {
            ...chatHubAccountSnapshot(label, this.#quota, this.#quotaUpdatedAt),
            runtime: { warmContexts, busyContexts },
        };
    }

    #sessionTime(): number {
        return (this.#options.clock?.() ?? new Date()).getTime();
    }

    #rememberQuota(quota: ChatHubQuota | undefined) {
        if (!quota) return;
        this.#quota = quota;
        this.#quotaUpdatedAt = (this.#options.clock?.() ?? new Date())
            .toISOString();
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
            const tone = toneForModel(model, reasoningEffortOf(request));
            const config = await this.#credentials(signal, transport.selection);
            const messages = conversationMessages(request);
            const fullText = flattenConversation(messages);
            const images = collectImages(request);
            if (!fullText && !images.length) {
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
                tone,
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
                this.#rememberQuota(
                    buildChatHubQuota(
                        result.throttling,
                        result.meteringInformation,
                        (text) =>
                            transport!.redact(
                                redactChatHubAccount(text, config),
                            ),
                    ),
                );
                const routerText = result.finalText ?? result.text;
                if (isContentPolicyBlock(routerText)) {
                    throw new ChatHubContentFilterError();
                }
                const decision = parseModelToolDecision(
                    routerText,
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
            const key = sessionKey(request, context);
            for (const [id, session] of this.#sessions) {
                if (session.expiresAt <= this.#sessionTime()) {
                    this.#sessions.delete(id);
                }
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
            // On a reused session ChatHub keeps the prior turns server-side, so
            // only `prompt` is sent fresh; the reused prefix is cached context.
            const cachedInputText = selected
                ? flattenConversation(messages.slice(0, selected.length))
                : "";
            // Upload any images for this turn now that the conversation id is
            // fixed; the returned annotations reference them on the chat frame.
            // Done here (past the tool-router early return) so a router-only
            // turn never uploads.
            let imageAnnotations: MessageAnnotation[] = [];
            if (images.length) {
                imageAnnotations = await uploadImages(
                    transport.fetch,
                    {
                        accessToken: config.accessToken,
                        conversationId: ids.conversationId,
                        scenario: config.scenario,
                        endpoint: config.endpoint,
                    },
                    images,
                    signal,
                );
            }
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
            let title = "";
            let reasoningText = "";
            let suggestions: string[] = [];
            let generatedImageUrls: string[] = [];
            let references: ChatHubReference[] = [];
            // Keep provider metering in the account snapshot; the inference
            // stream only receives generic usage and failure events.
            let quota: ChatHubQuota | undefined;
            let turnState = "";
            let resultValue = "";
            // Cloud search activity, surfaced live as status parts before the
            // first answer token so the wait is explained rather than blank.
            const searchSeen = new Set<string>();
            let statusCount = 0;
            // AttachToSession resume only makes sense once a turn has started
            // producing content; a bare connect failure has no session to
            // re-attach to and must surface as-is.
            let streamedContent = false;
            const onEvent = (event: ChatHubEvent): void => {
                if (event.text || event.reasoning) streamedContent = true;
                queue.push(event);
                wake?.();
            };
            const run = client.chat(
                makeConnection(ids),
                imageAnnotations.length
                    ? {
                        ...upstream(prompt),
                        messageAnnotations: imageAnnotations,
                    }
                    : upstream(prompt),
                { signal, onEvent },
            ).catch((error) => {
                // Long / reasoning turns are truncated by Copilot before the
                // type:3 Completion arrives (copilot2api SPEC 06 "长对话截断").
                // Resume the same session with AttachToSession (O4) instead of
                // failing: the turn-scoped text/reasoning accumulators are
                // prefix-monotonic, so the re-sent snapshot only streams its new
                // tail and never double-writes what already reached the client.
                if (
                    signal.aborted || !streamedContent ||
                    !(error instanceof ChatHubTransportError)
                ) {
                    throw error;
                }
                return resumeChatHubSession(client, makeConnection(ids), {
                    signal,
                    onEvent,
                    maxReconnectAttempts: 3,
                    reconnectDelayMs: 500,
                });
            }).then((result) => {
                answer = result.finalText ?? result.text;
                // The authoritative reply can arrive only on `item.result.message`
                // (no messages[] answer entry); fall back to it before treating
                // the turn as empty.
                if (!answer.trim() && result.resultMessage) {
                    answer = result.resultMessage;
                }
                title = result.chatName?.trim() ?? "";
                reasoningText = result.reasoning ?? "";
                generatedImageUrls = result.images ?? [];
                references = result.references ?? [];
                turnState = result.turnState ?? "";
                resultValue = result.resultValue ?? "";
                quota = buildChatHubQuota(
                    result.throttling,
                    result.meteringInformation,
                    (text) =>
                        transport!.redact(redactChatHubAccount(text, config)),
                );
                this.#rememberQuota(quota);
                // Each suggestion's clickable prompt is its commandText (the text
                // sent when tapped), falling back to the displayed text.
                suggestions = [
                    ...new Set(
                        (result.suggestions ?? [])
                            .map((item) =>
                                (item.commandText ?? item.text ?? "").trim()
                            )
                            .filter((value) => value.length > 0),
                    ),
                ];
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
                            // A content-policy refusal arrives as the whole
                            // answer in one shot. Catch it before any text is
                            // streamed so it surfaces as an error rather than a
                            // relayed reply; once real text has streamed, later
                            // text is a genuine answer, not a block.
                            if (
                                kind === "text" && !started.has("text") &&
                                isContentPolicyBlock(text.text)
                            ) {
                                throw new ChatHubContentFilterError();
                            }
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
                                            visibility: "public",
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
                        // Surface each new cloud search as a one-line status
                        // part. `summary` is the pre-rendered text so consumers
                        // that don't special-case status still show something;
                        // the structured value stays for richer clients.
                        for (const query of event.searchQueries ?? []) {
                            if (searchSeen.has(query)) continue;
                            searchSeen.add(query);
                            const partId =
                                `${messageId}:status:${statusCount++}`;
                            yield emit({
                                kind: "part.started",
                                messageId,
                                part: {
                                    id: partId,
                                    type: "custom",
                                    name: "status",
                                    value: {
                                        summary: `🔍 搜索：${query}`,
                                        kind: "search",
                                        query,
                                    },
                                },
                            });
                            yield emit({
                                kind: "part.completed",
                                messageId,
                                partId,
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
            // ChatHub reports failures in-band: the WS/HTTP status stays 200 and
            // a clean Completion arrives even when the turn produced nothing —
            // turnState="Failed", result.value!="Success", or a
            // meteringInformation soft-reject. Without answer text, images or
            // reasoning that is a silent blank reply, so surface it as an error
            // (a degraded turn that still returned text is a success, kept as-is).
            if (
                !answer.trim() && !generatedImageUrls.length &&
                !reasoningText.trim()
            ) {
                const denied = quota?.meters.find((meter) =>
                    meter.name === "access" && meter.blocked
                );
                if (denied) {
                    throw new Error(
                        `ChatHub denied the request (${
                            denied.error || "capability access denied"
                        }); the account's quota for this capability may be throttled or exhausted`,
                    );
                }
                if (turnState && turnState !== "Completed") {
                    throw new Error(
                        `ChatHub turn did not complete (turnState=${turnState})`,
                    );
                }
                if (resultValue && resultValue !== "Success") {
                    throw new Error(
                        `ChatHub turn failed (result=${resultValue})`,
                    );
                }
                throw new Error("ChatHub returned an empty response");
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
                    expiresAt: this.#sessionTime() + 3_600_000,
                    busy: false,
                });
            }
            // ChatHub reports no upstream token counts, so estimate them here
            // where the cache split is known: a reused session sends only the
            // incremental prompt, leaving the earlier turns as cached input.
            const inputTokens = estimateTokens(prompt);
            const cachedInputTokens = estimateTokens(cachedInputText);
            const outputTokens = estimateTokens(answer);
            const reasoningTokens = estimateTokens(reasoningText);
            const totalTokens = inputTokens + cachedInputTokens +
                outputTokens + reasoningTokens;
            if (totalTokens > 0) {
                yield emit({
                    kind: "usage",
                    usage: {
                        inputTokens,
                        outputTokens,
                        ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
                        ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
                        totalTokens,
                        extensions: { estimated: true },
                    },
                });
            }
            if (title) {
                yield emit({ kind: "title", title });
            }
            if (suggestions.length) {
                yield emit({ kind: "suggestions", suggestions });
            }
            // Copilot generates images inside the chat turn and returns their
            // URLs (not inline). Download to bytes here so the kernel receives a
            // buffer, then emit them as image parts on this assistant message.
            if (generatedImageUrls.length) {
                const generated = await downloadGeneratedImages(
                    transport.fetch,
                    generatedImageUrls,
                    signal,
                );
                for (const [index, image] of generated.entries()) {
                    const partId = `${messageId}:image:${index}`;
                    yield emit({
                        kind: "part.started",
                        messageId,
                        part: {
                            id: partId,
                            type: "image",
                            source: {
                                mediaType: image.mediaType,
                                bytes: image.data.byteLength,
                                data: image.data,
                            },
                        },
                    });
                    yield emit({ kind: "part.completed", messageId, partId });
                }
            }
            // Citations backing the answer. The inline `cite` markers name the
            // references the text actually uses, so resolve those in order and
            // emit one citation each — deduped — instead of dumping every
            // reference. When the answer carries no markers, fall back to the
            // collected references so a citation-free answer still keeps them.
            const referencesById = new Map<string, ChatHubReference>();
            for (const reference of references) {
                if (typeof reference.id === "string") {
                    referencesById.set(reference.id, reference);
                }
            }
            const citedIds = citedReferenceIds(answer);
            const cited = citedIds.length > 0
                ? citedIds
                    .map((id) => referencesById.get(id))
                    .filter((reference): reference is ChatHubReference =>
                        reference !== undefined
                    )
                : references;
            let citationIndex = 0;
            const emittedCitations = new Set<string>();
            for (const reference of cited) {
                const citation = citationOf(reference);
                if (citation === undefined) continue;
                const dedupe = citation.url ?? citation.label ?? "";
                if (dedupe === "" || emittedCitations.has(dedupe)) continue;
                emittedCitations.add(dedupe);
                const partId = `${messageId}:citation:${citationIndex++}`;
                yield emit({
                    kind: "part.started",
                    messageId,
                    part: {
                        id: partId,
                        type: "citation",
                        ...citation,
                        // The reference id is the marker the inline `cite`
                        // badges point at, so the answer can link to it.
                        ...(typeof reference.id === "string"
                            ? { ref: reference.id }
                            : {}),
                    },
                });
                yield emit({ kind: "part.completed", messageId, partId });
            }
            yield emit({
                kind: "message.completed",
                messageId,
                finishReason: "stop",
            });
            yield emit({ kind: "run.completed", finishReason: "stop" });
        } catch (error) {
            if (
                !(error instanceof ChatHubContentFilterError) &&
                (signal.aborted ||
                    (error instanceof Error && error.name === "AbortError"))
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

/**
 * The reference ids the answer cites, in first-appearance order and deduped.
 * Inline markers are `cite` followed by one or more `turn<round><verb><index>`
 * tokens (see the normalization in protocol/events.ts); each token is a key in
 * the reference dictionary.
 */
function citedReferenceIds(text: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const run of text.matchAll(/cite((?:turn\d+[a-z]+\d+)+)/g)) {
        for (const entry of run[1]!.matchAll(/turn\d+[a-z]+\d+/g)) {
            const id = entry[0];
            if (!seen.has(id)) {
                seen.add(id);
                ids.push(id);
            }
        }
    }
    return ids;
}

/**
 * Map a ChatHub reference onto a HIP citation. The label is the reference
 * title, falling back to the `Title` inside the double-encoded `displayData`
 * content; the url prefers `url` then `targetLink`. Returns undefined when the
 * reference carries neither a link nor a label worth showing.
 */
function citationOf(
    reference: ChatHubReference,
): { label?: string; url?: string } | undefined {
    const url = typeof reference.url === "string" && reference.url.trim()
        ? reference.url
        : typeof reference.targetLink === "string" &&
                reference.targetLink.trim()
        ? reference.targetLink
        : undefined;
    let label = typeof reference.title === "string" && reference.title.trim()
        ? reference.title.trim()
        : undefined;
    if (label === undefined) {
        const content = reference.displayData?.content;
        if (typeof content === "string") {
            try {
                const parsed = JSON.parse(content) as Record<string, unknown>;
                const title = parsed.Title ?? parsed.title;
                if (typeof title === "string" && title.trim()) {
                    label = title.trim();
                }
            } catch {
                // A non-JSON content string just leaves the label empty.
            }
        }
    }
    if (url === undefined && label === undefined) return undefined;
    return {
        ...(label !== undefined ? { label } : {}),
        ...(url !== undefined ? { url } : {}),
    };
}

function sessionKey(
    request: GenerationRequest,
    context: SourceContext,
): string | undefined {
    // A title is a separate prompt, not a continuation. It must not replace
    // the warm conversation cached for the user's next turn.
    if (
        (context.metadata.purpose ?? request.metadata?.purpose) === "chat.title"
    ) return undefined;
    // The kernel resolves one conversation identity for both routing affinity
    // and session reuse: an explicit id when the protocol carries one (from the
    // request envelope or payload, so ChatHub's conversation extension still
    // works), otherwise a value derived from the conversation's opening so a
    // stateless API's turns (OpenAI, Anthropic) still reuse a warm session.
    // Trust it here rather than re-deriving a key of our own.
    return context.conversationId;
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
    if (error instanceof ChatHubContentFilterError) {
        // The same input trips the same filter, so retrying this account is
        // pointless; a different account may still answer.
        return {
            code: "content_filter",
            message: error.message,
            retryable: false,
            status: 422,
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
