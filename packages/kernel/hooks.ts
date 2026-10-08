import type {
    MiddlewarePlugin,
    RequestContext,
    RequestHookContext,
} from "../contracts/mod.ts";
import type { OperationRequest, StreamFrame } from "../hip/mod.ts";
import type { RequestLifecycle } from "./mod.ts";
import { withCancellation } from "./cancellation.ts";
import { MiddlewareFrameStreams } from "./middleware-frames.ts";

/** A host middleware failure must not cool, retry or fail over an upstream. */
export class SourceMiddlewareError extends Error {
    override readonly name = "SourceMiddlewareError";
    readonly code: string;
    readonly status: number;

    constructor(cause: unknown) {
        super("source middleware execution failed", { cause });
        let code: unknown;
        let status: unknown;
        try {
            if (typeof cause === "object" && cause !== null) {
                code = Object.getOwnPropertyDescriptor(cause, "code")?.value;
                status = Object.getOwnPropertyDescriptor(cause, "status")
                    ?.value;
            }
        } catch {
            /* An arbitrary thrown value cannot break fault isolation. */
        }
        this.code =
            typeof code === "string" && /^[a-zA-Z0-9_.-]{1,96}$/.test(code)
                ? code
                : "middleware_error";
        this.status = typeof status === "number" && Number.isInteger(status) &&
                status >= 400 && status <= 599
            ? status
            : 500;
    }
}

/** Ordered in-process request and frame middleware. */
export class MiddlewareRegistry {
    #plugins = new Map<string, MiddlewarePlugin>();

    register(plugin: MiddlewarePlugin): void {
        if (plugin === null || typeof plugin !== "object") {
            throw new TypeError("middleware plugin must be an object");
        }
        const manifest = plugin.manifest;
        if (
            manifest === null || typeof manifest !== "object" ||
            manifest.kind !== "middleware"
        ) {
            throw new TypeError(
                `middleware ${
                    manifest?.id ?? "<unknown>"
                } must declare kind middleware`,
            );
        }
        if (
            typeof manifest.id !== "string" || manifest.id.trim().length === 0
        ) {
            throw new TypeError("middleware id is required");
        }
        if (this.#plugins.has(manifest.id)) {
            throw new TypeError(
                `middleware already registered: ${manifest.id}`,
            );
        }
        if (!Number.isSafeInteger(plugin.order ?? 0)) {
            throw new TypeError(
                `middleware order must be a safe integer: ${manifest.id}`,
            );
        }
        for (const hook of ["transformRequest", "transformFrames"] as const) {
            if (
                plugin[hook] !== undefined && typeof plugin[hook] !== "function"
            ) {
                throw new TypeError(
                    `middleware ${hook} must be a function: ${manifest.id}`,
                );
            }
        }
        if (
            plugin.transformRequest === undefined &&
            plugin.transformFrames === undefined
        ) {
            throw new TypeError(`middleware has no hooks: ${manifest.id}`);
        }
        this.#plugins.set(manifest.id, plugin);
    }

    unregister(id: string): boolean {
        return this.#plugins.delete(id);
    }

    get(id: string): MiddlewarePlugin | undefined {
        return this.#plugins.get(id);
    }

    list(): readonly MiddlewarePlugin[] {
        return this.ordered();
    }

    /** One execution keeps the same request/response chain across live switches. */
    snapshot(): MiddlewareRegistry {
        const snapshot = new MiddlewareRegistry();
        for (const plugin of this.ordered()) snapshot.register(plugin);
        return snapshot;
    }

    /** Explicit bindings override declaration order and never re-enable plugins. */
    select(ids: readonly string[]): MiddlewareRegistry {
        const selection = new MiddlewareRegistry();
        for (const [order, id] of ids.entries()) {
            const plugin = this.#plugins.get(id);
            if (plugin === undefined || selection.get(id) !== undefined) {
                continue;
            }
            selection.register({
                ...plugin,
                order,
                ...(plugin.transformRequest === undefined ? {} : {
                    transformRequest: plugin.transformRequest.bind(plugin),
                }),
                ...(plugin.transformFrames === undefined ? {} : {
                    transformFrames: plugin.transformFrames.bind(plugin),
                }),
            });
        }
        return selection;
    }

    async transformRequest(
        input: OperationRequest,
        request: RequestContext,
    ): Promise<OperationRequest> {
        let current = input;
        validateOperationEnvelope(current);
        for (const plugin of this.ordered()) {
            if (plugin.transformRequest === undefined) continue;
            const next = await withCancellation(
                () =>
                    plugin.transformRequest!(
                        current,
                        hookContext(request, plugin),
                    ),
                request.signal,
            );
            request.signal.throwIfAborted();
            if (next !== undefined) current = next;
            validateOperationEnvelope(current);
            if (current.requestId !== request.requestId) {
                throw new TypeError(
                    `middleware ${plugin.manifest.id} changed the request id`,
                );
            }
        }
        return current;
    }

