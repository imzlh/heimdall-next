import type { RequestContext, SourceContext } from "../contracts/mod.ts";
import type { OperationRequest, StreamFrame } from "../hip/mod.ts";
import { FrameValidationError, validateFrames } from "./sources.ts";
import {
    type LifecycleHookContext,
    LifecycleHookRegistry,
    MiddlewareRegistry,
} from "./hooks.ts";
import type {
    Kernel,
    KernelExecution,
    KernelExecutionPorts,
    RequestLifecycle,
} from "./mod.ts";

/** Options for the semantic execution plane. Protocol routing is host-owned. */
export interface KernelRuntimeOptions extends KernelExecutionPorts {
    readonly middleware?: MiddlewareRegistry;
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
     * request is the semantic request that the source will receive.
     */
    async run(
        request: OperationRequest,
        lifecycle: RequestLifecycle,
        options: KernelExecuteOptions = {},
    ): Promise<KernelExecution> {
        validateLifecycle(request, lifecycle);
        lifecycle.signal.throwIfAborted();
        const transformed = await this.transformRequest(
            request,
            options.requestContext,
        );
        lifecycle.signal.throwIfAborted();
        return {
            request: transformed,
            lifecycle,
            frames: this.frames(transformed, lifecycle, options),
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
        let preparation: Promise<void> | undefined;
        const prepare = async (): Promise<void> => {
            if (preparation === undefined) {
                preparation = this.transformRequest(
                    request,
                    options.requestContext,
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
    ): Promise<OperationRequest> {
        if (this.middleware.list().length === 0) return request;
        if (context === undefined) {
            throw new KernelContextError(
                "a RequestContext is required when middleware plugins are registered",
            );
        }
        return await this.middleware.transformRequest(request, context);
    }

    private lazyFrames(
        prepare: () => Promise<void>,
        request: () => OperationRequest,
        lifecycle: RequestLifecycle,
        options: KernelExecuteOptions,
    ): AsyncIterable<StreamFrame> {
        return this.lazyFrameStream(prepare, request, lifecycle, options);
    }

    private async *lazyFrameStream(
        prepare: () => Promise<void>,
        request: () => OperationRequest,
        lifecycle: RequestLifecycle,
        options: KernelExecuteOptions,
    ): AsyncIterable<StreamFrame> {
        lifecycle.signal.throwIfAborted();
        await prepare();
        lifecycle.signal.throwIfAborted();
        const execution = this.frames(request(), lifecycle, options);
        for await (const frame of execution) yield frame;
    }

    private frames(
        request: OperationRequest,
        lifecycle: RequestLifecycle,
        options: KernelExecuteOptions,
    ): AsyncIterable<StreamFrame> {
        return this.frameStream(request, lifecycle, options);
    }

    private async *frameStream(
        request: OperationRequest,
        lifecycle: RequestLifecycle,
        options: KernelExecuteOptions,
    ): AsyncIterable<StreamFrame> {
        const context = options.requestContext;
        const hookContext: LifecycleHookContext = { request, lifecycle };
        let began = false;
        let finished = false;
        let terminal = false;
        let outcome: "completed" | "error" | "cancelled" | undefined;

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
            let sourceFrames = this.sources.run(request, sourceContext);
            if (this.middleware.list().length > 0) {
                if (context === undefined) {
                    throw new KernelContextError(
                        "a RequestContext is required when middleware plugins are registered",
                    );
                }
                sourceFrames = await this.middleware.transformFrames(
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
            try {
                await this.lifecycleHooks.error(error, hookContext);
            } finally {
                if (began) await complete(failure);
            }
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
