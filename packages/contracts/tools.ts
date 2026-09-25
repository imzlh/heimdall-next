import type { ToolDefinition } from "../hip/mod.ts";
import type { PluginManifest } from "./plugin.ts";

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
    create(context: {
        readonly env: (name: string) => string | undefined;
    }): ToolPlugin;
}
