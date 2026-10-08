/**
 * Kernel ports.
 *
 * Implementations coordinate routing and lifecycle, but remain independent of
 * HTTP frameworks and persistence engines. The composition root supplies the
 * concrete registries and stores.
 */

import type {
    InferenceSource,
    PluginRoute,
    ProtocolPlugin,
    SourceContext,
} from "../contracts/mod.ts";
import type { OperationRequest, StreamFrame } from "../hip/mod.ts";

export interface ProtocolMatch {
    readonly plugin: ProtocolPlugin;
    readonly route: PluginRoute;
}

export interface ProtocolRouter {
    resolve(
        route: Pick<PluginRoute, "method" | "path">,
    ): ProtocolMatch | undefined;
}

export interface SourceRouter {
    select(request: OperationRequest): InferenceSource;
    /** Check capability matches without consuming routing/round-robin state. */
    hasMatchingSource?(
        request: OperationRequest,
        sourceIds: ReadonlySet<string>,
    ): boolean;
    run(
        request: OperationRequest,
        context: SourceContext,
    ): AsyncIterable<StreamFrame>;
    /** Host execution decoration applied independently to every routing attempt. */
    runWith?(
        request: OperationRequest,
        context: SourceContext,
        execute: SourceExecution,
        excludedSourceIds?: ReadonlySet<string>,
    ): AsyncIterable<StreamFrame>;
}

export type SourceExecution = (
    source: InferenceSource,
    request: OperationRequest,
    context: SourceContext,
) => AsyncIterable<StreamFrame>;

/** Absent keys inherit the global chain; arrays replace it in the saved order. */
export type SourceMiddlewareBindings = ReadonlyMap<string, readonly string[]>;

export interface RequestLifecycle {
    readonly requestId: string;
    readonly streamId: string;
    readonly signal: AbortSignal;
    readonly startedAt: string;
}

export interface KernelExecution {
    readonly request: OperationRequest;
    readonly lifecycle: RequestLifecycle;
    readonly frames: AsyncIterable<StreamFrame>;
}

/** Transport-neutral execution entry point owned by the server composition. */
export interface Kernel {
    execute(
        request: OperationRequest,
        lifecycle: RequestLifecycle,
    ): KernelExecution;
}

/**
 * Ports needed to execute a semantic HIP request. Protocol routing belongs to
 * the transport composition root and is intentionally absent here.
 */
export interface KernelExecutionPorts {
    readonly sources: SourceRouter;
    readonly lifecycle?: LifecyclePort;
}

/**
 * Complete host composition ports. This convenience shape is kept separate
 * from `KernelExecutionPorts` so a protocol router cannot accidentally become
 * a runtime dependency.
 */
export interface KernelPorts extends KernelExecutionPorts {
    readonly protocols: ProtocolRouter;
}

export interface LifecyclePort {
    begin(request: OperationRequest, lifecycle: RequestLifecycle): void;
    append(frame: StreamFrame): void;
    complete(
        requestId: string,
        outcome: "completed" | "error" | "cancelled",
    ): void;
}

export class KernelUnavailableError extends Error {
    override readonly name = "KernelUnavailableError";
}

export {
    ProtocolRegistry,
    ProtocolRouteConflictError,
    ProtocolRouteError,
    routeKey,
} from "./protocols.ts";
export type {
    DiscoveredModel,
    FrameValidationOptions,
    SourceRegistryOptions,
} from "./sources.ts";
export type {
    SourceCooldown,
    SourceCooldownReason,
    SourceHealthCheck,
    SourceHealthSnapshot,
} from "./source-health.ts";
export {
    FrameValidationError,
    SourceRegistry,
    SourceUnavailableError,
    validateFrames,
} from "./sources.ts";
export {
    type LifecycleHook,
    type LifecycleHookContext,
    LifecycleHookRegistry,
    MiddlewareRegistry,
    SourceMiddlewareError,
} from "./hooks.ts";
export {
    createKernelRuntime,
    KernelContextError,
    type KernelExecuteOptions,
    KernelExecutionError,
    KernelRuntime,
    type KernelRuntimeOptions,
} from "./runtime.ts";
