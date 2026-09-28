import { assertEquals, assertRejects } from "@std/assert";
import { computePluginArtifactDigest } from "@heimdall/plugin-host";
import { DenoKvConfigStore } from "../src/storage/deno-kv.ts";
import { createManagedPlugins, type ManagedPluginPackage } from "../src/composition/managed-plugins.ts";
import { loadBuiltinComposition } from "../src/composition/builtins.ts";
import { createChatToolset, newRunBudget } from "../src/chat/tools/toolset.ts";

async function packageInput(id = "test.dynamic", name = "dynamic_echo"): Promise<ManagedPluginPackage> {
    const code = `export function invoke(method, payload) {
        if (method === "tools.list") return [{ name: "${name}", description: "隔离回声工具", inputSchema: { type: "object" } }];
        if (method === "tools.execute") return { text: "动态：" + payload.argumentsText, isError: false };
        return "alive";
    }\n/*${"offline bundle ".repeat(6000)}*/`;
    return { format: "heimdall-plugin/v1", manifest: {
        id, name: "动态插件", version: "1.0.0", apiVersion: "1", kind: "tool", trust: "isolated",
    }, entrypoint: "plugin.js", code, digest: await computePluginArtifactDigest(new TextEncoder().encode(code)) };
}

Deno.test("managed plugin installs offline, joins Chat tools, survives restart, disables and uninstalls", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-managed-" });
    const path = `${directory}/plugins.sqlite3`;
    let kv = await Deno.openKv(path);
    const pluginRoot = new URL("./missing-plugin-directory/", import.meta.url);
    let composition = await loadBuiltinComposition({ configStore: new DenoKvConfigStore(kv), pluginRoot, env: () => undefined });
    const input = await packageInput();
    try {
        const manager = createManagedPlugins(new DenoKvConfigStore(kv), () => [], () => []);
        await manager.install(input);
        // The same composition can activate packages installed through its durable store.
        await composition.pluginHost.enable("test.dynamic");
        assertEquals(composition.toolPlugins().map((plugin) => plugin.manifest.id), ["test.dynamic"]);
        const tools = createChatToolset(composition.toolPlugins());
        assertEquals(await tools.run({ callId: "call-1", name: "dynamic_echo", argumentsText: "hello" }, newRunBudget(), new AbortController().signal), { text: "动态：hello", isError: false });
        await composition.close();
        kv.close();
        kv = await Deno.openKv(path);
        composition = await loadBuiltinComposition({ configStore: new DenoKvConfigStore(kv), pluginRoot, env: () => undefined });
        assertEquals((await composition.pluginHost.get("test.dynamic"))?.enabled, true);
        assertEquals(await composition.pluginHost.invoke("test.dynamic", { method: "ping" }), "alive");
        await composition.pluginHost.disable("test.dynamic");
        assertEquals(composition.toolPlugins(), []);
        await composition.close();
        composition = await loadBuiltinComposition({ configStore: new DenoKvConfigStore(kv), pluginRoot, env: () => undefined });
        assertEquals((await composition.pluginHost.get("test.dynamic"))?.enabled, false);
        assertEquals(composition.toolPlugins(), []);
        await composition.pluginHost.enable("test.dynamic");
        assertEquals(await composition.pluginHost.uninstall("test.dynamic"), true);
        assertEquals(composition.toolPlugins(), []);
        assertEquals(await composition.pluginHost.list(), []);
        const entries = [];
        for await (const entry of kv.list({ prefix: ["heimdall", "plugins"] })) entries.push(entry);
        assertEquals(entries, []);
    } finally {
        await composition.close(); kv.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("managed plugin rejects checksum, permissions, builtin identities and duplicate tools", async () => {
    const kv = await Deno.openKv(":memory:");
    const manager = createManagedPlugins(new DenoKvConfigStore(kv), () => [], () => ["reserved.plugin"]);
    try {
        const input = await packageInput();
        await assertRejects(() => manager.install({ ...input, code: input.code + " " }));
        await assertRejects(() => manager.install({ ...input, manifest: { ...input.manifest as object, permissions: { network: true } } }));
        await assertRejects(() => manager.install({ ...input, manifest: { ...input.manifest as object, id: "reserved.plugin" } }));
        assertEquals(await manager.host.list(), []);
        await manager.install(input);
        await manager.host.enable("test.dynamic");
        await manager.install(await packageInput("test.duplicate"));
        await assertRejects(() => manager.host.enable("test.duplicate"));
        assertEquals((await manager.host.get("test.duplicate"))?.enabled, false);
        assertEquals(manager.tools().length, 1);
    } finally { await manager.host.close?.(); kv.close(); }
});

Deno.test("restore quarantines a corrupted artifact while healthy plugins restart", async () => {
    const kv = await Deno.openKv(":memory:");
    const store = new DenoKvConfigStore(kv);
    let manager = createManagedPlugins(store, () => [], () => []);
    try {
        await manager.install(await packageInput("test.good", "good_tool"));
        await manager.install(await packageInput("test.corrupt", "corrupt_tool"));
        await manager.host.enable("test.good");
        await manager.host.enable("test.corrupt");
        await manager.host.close?.();
        for await (const entry of kv.list<Uint8Array>({ prefix: ["heimdall", "plugins", "artifacts", "test.corrupt"] })) {
            const bytes = new Uint8Array(entry.value);
            bytes[0] = (bytes[0] ?? 0) ^ 1;
            await kv.set(entry.key, bytes);
            break;
        }
        manager = createManagedPlugins(store, () => [], () => []);
        await manager.host.restore?.();
        assertEquals((await manager.host.get("test.good"))?.enabled, true);
        assertEquals((await manager.host.get("test.corrupt"))?.enabled, false);
        assertEquals(manager.tools().map((plugin) => plugin.manifest.id), ["test.good"]);
    } finally { await manager.host.close?.(); kv.close(); }
});
