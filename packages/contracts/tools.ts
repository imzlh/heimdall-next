import type { JsonValue, ToolDefinition } from "../hip/mod.ts";
import type { PluginManifest, RequestContext } from "./plugin.ts";

/** A model-issued call; the named plugin owns argument validation. */
export interface ToolInvocation {
    readonly callId: string;
    readonly name: string;
    readonly argumentsText: string;
}

export interface ToolOutcome {
    readonly text: string;
    readonly isError: boolean;
}

/** Per-run accounting. The host scopes keys to the owning plugin. */
export interface ToolBudget {
    consume(key: string, limit: number): boolean;
}

export interface ToolExecutionContext {
    readonly signal: AbortSignal;
    readonly budget: ToolBudget;
    /** JSON-only identity for conversation-scoped plugins; no HTTP headers or body. */
    readonly request?: Pick<RequestContext, "requestId" | "metadata">;
}

export interface ServerTool {
    readonly definition: ToolDefinition;
    execute(
        call: ToolInvocation,
        context: ToolExecutionContext,
    ): ToolOutcome | Promise<ToolOutcome>;
}

/** An in-process tool capability registered by the composition root. */
export interface ToolPlugin {
    readonly manifest: PluginManifest;
    readonly tools: readonly ServerTool[];
}

/** Local trusted modules may expose this factory without naming tools in core. */
export interface ToolPluginFactory {
    readonly manifest: PluginManifest;
    /** Opt into durable operator configuration together with configSchema. */
    validateConfig?(input: unknown): JsonValue | Promise<JsonValue>;
    /** Project configuration for management responses; never exposes host storage. */
    redactConfig?(config: JsonValue): JsonValue;
    /** Merge omitted write-only fields with the server-held previous configuration. */
    mergeConfig?(
        input: unknown,
        previous: JsonValue | undefined,
    ): unknown | Promise<unknown>;
    create(context: {
        readonly env: (name: string) => string | undefined;
        /** Validated host-owned configuration, replaced by creating a new plugin. */
        readonly config?: JsonValue;
    }): ToolPlugin;
}
