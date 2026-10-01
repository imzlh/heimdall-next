import type {
    InferenceSource,
    SourceCapability,
    SourceContext,
    SourceProbeResult,
} from "../contracts/mod.ts";
import {
    type CanonicalError,
    HIP_VERSION,
    type OperationRequest,
    type StreamFrame,
    validateOperationRequest,
    validateStreamFrame,
} from "../hip/mod.ts";
import { attemptSource, sameSourceRetry } from "./failover.ts";
import type { SourceRouter } from "./mod.ts";
import {
    type SourceCooldown,
    type SourceCooldownReason,
    type SourceHealthCheck,
    SourceHealthOrder,
    type SourceHealthSnapshot,
    upstreamCooldownReason,
} from "./source-health.ts";

/** No configured source can satisfy an operation's advertised traits. */
export class SourceUnavailableError extends Error {
    override readonly name = "SourceUnavailableError";

    constructor(
        readonly operation: string,
        readonly model?: string,
    ) {
        super(
            `no source can serve operation ${operation}${
                model === undefined ? "" : ` with model ${model}`
            }`,
        );
    }
}

/** A source emitted a frame that violates the HIP stream boundary. */
export class FrameValidationError extends TypeError {
    override readonly name = "FrameValidationError";
}

export interface DiscoveredModel {
    readonly id: string;
    readonly sourceId: string;
}

export interface FrameValidationOptions {
    /** Require a run.started event as the first frame. Defaults to true. */
    readonly requireStarted?: boolean;
    /** Require a terminal run event when the iterable naturally completes. */
    readonly requireTerminal?: boolean;
    /** Stop waiting for source frames when the execution is cancelled. */
    readonly signal?: AbortSignal;
}

export interface SourceRegistryOptions {
    readonly now?: () => Date;
    /** Distinct sources tried for one request. Defaults to 3. */
    readonly maxAttempts?: number;
    /** Tries of one source for a 5xx before failover. Defaults to 3. */
    readonly sameSourceAttempts?: number;
    /** Cooldown after a failover-eligible upstream failure. Defaults to 30s. */
    readonly cooldownMs?: number;
    /** Cooldown after an upstream 401 or 403. Defaults to 5 minutes. */
    readonly authCooldownMs?: number;
    /**
     * How long a conversation prefers the source that last served it, so a
     * source's own context cache (e.g. ChatHub sessions) can be reused. Best
     * effort: the preference only breaks ties among ready, equal-priority
     * peers and is dropped when that source is cooling. Defaults to 1 hour;
     * 0 disables affinity.
     */
    readonly conversationAffinityMs?: number;
}

/**
 * Single-tenant source registry. Lower capability priorities are preferred;
 * equal-priority sources are selected in process-local round-robin order.
 *
 * `run` retries a 5xx on the same source, then fails over before any output
 * frame is committed. Authentication failures cool that source down but stay
 * on the current request.
 */
