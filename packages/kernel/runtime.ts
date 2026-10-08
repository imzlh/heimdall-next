import type { RequestContext, SourceContext } from "../contracts/mod.ts";
import type {
    CanonicalError,
    OperationRequest,
    StreamFrame,
} from "../hip/mod.ts";
import { FrameValidationError, validateFrames } from "./sources.ts";
import {
    type LifecycleHookContext,
    LifecycleHookRegistry,
    MiddlewareRegistry,
    SourceMiddlewareError,
} from "./hooks.ts";
import type {
    Kernel,
    KernelExecution,
    KernelExecutionPorts,
    RequestLifecycle,
    SourceMiddlewareBindings,
} from "./mod.ts";
import {
    type ExecutionMiddleware,
    sourceMiddlewareExecution,
} from "./source-middleware.ts";

/** Options for the semantic execution plane. Protocol routing is host-owned. */
export interface KernelRuntimeOptions extends KernelExecutionPorts {
    readonly middleware?: MiddlewareRegistry;
    /** Snapshot host-owned per-source overrides at the start of each request. */
    readonly sourceMiddleware?: () => SourceMiddlewareBindings;
    readonly lifecycleHooks?: LifecycleHookRegistry;
    /** Require a terminal HIP event before a source iterable completes. */
    readonly requireTerminal?: boolean;
    readonly now?: () => Date;
    readonly streamId?: (request: OperationRequest) => string;
}

export interface KernelExecuteOptions {
    /** Protocol context passed to middleware plugins. */
    readonly requestContext?: RequestContext;
    /** Override the runtime's terminal-event policy for this execution. */
    readonly requireTerminal?: boolean;
    /**
     * Verify that source frames use the lifecycle's preallocated stream id.
     * Source plugins commonly allocate their id after execution begins, so the
     * default is false; HIP validation still enforces one stable id per stream.
     */
    readonly enforceStreamId?: boolean;
}

export class KernelContextError extends Error {
    override readonly name = "KernelContextError";
}

export class KernelExecutionError extends Error {
    override readonly name = "KernelExecutionError";
}

/**
 * Concrete transport-neutral kernel. HTTP hosts provide the protocol context,
 * while this class owns middleware ordering, source execution, frame checks,
 * and lifecycle notifications.
 */
export class KernelRuntime implements Kernel {
    readonly sources: KernelExecutionPorts["sources"];
    readonly lifecycle: KernelExecutionPorts["lifecycle"];
    readonly middleware: MiddlewareRegistry;
    readonly sourceMiddleware: (() => SourceMiddlewareBindings) | undefined;
    readonly lifecycleHooks: LifecycleHookRegistry;
    readonly requireTerminal: boolean;
    #now: () => Date;
    #streamId: (request: OperationRequest) => string;

    constructor(options: KernelRuntimeOptions) {
        if (options.sources === undefined) {
            throw new TypeError("kernel source router is required");
        }
        this.sources = options.sources;
        this.lifecycle = options.lifecycle;
        this.middleware = options.middleware ?? new MiddlewareRegistry();
        this.sourceMiddleware = options.sourceMiddleware;
        if (
            this.sourceMiddleware !== undefined &&
            options.sources.runWith === undefined
        ) {
            throw new TypeError(
                "source middleware requires a source router with runWith()",
            );
        }
        this.lifecycleHooks = options.lifecycleHooks ??
            new LifecycleHookRegistry();
        this.requireTerminal = options.requireTerminal ?? true;
        this.#now = options.now ?? (() => new Date());
        this.#streamId = options.streamId ??
            ((request) => `run:${request.requestId}`);
    }

    /**
     * Prepare an execution before a host starts serializing it. Awaiting this
     * method guarantees that request middleware has already run and the returned
     * request is the globally prepared semantic request. With source bindings,
     * it stays the public routing request; the selected chain runs per attempt.
     */
    async run(
        request: OperationRequest,
        lifecycle: RequestLifecycle,
        options: KernelExecuteOptions = {},
    ): Promise<KernelExecution> {
        validateLifecycle(request, lifecycle);
        lifecycle.signal.throwIfAborted();
        const middleware = this.snapshotMiddleware(request);
        const transformed = await this.transformRequest(
            request,
            options.requestContext,
            middleware,
        );
        lifecycle.signal.throwIfAborted();
        return {
            request: transformed,
            lifecycle,
            frames: this.frames(transformed, lifecycle, options, middleware),
        };
    }

