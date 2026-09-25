import type {
    MiddlewarePlugin,
    RequestContext,
    RequestHookContext,
} from "../contracts/mod.ts";
import type { OperationRequest, StreamFrame } from "../hip/mod.ts";
import type { RequestLifecycle } from "./mod.ts";

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

    async transformRequest(
        input: OperationRequest,
        request: RequestContext,
    ): Promise<OperationRequest> {
        let current = input;
        validateOperationEnvelope(current);
        for (const plugin of this.ordered()) {
            if (plugin.transformRequest === undefined) continue;
            const next = await plugin.transformRequest(
                current,
                hookContext(request, plugin),
            );
            if (next === undefined) continue;
            validateOperationEnvelope(next);
            if (next.requestId !== request.requestId) {
                throw new TypeError(
                    `middleware ${plugin.manifest.id} changed the request id`,
                );
            }
            current = next;
        }
        return current;
    }

    async transformFrames(
        input: OperationRequest,
        request: RequestContext,
        frames: AsyncIterable<StreamFrame>,
    ): Promise<AsyncIterable<StreamFrame>> {
        let current = frames;
        for (const plugin of this.ordered()) {
            if (plugin.transformFrames === undefined) continue;
            const next = await plugin.transformFrames(
                input,
                hookContext(request, plugin),
                current,
            );
            if (next === undefined) continue;
            if (!isAsyncIterable(next)) {
                throw new TypeError(
                    `middleware ${plugin.manifest.id} did not return an async frame stream`,
                );
            }
            current = next;
        }
        return current;
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