export class SourceRegistry implements SourceRouter {
    #sources = new Map<string, InferenceSource>();
    #cursor = new Map<string, number>();
    #cooldowns = new Map<string, SourceCooldown>();
    #healthChecks = new Map<string, SourceHealthOrder>();
    #probes = new Map<string, {
        ok: boolean;
        checkedAt: string;
        message: string;
    }>();
    #discovered = new Map<string, readonly string[]>();
    /** conversationId → the source that last served it, with an expiry. */
    #affinity = new Map<string, { sourceId: string; expiresAt: number }>();
    readonly #now: () => Date;
    readonly #maxAttempts: number;
    readonly #sameSourceAttempts: number;
    readonly #cooldownMs: number;
    readonly #authCooldownMs: number;
    readonly #affinityMs: number;

    constructor(options: SourceRegistryOptions = {}) {
        if (
            options.maxAttempts !== undefined &&
            (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1)
        ) {
            throw new TypeError("maxAttempts must be a positive integer");
        }
        if (
            options.sameSourceAttempts !== undefined &&
            (!Number.isInteger(options.sameSourceAttempts) ||
                options.sameSourceAttempts < 1)
        ) {
            throw new TypeError(
                "sameSourceAttempts must be a positive integer",
            );
        }
        if (
            options.conversationAffinityMs !== undefined &&
            (!Number.isFinite(options.conversationAffinityMs) ||
                options.conversationAffinityMs < 0)
        ) {
            throw new TypeError(
                "conversationAffinityMs must be a non-negative number",
            );
        }
        for (
            const [name, duration] of [["cooldownMs", options.cooldownMs], [
                "authCooldownMs",
                options.authCooldownMs,
            ]] as const
        ) {
            if (
                duration !== undefined &&
                (!Number.isSafeInteger(duration) || duration < 0 ||
                    duration > 86_400_000)
            ) {
                throw new TypeError(
                    `${name} must be an integer from 0 to 86400000`,
                );
            }
        }
        this.#now = options.now ?? (() => new Date());
        this.#maxAttempts = options.maxAttempts ?? 3;
        this.#sameSourceAttempts = options.sameSourceAttempts ?? 3;
        this.#cooldownMs = options.cooldownMs ?? 30_000;
        this.#authCooldownMs = options.authCooldownMs ?? 300_000;
        this.#affinityMs = options.conversationAffinityMs ?? 3_600_000;
    }

    register(source: InferenceSource): void {
        validateSource(source);
        if (this.#sources.has(source.id)) {
            throw new TypeError(`source already registered: ${source.id}`);
        }
        this.#sources.set(source.id, source);
        this.#healthChecks.set(source.id, new SourceHealthOrder());
    }

    replace(
        source: InferenceSource,
        options: {
            readonly preserveDiscovery?: boolean;
            readonly discoveredModels?: readonly string[];
        } = {},
    ): void {
        validateSource(source);
        if (!this.#sources.has(source.id)) {
            throw new TypeError(`source is not registered: ${source.id}`);
        }
        this.#sources.set(source.id, source);
        this.#healthChecks.set(source.id, new SourceHealthOrder());
        this.#cursor.clear();
        if (!options.preserveDiscovery) {
            this.#discovered.delete(source.id);
            this.#probes.delete(source.id);
            this.#cooldowns.delete(source.id);
            this.#forgetAffinity(source.id);
        }
        if (options.discoveredModels !== undefined) {
            this.#discovered.set(
                source.id,
                sanitizeModelIds(options.discoveredModels),
            );
        }
    }

    upsert(
        source: InferenceSource,
        options: {
            readonly preserveDiscovery?: boolean;
            readonly discoveredModels?: readonly string[];
        } = {},
    ): void {
        if (this.#sources.has(source.id)) this.replace(source, options);
        else this.register(source);
    }

    unregister(id: string): boolean {
        this.#probes.delete(id);
        this.#discovered.delete(id);
        this.#cooldowns.delete(id);
        this.#healthChecks.delete(id);
        this.#forgetAffinity(id);
        return this.#sources.delete(id);
    }

    get(id: string): InferenceSource | undefined {
        return this.#sources.get(id);
    }

    list(): readonly InferenceSource[] {
        return [...this.#sources.values()];
    }

    listModels(): readonly DiscoveredModel[] {
        const models = new Map<string, DiscoveredModel>();
        for (const source of this.#sources.values()) {
            for (const capability of source.capabilities) {
                for (const id of capability.models ?? []) {
                    rememberModel(models, id, source.id);
                }
            }
            for (const id of this.#discovered.get(source.id) ?? []) {
                rememberModel(models, id, source.id);
            }
        }
        return [...models.values()].sort((left, right) =>
            left.id.localeCompare(right.id)
        );
    }

    healthOf(id: string): "ready" | "cooldown" {
        return this.#cooled(id) ? "cooldown" : "ready";
    }

    healthSnapshot(id: string): SourceHealthSnapshot {
        this.#requireKnown(id);
        return this.#cooled(id)
            ? { health: "cooldown", cooldown: { ...this.#cooldowns.get(id)! } }
            : { health: "ready" };
    }

    /** Only completed newer checks supersede older results; pending traffic does not. */
    beginHealthCheck(id: string): SourceHealthCheck {
        this.#requireKnown(id);
        return this.#healthChecks.get(id)!.begin();
    }

    /** Re-enter routing without fabricating a successful probe. */
    clearCooldown(id: string): SourceHealthSnapshot {
        this.#requireKnown(id);
        this.#healthChecks.set(id, new SourceHealthOrder());
        this.#cooldowns.delete(id);
        return this.healthSnapshot(id);
    }

    /**
     * Record an operator probe for a registered source. Success clears a failover
     * cooldown. Failure applies the same cooldown as an upstream failover.
     * Unknown source ids throw. This does not call the source.
     */
    recordProbe(
        id: string,
        result: SourceProbeResult,
        token?: SourceHealthCheck,
    ): boolean {
        const check = token ?? this.beginHealthCheck(id);
        if (!this.#healthChecks.get(id)?.accept(check)) return false;
        this.#probes.set(id, {
            ok: result.ok,
            checkedAt: this.#now().toISOString(),
            message: result.message,
        });
        if (result.ok) {
            this.#cooldowns.delete(id);
            if (result.models !== undefined) {
                this.#discovered.set(id, sanitizeModelIds(result.models));
            }
        } else this.#cool(id, this.#cooldownMs, "probe");
        return true;
    }

    /** Model ids learned from a successful probe. These do not restrict routing. */
    discoveredModels(id: string): readonly string[] {
        this.#requireKnown(id);
        return this.#discovered.get(id) ?? [];
    }

    /** Last recorded probe for a registered source, if the operator has run one. */
    probeOf(
        id: string,
    ): { ok: boolean; checkedAt: string; message: string } | undefined {
        this.#requireKnown(id);
        return this.#probes.get(id);
    }

    select(request: OperationRequest): InferenceSource {
        const candidates = this.#supporting(request);
        if (candidates.length === 0) {
            throw new SourceUnavailableError(
                request.operation,
                request.traits.model,
            );
        }
        const ready = candidates.filter((source) => !this.#cooled(source.id));
        const pool = ready.length > 0 ? ready : candidates;

        const bestPriority = Math.min(
            ...pool.map((source) =>
                capabilityPriority(source, request.operation)
            ),
        );
        const peers = pool.filter((source) =>
            capabilityPriority(source, request.operation) === bestPriority
        );
        const sticky = this.#affinitySource(request, peers);
        if (sticky) return sticky;
        const cursorKey = selectionKey(request);
        const cursor = this.#cursor.get(cursorKey) ?? 0;
        const selected = peers[cursor % peers.length]!;
        this.#cursor.set(cursorKey, (cursor + 1) % peers.length);
        return selected;
    }

    /**
     * The source this conversation last committed to, when it is still one of
     * the ready, equal-priority `peers`. Affinity only breaks ties this way, so
     * it never routes to a worse-priority or cooling source; a stale or expired
     * hint is dropped. Returns undefined when affinity is off or misses.
     */
    #affinitySource(
        request: OperationRequest,
        peers: readonly InferenceSource[],
    ): InferenceSource | undefined {
        if (this.#affinityMs === 0) return undefined;
        const conversation = conversationIdentity(request);
        if (conversation === undefined) return undefined;
        const remembered = this.#affinity.get(conversation);
        if (remembered === undefined) return undefined;
        if (remembered.expiresAt <= this.#now().getTime()) {
            this.#affinity.delete(conversation);
            return undefined;
        }
        return peers.find((source) => source.id === remembered.sourceId);
    }

    /**
     * Remember the source that served a conversation so its next turn prefers
     * the same source (and thus the same warm upstream session). Bounded and
     * time-boxed; only conversations that carry an id are tracked.
     */
    #rememberAffinity(
        request: OperationRequest,
        source: InferenceSource,
    ): void {
        if (this.#affinityMs === 0 || this.#sources.get(source.id) !== source) {
            return;
        }
        const conversation = conversationIdentity(request);
        if (conversation === undefined) return;
        if (this.#affinity.size >= 4096 && !this.#affinity.has(conversation)) {
            this.#affinity.delete(this.#affinity.keys().next().value!);
        }
        this.#affinity.set(conversation, {
            sourceId: source.id,
            expiresAt: this.#now().getTime() + this.#affinityMs,
        });
    }

    #forgetAffinity(id: string): void {
        for (const [conversation, remembered] of this.#affinity) {
            if (remembered.sourceId === id) this.#affinity.delete(conversation);
        }
    }

    run(
        request: OperationRequest,
        context: SourceContext,
    ): AsyncIterable<StreamFrame> {
        validateOperationRequest(request);
        return this.#run(request, context);
    }

    async *#run(
        request: OperationRequest,
        context: SourceContext,
    ): AsyncIterable<StreamFrame> {
        context.signal.throwIfAborted();
        const attempts = this.#attempts(request);
        // Resolve the conversation identity once and hand it to every source
        // attempt, so a stateful source keys its warm session on the same value
        // the kernel uses for routing affinity instead of deriving its own.
        const conversation = conversationIdentity(request);
        const sourceContext: SourceContext = conversation === undefined
            ? context
            : { ...context, conversationId: conversation };
        let lastError: CanonicalError | undefined;
        for (const source of attempts) {
            if (this.#sources.get(source.id) !== source) continue;
            const healthCheck = this.beginHealthCheck(source.id);
            for (
                let tryIndex = 0;
                tryIndex < this.#sameSourceAttempts;
                tryIndex++
            ) {
                context.signal.throwIfAborted();
                // The routing snapshot may outlive an operator change while
                // another attempt is pending. Never start a stale instance.
                if (this.#sources.get(source.id) !== source) break;
                let committed = false;
                try {
                    const outcome = yield* attemptSource(
                        validateFrames(
                            source.execute(request, sourceContext),
                            request.requestId,
                            { signal: context.signal },
                        ),
                        () => {
                            committed = true;
                        },
                    );
                    context.signal.throwIfAborted();
                    if (outcome.kind === "failover") {
                        lastError = outcome.error;
                        if (
                            tryIndex + 1 < this.#sameSourceAttempts &&
                            sameSourceRetry(outcome.error)
                        ) continue;
                        const reason = upstreamCooldownReason(
                            outcome.error.status,
                        );
                        this.#recordAttemptHealth(source, healthCheck, reason);
                        break;
                    }
                    if (outcome.kind === "stop") {
                        if (committed) this.#rememberAffinity(request, source);
                        if (outcome.cooldown === "auth") {
                            this.#recordAttemptHealth(
                                source,
                                healthCheck,
                                "authentication",
                            );
                        }
                        return;
                    }
                    this.#recordAttemptHealth(source, healthCheck);
                    if (committed) this.#rememberAffinity(request, source);
                    return;
                } catch (error) {
                    context.signal.throwIfAborted();
                    // Retrying after any visible frame can duplicate model/tool
                    // output and mix independent stream ids in one execution.
                    if (committed || error instanceof FrameValidationError) {
                        throw error;
                    }
                    lastError = {
                        code: "upstream_error",
                        message: error instanceof Error
                            ? error.message
                            : "source failed before producing output",
                        retryable: true,
                        status: 503,
                    };
                    if (tryIndex + 1 < this.#sameSourceAttempts) continue;
                    this.#recordAttemptHealth(source, healthCheck, "transport");
                }
            }
        }
        if (lastError === undefined) {
            throw new SourceUnavailableError(
                request.operation,
                request.traits.model,
            );
        }
        yield* terminalFailure(request, lastError, this.#now());
    }

    #attempts(request: OperationRequest): readonly InferenceSource[] {
        const primary = this.select(request);
        const rest = this.#supporting(request)
            .filter((source) =>
                source.id !== primary.id && !this.#cooled(source.id)
            )
            .sort((left, right) => {
                const priority = capabilityPriority(left, request.operation) -
                    capabilityPriority(right, request.operation);
                if (priority !== 0) return priority;
                return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
            });
        return [primary, ...rest].slice(0, this.#maxAttempts);
    }

    #supporting(request: OperationRequest): InferenceSource[] {
        return this.list().filter((source) =>
            source.capabilities.some((capability) =>
                supports(capability, request)
            )
        );
    }

    #cooled(id: string): boolean {
        const cooldown = this.#cooldowns.get(id);
        if (cooldown === undefined) return false;
        if (Date.parse(cooldown.until) <= this.#now().getTime()) {
            this.#cooldowns.delete(id);
            return false;
        }
        return true;
    }

    #cool(id: string, durationMs: number, reason: SourceCooldownReason): void {
        const now = this.#now();
        this.#cooldowns.set(id, {
            reason,
            startedAt: now.toISOString(),
            until: new Date(now.getTime() + durationMs).toISOString(),
        });
    }

    #recordAttemptHealth(
        source: InferenceSource,
        token: SourceHealthCheck,
        reason?: SourceCooldownReason,
    ): void {
        // An in-flight request may finish after its channel was replaced or
        // removed. Its result belongs to that instance, not the reused id.
        if (
            this.#sources.get(source.id) !== source ||
            !this.#healthChecks.get(source.id)?.accept(token)
        ) return;
        if (reason === undefined) {
            this.#cooldowns.delete(source.id);
            return;
        }
        this.#cool(
            source.id,
            reason === "authentication"
                ? this.#authCooldownMs
                : this.#cooldownMs,
            reason,
        );
    }

    #requireKnown(id: string): void {
        if (!this.#sources.has(id)) {
            throw new TypeError(`unknown source: ${id}`);
        }
    }
}