    /**
     * Synchronous facade required by the Kernel port. Middleware and source work
     * remains lazy: execution begins when the returned frame iterable is pulled.
     */
    execute(
        request: OperationRequest,
        lifecycle: RequestLifecycle,
        options: KernelExecuteOptions = {},
    ): KernelExecution {
        validateLifecycle(request, lifecycle);
        let prepared = request;
        let middleware: ExecutionMiddleware;
        let preparation: Promise<void> | undefined;
        const prepare = async (): Promise<void> => {
            if (preparation === undefined) {
                middleware = this.snapshotMiddleware(request);
                preparation = this.transformRequest(
                    request,
                    options.requestContext,
                    middleware,
                ).then(
                    (value) => {
                        prepared = value;
                    },
                );
            }
            await preparation;
        };
        const frames = this.lazyFrames(
            prepare,
            () => prepared,
            lifecycle,
            options,
            () => middleware,
        );
        return {
            get request() {
                return prepared;
            },
            lifecycle,
            frames,
        };
    }

    createLifecycle(
        request: OperationRequest,
        signal: AbortSignal,
        options: { readonly streamId?: string; readonly startedAt?: string } =
            {},
    ): RequestLifecycle {
        return {
            requestId: request.requestId,
            streamId: options.streamId ?? this.#streamId(request),
            signal,
            startedAt: options.startedAt ?? this.#now().toISOString(),
        };
    }

    private async transformRequest(
        request: OperationRequest,
        context: RequestContext | undefined,
        middleware: ExecutionMiddleware,
    ): Promise<OperationRequest> {
        if (
            middleware.perSource ||
            middleware.global.list().length === 0
        ) return request;
        if (context === undefined) {
            throw new KernelContextError(
                "a RequestContext is required when middleware plugins are registered",
            );
        }
        return await middleware.global.transformRequest(request, context);
    }

    private snapshotMiddleware(request: OperationRequest): ExecutionMiddleware {
        const bindings = new Map(
            [...(this.sourceMiddleware?.() ?? [])].map((
                [id, binding],
            ) => [id, [...binding]]),
        );
        return {
            global: this.middleware.snapshot(),
            bindings,
            // Unrelated bindings do not change global pre-routing transforms.
            // Keep them in the snapshot so that a later model rewrite cannot
            // bypass an explicitly bound source's independent chain.
            perSource: bindings.size > 0 && (this.sources.hasMatchingSource?.(
                request,
                new Set(bindings.keys()),
            ) ?? true),
        };
    }

    private lazyFrames(
        prepare: () => Promise<void>,
        request: () => OperationRequest,
        lifecycle: RequestLifecycle,
        options: KernelExecuteOptions,
        middleware: () => ExecutionMiddleware,
    ): AsyncIterable<StreamFrame> {
        return this.lazyFrameStream(
            prepare,
            request,
            lifecycle,
            options,
            middleware,
        );
    }

    private async *lazyFrameStream(
        prepare: () => Promise<void>,
        request: () => OperationRequest,
        lifecycle: RequestLifecycle,
        options: KernelExecuteOptions,
        middleware: () => ExecutionMiddleware,
    ): AsyncIterable<StreamFrame> {
        lifecycle.signal.throwIfAborted();
        await prepare();
        lifecycle.signal.throwIfAborted();
        const execution = this.frames(
            request(),
            lifecycle,
            options,
            middleware(),
        );
        for await (const frame of execution) yield frame;
    }

    private frames(
        request: OperationRequest,
        lifecycle: RequestLifecycle,
        options: KernelExecuteOptions,
        middleware: ExecutionMiddleware,
    ): AsyncIterable<StreamFrame> {
        return this.frameStream(request, lifecycle, options, middleware);
    }

