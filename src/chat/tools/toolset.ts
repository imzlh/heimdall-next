import type {
    ServerTool,
    ToolBudget,
    ToolExecutionContext,
    ToolInvocation,
    ToolOutcome,
    ToolPlugin,
} from "@heimdall/contracts";
import type { ToolDefinition } from "@heimdall/hip";
import { MAX_TOOL_ARGUMENT_CHARS, MAX_TOOL_TEXT_CHARS } from "../constants.ts";

export type { ToolInvocation, ToolOutcome } from "@heimdall/contracts";
export type RunBudget = ToolBudget;
export type ChatToolProvider =
    | readonly ToolPlugin[]
    | (() => readonly ToolPlugin[]);

/** The loop owns accounting; individual plugins choose their budget keys. */
export function newRunBudget(): RunBudget {
    const counters = new Map<string, number>();
    return {
        consume(key, limit) {
            if (!Number.isSafeInteger(limit) || limit < 0) return false;
            const used = counters.get(key) ?? 0;
            if (used >= limit) return false;
            counters.set(key, used + 1);
            return true;
        },
    };
}

export interface ChatToolset {
    readonly definitions: readonly ToolDefinition[];
    isServerTool(name: string): boolean;
    /** Failures are model-visible outcomes, never uncaught plugin exceptions. */
    run(
        call: ToolInvocation,
        budget: RunBudget,
        signal: AbortSignal,
        request?: ToolExecutionContext["request"],
    ): Promise<ToolOutcome>;
}

/** No built-in names or implementations: all tools arrive from composition. */
export function createChatToolset(
    plugins: readonly ToolPlugin[] = [],
): ChatToolset {
    const registry = new Map<string, { pluginId: string; tool: ServerTool }>();
    const pluginIds = new Set<string>();
    for (const plugin of plugins) {
        const pluginId = plugin.manifest.id;
        if (plugin.manifest.kind !== "tool" || pluginIds.has(pluginId)) {
            throw new TypeError(
                `Invalid or duplicate tool plugin: ${pluginId}`,
            );
        }
        pluginIds.add(pluginId);
        for (const tool of plugin.tools) {
            const name = tool.definition.name;
            if (!name || registry.has(name)) {
                throw new TypeError(`Invalid or duplicate tool name: ${name}`);
            }
            registry.set(name, { pluginId, tool });
        }
    }
    return {
        definitions: [...registry.values()].map(({ tool }) => ({
            ...tool.definition,
            execution: "server",
        })),
        isServerTool: (name) => registry.has(name),
        async run(call, budget, signal, request) {
            if (call.argumentsText.length > MAX_TOOL_ARGUMENT_CHARS) {
                return fail("tool arguments are too large");
            }
            const entry = registry.get(call.name);
            if (entry === undefined) return fail(`unknown tool: ${call.name}`);
            if (signal.aborted) return fail("tool execution cancelled");
            try {
                const outcome = await entry.tool.execute(call, {
                    signal,
                    ...(request ? { request } : {}),
                    budget: {
                        consume: (key, limit) =>
                            budget.consume(
                                JSON.stringify([entry.pluginId, key]),
                                limit,
                            ),
                    },
                });
                if (signal.aborted) return fail("tool execution cancelled");
                if (
                    typeof outcome?.text !== "string" ||
                    typeof outcome.isError !== "boolean"
                ) return fail("tool returned an invalid result");
                return {
                    text: outcome.text.slice(0, MAX_TOOL_TEXT_CHARS),
                    isError: outcome.isError,
                };
            } catch {
                return fail(
                    signal.aborted
                        ? "tool execution cancelled"
                        : "tool execution failed",
                );
            }
        },
    };
}

function fail(text: string): ToolOutcome {
    return { text, isError: true };
}