function terminalFailure(
    request: OperationRequest,
    error: CanonicalError,
    now: Date,
): readonly StreamFrame[] {
    const streamId = `failover:${request.requestId}`;
    const timestamp = now.toISOString();
    return [
        {
            version: 1,
            streamId,
            requestId: request.requestId,
            seq: 1,
            eventId: `${streamId}:1`,
            timestamp,
            event: { kind: "run.started", request },
        },
        {
            version: 1,
            streamId,
            requestId: request.requestId,
            seq: 2,
            eventId: `${streamId}:2`,
            timestamp,
            event: { kind: "run.error", error },
        },
    ];
}

/**
 * Validate provider output as it crosses into the kernel. The validator is
 * deliberately independent of a reducer so custom HIP events remain valid.
 */
export async function* validateFrames(
    frames: AsyncIterable<StreamFrame>,
    requestId: string,
    options: FrameValidationOptions = {},
): AsyncIterable<StreamFrame> {
    if (!isAsyncIterable(frames)) {
        throw new FrameValidationError(
            "source did not return an async frame stream",
        );
    }
    const requireStarted = options.requireStarted ?? true;
    const requireTerminal = options.requireTerminal ?? false;
    let streamId: string | undefined;
    let expectedSeq = 1;
    let sawStarted = false;
    let sawTerminal = false;
    const eventIds = new Set<string>();

    for await (const frame of interruptibleFrames(frames, options.signal)) {
        validateFrameShape(frame, requestId);
        if (streamId === undefined) streamId = frame.streamId;
        if (frame.streamId !== streamId) {
            throw new FrameValidationError(
                `stream changed from ${streamId} to ${frame.streamId}`,
            );
        }
        if (frame.seq !== expectedSeq) {
            throw new FrameValidationError(
                `expected sequence ${expectedSeq}, got ${frame.seq}`,
            );
        }
        expectedSeq++;
        if (eventIds.has(frame.eventId)) {
            throw new FrameValidationError(
                `duplicate event id: ${frame.eventId}`,
            );
        }
        eventIds.add(frame.eventId);
        if (!sawStarted) {
            if (frame.event.kind !== "run.started" && requireStarted) {
                throw new FrameValidationError(
                    "the first event must be run.started",
                );
            }
            sawStarted = frame.event.kind === "run.started";
        }
        if (sawTerminal) {
            throw new FrameValidationError(
                `cannot append ${frame.event.kind} after a terminal event`,
            );
        }
        if (isTerminalEvent(frame.event.kind)) sawTerminal = true;
        yield frame;
    }

    if (requireStarted && !sawStarted) {
        throw new FrameValidationError("stream did not start with run.started");
    }
    if (requireTerminal && !sawTerminal) {
        throw new FrameValidationError("stream ended before a terminal event");
    }
}

