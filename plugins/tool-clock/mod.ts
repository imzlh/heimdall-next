import type {
    PluginManifest,
    ToolPlugin,
    ToolPluginFactory,
} from "@heimdall/contracts";
import { MAX_TOOL_ARGUMENT_CHARS } from "./constants.ts";
import manifest from "./manifest.json" with { type: "json" };

const clockManifest = manifest as unknown as PluginManifest;

export interface ClockToolDeps {
    readonly now?: () => Date;
}

export function createClockToolPlugin(deps: ClockToolDeps = {}): ToolPlugin {
    const now = deps.now ?? (() => new Date());
    return {
        manifest: clockManifest,
        tools: [{
            definition: {
                name: "current_time",
                description:
                    "Return the current server time in UTC. Use when the user asks what time or date it is.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
                execution: "server",
            },
            execute(call) {
                if (call.argumentsText.length > MAX_TOOL_ARGUMENT_CHARS) {
                    return {
                        text: "tool arguments are too large",
                        isError: true,
                    };
                }
                if (call.name !== "current_time") {
                    return {
                        text: `unknown tool: ${call.name}`,
                        isError: true,
                    };
                }
                return {
                    text: `Current time: ${now().toISOString()} (UTC).`,
                    isError: false,
                };
            },
        }],
    };
}

export const toolPlugin: ToolPluginFactory = {
    manifest: clockManifest,
    create: () => createClockToolPlugin(),
};