    private async *frameStream(
        request: OperationRequest,
        lifecycle: RequestLifecycle,
        options: KernelExecuteOptions,
        middleware: ExecutionMiddleware,
    ): AsyncIterable<StreamFrame> {
        const context = options.requestContext;
        const hookContext: LifecycleHookContext = { request, lifecycle };
        let began = false;
        let finished = false;
        let terminal = false;
        let outcome: "completed" | "error" | "cancelled" | undefined;
        let lastSeq = 0;
        let lastStreamId = lifecycle.streamId;

        const complete = async (
            nextOutcome: "completed" | "error" | "cancelled",
        ): Promise<void> => {
            if (finished) return;
            finished = true;
            outcome = nextOutcome;
            let completionError: unknown;
            try {
                await this.lifecycleHooks.complete(nextOutcome, hookContext);
            } catch (error) {
                completionError = error;
            }
            try {
                this.lifecycle?.complete(request.requestId, nextOutcome);
            } catch (error) {
                completionError ??= error;
            }
            if (completionError !== undefined) throw completionError;
        };

        try {
            lifecycle.signal.throwIfAborted();
            this.lifecycle?.begin(request, lifecycle);
            began = true;
            await this.lifecycleHooks.begin(hookContext);
            lifecycle.signal.throwIfAborted();

            const sourceContext: SourceContext = {
                requestId: request.requestId,
                signal: lifecycle.signal,
                metadata: {
                    ...(context?.metadata ?? {}),
                    ...(request.metadata ?? {}),
                },
            };
            let sourceFrames = middleware.perSource
                ? this.sources.runWith!(
                    request,
                    sourceContext,
                    sourceMiddlewareExecution(middleware, context),
                )
                : middleware.bindings.size > 0
                ? this.sources.runWith!(
                    request,
                    sourceContext,
                    (source, input, sourceContext) =>
                        source.execute(input, sourceContext),
                    new Set(middleware.bindings.keys()),
                )
                : this.sources.run(request, sourceContext);
            if (
                !middleware.perSource &&
                middleware.global.list().length > 0
            ) {
                if (context === undefined) {
                    throw new KernelContextError(
                        "a RequestContext is required when middleware plugins are registered",
                    );
                }
                sourceFrames = await middleware.global.transformFrames(
                    request,
                    context,
                    sourceFrames,
                );
            }
            const frames = validateFrames(sourceFrames, request.requestId, {
                requireStarted: true,
                requireTerminal: options.requireTerminal ??
                    this.requireTerminal,
                signal: lifecycle.signal,
            });

            for await (const frame of frames) {
                if (
                    options.enforceStreamId === true &&
                    frame.streamId !== lifecycle.streamId
                ) {
                    throw new FrameValidationError(
                        `source stream ${frame.streamId} does not match lifecycle stream ${lifecycle.streamId}`,
                    );
                }
                this.lifecycle?.append(frame);
                await this.lifecycleHooks.frame(frame, hookContext);
                lastSeq = frame.seq;
                lastStreamId = frame.streamId;
                terminal = isTerminal(frame);
                if (terminal) {
                    outcome = terminalOutcome(frame);
                }
                yield frame;
            }

            if (
                !terminal && (options.requireTerminal ?? this.requireTerminal)
            ) {
                throw new KernelExecutionError(
                    "stream ended before a terminal event",
                );
            }
            await complete(
                outcome ??
                    (lifecycle.signal.aborted ? "cancelled" : "completed"),
            );
        } catch (error) {
            const cancelled = lifecycle.signal.aborted;
            const failure = cancelled ? "cancelled" : "error";
            // Give the failure a concrete reason instead of a silent, empty
            // stream. A real failure (not a client cancel) with no terminal yet
            // is recorded as a `run.error` frame so the request journal always
            // shows *why* it failed. It is also streamed to the client, but
            // only once the source had already emitted output: a pre-output
            // failure still travels as a thrown error so protocol adapters map
            // it to the right HTTP status before any bytes are sent.
            const errorFrame = began && !cancelled && !terminal
                ? errorEventFrame(request, lastStreamId, lastSeq + 1, error, {
                    now: this.#now,
                    fallbackStreamId: lifecycle.streamId,
                })
                : undefined;
            try {
                await this.lifecycleHooks.error(error, hookContext);
            } finally {
                if (began) {
                    // Record before completing so the journal captures the
                    // reason alongside the failed status.
                    if (errorFrame !== undefined) {
                        try {
                            this.lifecycle?.append(errorFrame);
                        } catch {
                            // Recording must never mask the original failure.
                        }
                    }
                    await complete(failure);
                }
            }
            if (errorFrame !== undefined && lastSeq > 0) yield errorFrame;
            throw error;
        } finally {
            // Closing an async iterator early (for example when an HTTP client
            // disconnects) skips the code after `yield`; close the lifecycle
            // explicitly so recording and metrics never remain open.
            if (began && !finished) await complete("cancelled");
        }
    }
}