/**
 * A source is expected to observe its signal, but a pending next() must not keep
 * the kernel lifecycle open after cancellation. Closing that source is still
 * requested; an uncooperative iterator cannot block the cancelled caller.
 */
async function* interruptibleFrames(
    frames: AsyncIterable<StreamFrame>,
    signal: AbortSignal | undefined,
): AsyncIterable<StreamFrame> {
    if (signal === undefined) {
        yield* frames;
        return;
    }
    signal.throwIfAborted();
    const iterator = frames[Symbol.asyncIterator]();
    let ended = false;
    try {
        while (true) {
            const next = await withCancellation(() => iterator.next(), signal);
            signal.throwIfAborted();
            if (next.done) {
                ended = true;
                return;
            }
            yield next.value;
        }
    } finally {
        if (!ended && iterator.return !== undefined) {
            if (signal.aborted) {
                void Promise.resolve().then(() => iterator.return!()).catch(
                    () => {},
                );
            } else {
                await withCancellation(() => iterator.return!(), signal);
            }
        }
    }
}

/** One abort listener per pending read/close, released when either settles. */
async function withCancellation<T>(
    operation: () => T | PromiseLike<T>,
    signal: AbortSignal,
): Promise<T> {
    signal.throwIfAborted();
    let onAbort!: () => void;
    const pending = new Promise<T>((resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            Promise.resolve(operation()).then(resolve, reject);
        } catch (error) {
            reject(error);
        }
    });
    try {
        return await pending;
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}

