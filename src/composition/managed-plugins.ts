import type { JsonValue, ToolPlugin } from "@heimdall/contracts";
import type { ToolDefinition } from "@heimdall/hip";
import type { ConfigStore } from "@heimdall/storage";
import { createPluginHost, type PluginArtifact, type PluginHost, type PluginRecord, validatePluginManifest } from "@heimdall/plugin-host";
import { ConfigPluginRecordStore } from "../storage/plugin-records.ts";
import { IsolatedPluginRuntime } from "./isolated-plugin-runtime.ts";
import { createChatToolset } from "../chat/tools/toolset.ts";

export interface ManagedPluginPackage {
    readonly format: "heimdall-plugin/v1";
    readonly manifest: unknown;
    readonly entrypoint: "plugin.js";
    readonly code: string;
    readonly digest: string;
}

/** Offline package format; explicit checksum required, no URL install or runtime downloads. */
export function parseManagedPluginPackage(value: unknown): PluginArtifact {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("插件包必须是 JSON 对象");
    const input = value as Record<string, unknown>;
    if (input.format !== "heimdall-plugin/v1" || input.entrypoint !== "plugin.js" || typeof input.code !== "string" || typeof input.digest !== "string") throw new TypeError("插件包格式无效，需要 heimdall-plugin/v1、plugin.js、code 和 digest");
    const manifest = validatePluginManifest(input.manifest);
    if (manifest.kind !== "tool" || manifest.trust !== "isolated") throw new TypeError("动态安装当前支持隔离工具插件");
    const bytes = new TextEncoder().encode(input.code);
    if (bytes.length < 1 || bytes.length > 1024 * 1024) throw new TypeError("插件 ESM 必须介于 1 字节和 1 MiB 之间");
    return { manifest, entrypoint: input.entrypoint, bytes, digest: input.digest };
}

export interface ManagedPlugins {
    readonly host: PluginHost;
    readonly tools: () => readonly ToolPlugin[];
    install(input: unknown): Promise<PluginRecord>;
}

/** Adapter registers generic tool capabilities; tool business logic stays in its worker. */
export function createManagedPlugins(store: ConfigStore, builtins: () => readonly ToolPlugin[], reservedIds: () => readonly string[]): ManagedPlugins {
    const active = new Map<string, ToolPlugin>();
    const host = createPluginHost({
        store: new ConfigPluginRecordStore(store),
        policy: { allowUnsigned: true, maxBytes: 1024 * 1024 },
        requireRuntimeOnEnable: true,
        runtimeFactory: (artifact) => {
            const id = artifact.manifest.id;
            if (artifact.manifest.kind !== "tool" || reservedIds().includes(id)) throw new TypeError("插件类型不支持或 ID 与内置插件冲突");
            const runtime = new IsolatedPluginRuntime();
            return {
                async start(input) {
                    await runtime.start(input);
                    const definitions = parseToolDefinitions(await runtime.invoke({ method: "tools.list" }));
                    const plugin: ToolPlugin = {
                        manifest: input.manifest,
                        tools: definitions.map((definition) => ({
                            definition,
                            async execute(call, context) {
                                if (!context.budget.consume("managed-tool-calls", 32)) return { text: "tool call budget exceeded", isError: true };
                                const value = await host.invoke(id, {
                                    method: "tools.execute", payload: { ...call }, signal: context.signal,
                                });
                                if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.text !== "string" || typeof value.isError !== "boolean") throw new TypeError("插件返回了无效工具结果");
                                return { text: value.text, isError: value.isError };
                            },
                        })),
                    };
                    createChatToolset([...builtins(), ...[...active.values()].filter((entry) => entry.manifest.id !== id), plugin]);
                    active.set(id, plugin);
                },
                invoke: (invocation) => runtime.invoke(invocation),
                async stop() { active.delete(id); await runtime.stop(); },
            };
        },
    });
    return {
        host, tools: () => [...active.values()],
        async install(input) {
            const artifact = parseManagedPluginPackage(input);
            if (reservedIds().includes(artifact.manifest.id)) throw new TypeError("插件 ID 与内置插件冲突");
            return await host.install(artifact);
        },
    };
}

function parseToolDefinitions(input: JsonValue | undefined): readonly ToolDefinition[] {
    if (!Array.isArray(input) || input.length < 1 || input.length > 32) throw new TypeError("tools.list 必须返回 1 到 32 个工具定义");
    return input.map((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry) || typeof entry.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.name) || typeof entry.description !== "string" || entry.description.length > 4000 || entry.inputSchema === null || typeof entry.inputSchema !== "object" || Array.isArray(entry.inputSchema)) throw new TypeError("插件工具定义无效");
        return { name: entry.name, description: entry.description, inputSchema: entry.inputSchema, execution: "server" };
    });
}