    async transformFrames(
        input: OperationRequest,
        request: RequestContext,
        frames: AsyncIterable<StreamFrame>,
    ): Promise<AsyncIterable<StreamFrame>> {
        const owner = new MiddlewareFrameStreams(request.signal);
        try {
            let current = owner.own(frames);
            for (const plugin of this.ordered()) {
                if (plugin.transformFrames === undefined) continue;
                const next = await withCancellation(
                    () =>
                        Promise.resolve(
                            plugin.transformFrames!(
                                input,
                                hookContext(request, plugin),
                                current,
                            ),
                        )
                            .then((next) => {
                                if (next === undefined) return undefined;
                                if (!isAsyncIterable(next)) {
                                    throw new TypeError(
                                        `middleware ${plugin.manifest.id} did not return an async frame stream`,
                                    );
                                }
                                return owner.own(next);
                            }),
                    request.signal,
                );
                request.signal.throwIfAborted();
                if (next !== undefined) current = next;
            }
            return owner.finish(current);
        } catch (error) {
            try {
                await owner.dispose();
            } catch { /* Preserve the failing hook. */ }
            throw error;
        }
    }

    private ordered(): MiddlewarePlugin[] {
        return [...this.#plugins.values()].sort((left, right) =>
            (left.order ?? 0) - (right.order ?? 0) ||
            left.manifest.id.localeCompare(right.manifest.id)
        );
    }
}

export interface LifecycleHookContext {
    readonly request: OperationRequest;
    readonly lifecycle: RequestLifecycle;
}

/** Optional observer hooks for recording, metrics, tracing, and audit sinks. */
export interface LifecycleHook {
    readonly id: string;
    readonly order?: number;
    readonly onBegin?: (
        context: LifecycleHookContext,
    ) => void | PromiseLike<void>;
    readonly onFrame?: (
        frame: StreamFrame,
        context: LifecycleHookContext,
    ) => void | PromiseLike<void>;
    readonly onComplete?: (
        outcome: "completed" | "error" | "cancelled",
        context: LifecycleHookContext,
    ) => void | PromiseLike<void>;
    readonly onError?: (
        error: unknown,
        context: LifecycleHookContext,
    ) => void | PromiseLike<void>;
}

/** Deterministic lifecycle observer registry. */
export class LifecycleHookRegistry {
    #hooks = new Map<string, LifecycleHook>();

    register(hook: LifecycleHook): void {
        if (hook.id.trim().length === 0) {
            throw new TypeError("lifecycle hook id is required");
        }
        if (this.#hooks.has(hook.id)) {
            throw new TypeError(
                `lifecycle hook already registered: ${hook.id}`,
            );
        }
        if (!Number.isSafeInteger(hook.order ?? 0)) {
            throw new TypeError(
                `lifecycle hook order must be a safe integer: ${hook.id}`,
            );
        }
        if (
            hook.onBegin === undefined && hook.onFrame === undefined &&
            hook.onComplete === undefined && hook.onError === undefined
        ) {
            throw new TypeError(`lifecycle hook has no callbacks: ${hook.id}`);
        }
        this.#hooks.set(hook.id, hook);
    }

    unregister(id: string): boolean {
        return this.#hooks.delete(id);
    }

    list(): readonly LifecycleHook[] {
        return this.ordered();
    }

    async begin(context: LifecycleHookContext): Promise<void> {
        for (const hook of this.ordered()) await hook.onBegin?.(context);
    }

    async frame(
        frame: StreamFrame,
        context: LifecycleHookContext,
    ): Promise<void> {
        for (const hook of this.ordered()) await hook.onFrame?.(frame, context);
    }

    async complete(
        outcome: "completed" | "error" | "cancelled",
        context: LifecycleHookContext,
    ): Promise<void> {
        for (const hook of this.ordered()) {
            await hook.onComplete?.(outcome, context);
        }
    }

    async error(error: unknown, context: LifecycleHookContext): Promise<void> {
        for (const hook of this.ordered()) await hook.onError?.(error, context);
    }

    private ordered(): LifecycleHook[] {
        return [...this.#hooks.values()].sort((left, right) =>
            (left.order ?? 0) - (right.order ?? 0) ||
            left.id.localeCompare(right.id)
        );
    }
}

function hookContext(
    request: RequestContext,
    plugin: MiddlewarePlugin,
): RequestHookContext {
    return { request, pluginId: plugin.manifest.id };
}

function validateOperationEnvelope(input: OperationRequest): void {
    if (input === null || typeof input !== "object") {
        throw new TypeError(
            "middleware returned a non-object operation request",
        );
    }
    if (typeof input.version !== "number" || input.version !== 1) {
        throw new TypeError(`unsupported HIP version ${input.version}`);
    }
    if (
        typeof input.requestId !== "string" ||
        input.requestId.trim().length === 0
    ) {
        throw new TypeError("operation request id is required");
    }
    if (
        typeof input.operation !== "string" ||
        input.operation.trim().length === 0
    ) {
        throw new TypeError("operation name is required");
    }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<StreamFrame> {
    return typeof value === "object" && value !== null &&
        typeof (value as { [Symbol.asyncIterator]?: unknown })[
                Symbol.asyncIterator
            ] ===
            "function";
}