function supports(
    capability: SourceCapability,
    request: OperationRequest,
): boolean {
    if (capability.operation !== request.operation) return false;
    if (request.traits.streaming === true && !capability.streaming) {
        return false;
    }
    if (
        capability.models !== undefined && request.traits.model !== undefined &&
        !capability.models.includes(request.traits.model)
    ) return false;
    const features = new Set(capability.features ?? []);
    return (request.traits.requiredCapabilities ?? []).every((feature) =>
        features.has(feature)
    );
}

function rememberModel(
    models: Map<string, DiscoveredModel>,
    id: string,
    sourceId: string,
): void {
    const trimmed = id.trim();
    if (trimmed.length === 0 || models.has(trimmed)) return;
    models.set(trimmed, { id: trimmed, sourceId });
}

function sanitizeModelIds(values: readonly string[]): readonly string[] {
    const ids = new Set<string>();
    for (const value of values) {
        if (typeof value !== "string") continue;
        const trimmed = value.trim();
        if (trimmed.length === 0 || trimmed.length > 200) continue;
        if (hasControlCharacter(trimmed)) continue;
        ids.add(trimmed);
        if (ids.size === 500) break;
    }
    return [...ids].sort();
}

function hasControlCharacter(value: string): boolean {
    for (const character of value) {
        const code = character.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
}

function capabilityPriority(
    source: InferenceSource,
    operation: string,
): number {
    return Math.min(
        ...source.capabilities
            .filter((capability) => capability.operation === operation)
            .map((capability) => capability.priority ?? 0),
    );
}

function selectionKey(request: OperationRequest): string {
    return `${request.operation}\0${request.traits.model ?? ""}`;
}

/**
 * A stable identifier for the conversation a request belongs to, used both for
 * routing affinity and to let a stateful source reuse a warm upstream session.
 *
 * An explicit id from request metadata wins. Otherwise, for a generation
 * request, one is derived from the conversation's opening — the value stays
 * constant as later turns are appended, so every turn of one conversation
 * resolves to the same identity. Stateless protocols (OpenAI, Anthropic) carry
 * no id, so without this their turns would scatter across sources and never
 * reuse a cached session.
 */
function conversationIdentity(request: OperationRequest): string | undefined {
    const explicit = explicitConversationId(request);
    if (explicit !== undefined) return `id:${explicit}`;
    const anchor = conversationAnchor(request);
    return anchor === undefined ? undefined : `anchor:${anchor}`;
}

/** An id the protocol supplied, from the request envelope or its payload. */
function explicitConversationId(request: OperationRequest): string | undefined {
    const payload = request.payload as { metadata?: unknown };
    for (const source of [request.metadata, payload.metadata]) {
        const metadata = source as Record<string, unknown> | undefined;
        const value = metadata?.conversationId ?? metadata?.conversation_id;
        if (
            typeof value === "string" && value.trim().length > 0 &&
            value.length <= 256
        ) {
            return value;
        }
    }
    return undefined;
}

/**
 * A digest of a generation request's opening: its instructions and the text of
 * the first message. These are the only parts guaranteed present in every turn
 * (later turns only append), so they anchor a conversation without an explicit
 * id. A weak collision costs at most a cache miss — a source verifies the full
 * message prefix before it reuses a session — never a wrong reuse.
 */
function conversationAnchor(request: OperationRequest): string | undefined {
    const payload = request.payload as {
        messages?: unknown;
        instructions?: unknown;
    };
    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
        return undefined;
    }
    const opening: string[] = [];
    if (typeof payload.instructions === "string") {
        opening.push(payload.instructions);
    }
    const parts = (payload.messages[0] as { parts?: unknown }).parts;
    if (Array.isArray(parts)) {
        for (const part of parts) {
            const text = (part as { text?: unknown }).text;
            if (typeof text === "string") opening.push(text);
        }
    }
    return opening.length === 0 ? undefined : hashText(opening.join("\u0000"));
}