export function createKernelRuntime(
    options: KernelRuntimeOptions,
): KernelRuntime {
    return new KernelRuntime(options);
}

function validateLifecycle(
    request: OperationRequest,
    lifecycle: RequestLifecycle,
): void {
    if (request.requestId.trim().length === 0) {
        throw new TypeError("operation request id is required");
    }
    if (lifecycle.requestId !== request.requestId) {
        throw new TypeError(
            `lifecycle request id ${lifecycle.requestId} does not match ${request.requestId}`,
        );
    }
    if (lifecycle.streamId.trim().length === 0) {
        throw new TypeError("lifecycle stream id is required");
    }
}

function isTerminal(frame: StreamFrame): boolean {
    return frame.event.kind === "run.completed" ||
        frame.event.kind === "run.error" ||
        frame.event.kind === "run.cancelled";
}

function terminalOutcome(
    frame: StreamFrame,
): "completed" | "error" | "cancelled" {
    switch (frame.event.kind) {
        case "run.error":
            return "error";
        case "run.cancelled":
            return "cancelled";
        default:
            return "completed";
    }
}

/**
 * Build the synthetic terminal `run.error` frame the runtime emits when the
 * execution pipeline fails without the source having produced its own terminal
 * event (a validation failure, a stream that ended early, a middleware or
 * context error). It gives the journal and every client a concrete reason
 * instead of an empty stream.
 */
function errorEventFrame(
    request: OperationRequest,
    streamId: string,
    seq: number,
    error: unknown,
    options: { now: () => Date; fallbackStreamId: string },
): StreamFrame {
    const stream = streamId.trim().length > 0
        ? streamId
        : options.fallbackStreamId;
    return {
        version: 1,
        streamId: stream,
        requestId: request.requestId,
        seq,
        eventId: `${stream}:error:${seq}`,
        timestamp: options.now().toISOString(),
        event: { kind: "run.error", error: toCanonicalError(error) },
    };
}

/** Map an arbitrary thrown value onto the provider-independent error envelope. */
function toCanonicalError(error: unknown): CanonicalError {
    if (error instanceof SourceMiddlewareError) {
        return {
            code: error.code,
            message: error.message,
            status: error.status,
            retryable: false,
        };
    }
    if (isCanonicalError(error)) return error;
    const message = error instanceof Error && error.message.length > 0
        ? error.message
        : "generation failed";
    const name = error instanceof Error ? error.name : "";
    return {
        code: errorCodeForName(name),
        message,
        status: statusForName(name),
    };
}

function isCanonicalError(value: unknown): value is CanonicalError {
    return typeof value === "object" && value !== null &&
        typeof (value as { code?: unknown }).code === "string" &&
        typeof (value as { message?: unknown }).message === "string" &&
        !(value instanceof Error);
}

/** Stable, non-secret codes so clients can branch on the failure class. */
function errorCodeForName(name: string): string {
    switch (name) {
        case "FrameValidationError":
            return "invalid_upstream_response";
        case "KernelExecutionError":
            return "incomplete_stream";
        case "KernelContextError":
            return "kernel_misconfigured";
        case "SourceUnavailableError":
            return "upstream_unavailable";
        default:
            return "internal_error";
    }
}

/** HTTP status a protocol adapter should map the failure class onto. */
function statusForName(name: string): number {
    switch (name) {
        case "SourceUnavailableError":
            return 503;
        case "FrameValidationError":
        case "KernelExecutionError":
            return 502;
        default:
            return 500;
    }
}