/**
 * A fast, non-cryptographic digest of a string. Two 32-bit FNV-1a lanes give a
 * wide-enough key for conversation anchoring; it guards nothing, so a weak hash
 * is fine and keeps this off the request's hot path.
 */
function hashText(text: string): string {
    let low = 0x811c9dc5;
    let high = 0x811c9dc5 ^ 0x9e3779b9;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        low = Math.imul(low ^ (code & 0xff), 0x01000193);
        high = Math.imul(high ^ (code >>> 8), 0x01000193);
    }
    return (low >>> 0).toString(16).padStart(8, "0") +
        (high >>> 0).toString(16).padStart(8, "0");
}

function validateSource(source: InferenceSource): void {
    if (source === null || typeof source !== "object") {
        throw new TypeError("source must be an object");
    }
    if (typeof source.id !== "string" || source.id.trim().length === 0) {
        throw new TypeError("source id is required");
    }
    if (
        !Array.isArray(source.capabilities) || source.capabilities.length === 0
    ) {
        throw new TypeError(`source ${source.id} has no capabilities`);
    }
    if (typeof source.execute !== "function") {
        throw new TypeError(`source ${source.id} is missing execute()`);
    }
    for (const capability of source.capabilities) {
        if (
            capability === null || typeof capability !== "object" ||
            typeof capability.operation !== "string" ||
            capability.operation.trim().length === 0
        ) {
            throw new TypeError(
                `source ${source.id} has an empty operation capability`,
            );
        }
        if (!Number.isFinite(capability.priority ?? 0)) {
            throw new TypeError(
                `source ${source.id} has an invalid capability priority`,
            );
        }
        if (typeof capability.streaming !== "boolean") {
            throw new TypeError(
                `source ${source.id} has an invalid streaming capability`,
            );
        }
        validateCapabilityList(capability.models, source.id, "models");
        validateCapabilityList(capability.features, source.id, "features");
    }
}

function validateCapabilityList(
    value: readonly string[] | undefined,
    sourceId: string,
    field: string,
): void {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
        throw new TypeError(
            `source ${sourceId} capability ${field} must be an array`,
        );
    }
    for (const item of value) {
        if (typeof item !== "string" || item.trim().length === 0) {
            throw new TypeError(
                `source ${sourceId} capability ${field} must contain non-empty strings`,
            );
        }
    }
}

function validateFrameShape(frame: StreamFrame, requestId: string): void {
    if (frame === null || typeof frame !== "object") {
        throw new FrameValidationError("source emitted a non-object frame");
    }
    if (typeof frame.version !== "number" || frame.version !== HIP_VERSION) {
        throw new FrameValidationError(
            `unsupported HIP version ${frame.version}`,
        );
    }
    if (typeof frame.requestId !== "string" || frame.requestId !== requestId) {
        throw new FrameValidationError(
            `source emitted frame for request ${frame.requestId}; expected ${requestId}`,
        );
    }
    if (
        typeof frame.streamId !== "string" || frame.streamId.trim().length === 0
    ) {
        throw new FrameValidationError("streamId cannot be empty");
    }
    if (!Number.isSafeInteger(frame.seq) || frame.seq < 1) {
        throw new FrameValidationError(
            "frame sequence must be a positive integer",
        );
    }
    if (
        typeof frame.eventId !== "string" || frame.eventId.trim().length === 0
    ) {
        throw new FrameValidationError("eventId cannot be empty");
    }
    if (!Number.isFinite(Date.parse(frame.timestamp))) {
        throw new FrameValidationError(
            "timestamp must be an RFC 3339 date-time",
        );
    }
    if (
        frame.event === null || typeof frame.event !== "object" ||
        typeof frame.event.kind !== "string" || frame.event.kind.length === 0
    ) {
        throw new FrameValidationError("frame event kind is required");
    }
    try {
        validateStreamFrame(frame);
    } catch (error) {
        throw new FrameValidationError(
            error instanceof Error ? error.message : String(error),
        );
    }
}

function isTerminalEvent(kind: string): boolean {
    return kind === "run.completed" || kind === "run.error" ||
        kind === "run.cancelled";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<StreamFrame> {
    return typeof value === "object" && value !== null &&
        typeof (value as { [Symbol.asyncIterator]?: unknown })[
                Symbol.asyncIterator
            ] ===
            "function";
}
