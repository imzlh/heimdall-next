import { assertEquals, assertRejects } from "@std/assert";
import { computePluginArtifactDigest } from "@heimdall/plugin-host";
import { DenoKvConfigStore } from "../src/storage/deno-kv.ts";
import { ConfigPluginRecordStore } from "../src/storage/plugin-records.ts";
import {
    createManagedPlugins,
    type ManagedPluginPackage,
} from "../src/composition/managed-plugins.ts";
import { loadBuiltinComposition } from "../src/composition/builtins.ts";
import { createChatToolset, newRunBudget } from "../src/chat/tools/toolset.ts";

async function packageInput(
    id = "test.dynamic",
    name = "dynamic_echo",
): Promise<ManagedPluginPackage> {
    const code = `export function invoke(method, payload) {
        if (method === "tools.list") return [{ name: "${name}", description: "隔离回声工具", inputSchema: { type: "object" } }];
        if (method === "tools.execute") return { text: "动态：" + payload.argumentsText, isError: false };
        return "alive";
    }\n/*${"offline bundle ".repeat(6000)}*/`;
    return {
        format: "heimdall-plugin/v1",
        manifest: {
            id,
            name: "动态插件",
            version: "1.0.0",
            apiVersion: "1",
            kind: "tool",
            trust: "isolated",
        },
        entrypoint: "plugin.js",
        code,
        digest: await computePluginArtifactDigest(
            new TextEncoder().encode(code),
        ),
    };
}

Deno.test("managed plugin installs offline, joins Chat tools, survives restart, disables and uninstalls", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-managed-" });
    const path = `${directory}/plugins.sqlite3`;
    let kv = await Deno.openKv(path);
    const pluginRoot = new URL("./missing-plugin-directory/", import.meta.url);
    let composition = await loadBuiltinComposition({
        configStore: new DenoKvConfigStore(kv),
        pluginRoot,
        env: () => undefined,
    });
    const input = await packageInput();
    try {
        const manager = createManagedPlugins(
            new DenoKvConfigStore(kv),
            () => [],
            () => [],
        );
        await manager.install(input);
        // The same composition can activate packages installed through its durable store.
        await composition.pluginHost.enable("test.dynamic");
        assertEquals(
            composition.toolPlugins().map((plugin) => plugin.manifest.id),
            ["test.dynamic"],
        );
        const tools = createChatToolset(composition.toolPlugins());
        assertEquals(
            await tools.run(
                {
                    callId: "call-1",
                    name: "dynamic_echo",
                    argumentsText: "hello",
                },
                newRunBudget(),
                new AbortController().signal,
            ),
            { text: "动态：hello", isError: false },
        );
        await composition.close();
        kv.close();
        kv = await Deno.openKv(path);
        composition = await loadBuiltinComposition({
            configStore: new DenoKvConfigStore(kv),
            pluginRoot,
            env: () => undefined,
        });
        assertEquals(
            (await composition.pluginHost.get("test.dynamic"))?.enabled,
            true,
        );
        assertEquals(
            await composition.pluginHost.invoke("test.dynamic", {
                method: "ping",
            }),
            "alive",
        );
        await composition.pluginHost.disable("test.dynamic");
        assertEquals(composition.toolPlugins(), []);
        await composition.close();
        composition = await loadBuiltinComposition({
            configStore: new DenoKvConfigStore(kv),
            pluginRoot,
            env: () => undefined,
        });
        assertEquals(
            (await composition.pluginHost.get("test.dynamic"))?.enabled,
            false,
        );
        assertEquals(composition.toolPlugins(), []);
        await composition.pluginHost.enable("test.dynamic");
        assertEquals(
            await composition.pluginHost.uninstall("test.dynamic"),
            true,
        );
        assertEquals(composition.toolPlugins(), []);
        assertEquals(await composition.pluginHost.list(), []);
        const entries = [];
        for await (
            const entry of kv.list({ prefix: ["heimdall", "plugins"] })
        ) entries.push(entry);
        assertEquals(entries, []);
    } finally {
        await composition.close();
        kv.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("managed plugin rejects checksum, permissions, builtin identities and duplicate tools", async () => {
    const kv = await Deno.openKv(":memory:");
    const manager = createManagedPlugins(
        new DenoKvConfigStore(kv),
        () => [],
        () => ["reserved.plugin"],
    );
    try {
        const input = await packageInput();
        await assertRejects(() =>
            manager.install({ ...input, code: input.code + " " })
        );
        await assertRejects(() =>
            manager.install({
                ...input,
                manifest: {
                    ...input.manifest as object,
                    permissions: { network: true },
                },
            })
        );
        await assertRejects(() =>
            manager.install({
                ...input,
                manifest: {
                    ...input.manifest as object,
                    id: "reserved.plugin",
                },
            })
        );
        assertEquals(await manager.host.list(), []);
        await manager.install(input);
        await manager.host.enable("test.dynamic");
        await manager.install(await packageInput("test.duplicate"));
        await assertRejects(() => manager.host.enable("test.duplicate"));
        assertEquals(
            (await manager.host.get("test.duplicate"))?.enabled,
            false,
        );
        assertEquals(manager.tools().length, 1);
    } finally {
        await manager.host.close?.();
        kv.close();
    }
});

Deno.test("restore quarantines a corrupted artifact while healthy plugins restart", async () => {
    const kv = await Deno.openKv(":memory:");
    const store = new DenoKvConfigStore(kv);
    let manager = createManagedPlugins(store, () => [], () => []);
    try {
        await manager.install(await packageInput("test.good", "good_tool"));
        await manager.install(
            await packageInput("test.corrupt", "corrupt_tool"),
        );
        await manager.host.enable("test.good");
        await manager.host.enable("test.corrupt");
        await manager.host.close?.();
        for await (
            const entry of kv.list<Uint8Array>({
                prefix: ["heimdall", "plugins", "artifacts", "test.corrupt"],
            })
        ) {
            const bytes = new Uint8Array(entry.value);
            bytes[0] = (bytes[0] ?? 0) ^ 1;
            await kv.set(entry.key, bytes);
            break;
        }
        manager = createManagedPlugins(store, () => [], () => []);
        await manager.host.restore?.();
        assertEquals((await manager.host.get("test.good"))?.enabled, true);
        assertEquals((await manager.host.get("test.corrupt"))?.enabled, false);
        assertEquals(manager.tools().map((plugin) => plugin.manifest.id), [
            "test.good",
        ]);
    } finally {
        await manager.host.close?.();
        kv.close();
    }
});

Deno.test("managed restore starts dependencies first and quarantines broken branches", async () => {
    const kv = await Deno.openKv(":memory:");
    const store = new DenoKvConfigStore(kv);
    let manager = createManagedPlugins(store, () => [], () => []);
    try {
        const child = await packageInput("aaa.child", "child_tool");
        await manager.install({
            ...child,
            manifest: {
                ...child.manifest as object,
                dependencies: ["zzz.base"],
            },
        });
        await manager.install(await packageInput("zzz.base", "base_tool"));
        await manager.install(
            await packageInput("test.healthy", "healthy_tool"),
        );
        await manager.host.enable("zzz.base");
        await manager.host.enable("aaa.child");
        await manager.host.enable("test.healthy");
        await manager.host.close?.();
        manager = createManagedPlugins(store, () => [], () => []);
        await manager.host.restore?.();
        assertEquals(manager.tools().map((plugin) => plugin.manifest.id), [
            "zzz.base",
            "aaa.child",
            "test.healthy",
        ]);
        await manager.host.close?.();
        for await (
            const entry of kv.list({
                prefix: ["heimdall", "plugins", "artifacts", "zzz.base"],
            })
        ) {
            await kv.delete(entry.key);
            break;
        }
        manager = createManagedPlugins(store, () => [], () => []);
        await manager.host.restore?.();
        assertEquals(manager.tools().map((plugin) => plugin.manifest.id), [
            "test.healthy",
        ]);
        assertEquals(
            (await manager.host.get("aaa.child"))?.lastError?.includes(
                "zzz.base",
            ),
            true,
        );
        assertEquals((await manager.host.get("zzz.base"))?.enabled, false);
    } finally {
        await manager.host.close?.();
        kv.close();
    }
});

Deno.test("managed tools receive only JSON request identity and honor external builtin dependencies", async () => {
    const kv = await Deno.openKv(":memory:");
    let builtinEnabled = false;
    const external = {
        id: "builtin.clock",
        name: "Clock",
        version: "1.0.0",
        apiVersion: "1" as const,
        kind: "tool" as const,
        trust: "trusted" as const,
    };
    const manager = createManagedPlugins(
        new DenoKvConfigStore(kv),
        () => [],
        () => [external.id],
        () => [{ manifest: external, enabled: builtinEnabled }],
    );
    const code = `export function invoke(method, payload, context) {
        if (method === "tools.list") return [{name:"identity_tool", description:"identity", inputSchema:{type:"object"}}];
        return {text:JSON.stringify(context.request), isError:false};
    }`;
    try {
        const input = await packageInput("test.identity");
        await manager.install({
            ...input,
            code,
            digest: await computePluginArtifactDigest(
                new TextEncoder().encode(code),
            ),
            manifest: {
                ...input.manifest as object,
                dependencies: [external.id],
            },
        });
        await assertRejects(
            () => manager.host.enable("test.identity"),
            Error,
            external.id,
        );
        builtinEnabled = true;
        await manager.host.enable("test.identity");
        const request = {
            requestId: "request-1",
            metadata: {
                conversationId: "conversation-1",
                sessionId: "conversation-1",
                traceId: "trace-1",
            },
        };
        const tool = manager.tools()[0]!.tools[0]!;
        const outcome = await tool.execute({
            callId: "call-1",
            name: "identity_tool",
            argumentsText: "{}",
        }, {
            signal: new AbortController().signal,
            budget: newRunBudget(),
            request,
        });
        assertEquals(JSON.parse(outcome.text), request);
    } finally {
        await manager.host.close?.();
        kv.close();
    }
});

Deno.test("restore quarantines persisted dependency cycles without blocking healthy plugins", async () => {
    const kv = await Deno.openKv(":memory:");
    const manager = createManagedPlugins(
        new DenoKvConfigStore(kv),
        () => [],
        () => [],
    );
    try {
        for (
            const [id, dependency] of [["cycle.one", "cycle.two"], [
                "cycle.two",
                "cycle.one",
            ]]
        ) {
            const input = await packageInput(id, id!.replace(".", "_"));
            await manager.install({
                ...input,
                manifest: {
                    ...input.manifest as object,
                    dependencies: [dependency],
                },
            });
            const key = ["heimdall", "plugins", id!];
            const saved = await kv.get<Record<string, unknown>>(key);
            await kv.set(key, { ...saved.value, enabled: true });
        }
        await manager.install(
            await packageInput("test.healthy", "healthy_tool"),
        );
        await manager.host.enable("test.healthy");
        await manager.host.restore?.();
        assertEquals(manager.tools().map((plugin) => plugin.manifest.id), [
            "test.healthy",
        ]);
        assertEquals((await manager.host.get("cycle.one"))?.enabled, false);
        assertEquals((await manager.host.get("cycle.two"))?.enabled, false);
    } finally {
        await manager.host.close?.();
        kv.close();
    }
});

Deno.test("worker failure revokes Chat tools and persists disabled state without a management read", async () => {
    const kv = await Deno.openKv(":memory:");
    const store = new DenoKvConfigStore(kv);
    const records = new ConfigPluginRecordStore(store);
    const manager = createManagedPlugins(store, () => [], () => []);
    const input = await packageInput();
    const code = `export function invoke(method) {
        if (method === "tools.list") return [{name:"closing_tool", description:"close", inputSchema:{type:"object"}}];
        setTimeout(() => self.close(), 10);
        return "scheduled";
    }`;
    try {
        await manager.install({
            ...input,
            code,
            digest: await computePluginArtifactDigest(
                new TextEncoder().encode(code),
            ),
        });
        await manager.host.enable("test.dynamic");
        assertEquals(manager.tools().length, 1);
        const child = await packageInput("test.child", "child_tool");
        await manager.install({
            ...child,
            manifest: {
                ...child.manifest as object,
                dependencies: ["test.dynamic"],
            },
        });
        await manager.host.enable("test.child");
        await manager.install(
            await packageInput("test.independent", "independent_tool"),
        );
        await manager.host.enable("test.independent");
        await manager.host.invoke("test.dynamic", { method: "close" });
        // Inspect the durable port directly: host.get/list must not be needed
        // to discover the failure or unregister the advertised tools.
        for (let attempt = 0; attempt < 200; attempt++) {
            if (
                !(await records.get("test.dynamic"))?.enabled &&
                !(await records.get("test.child"))?.enabled
            ) break;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assertEquals(manager.tools().map((plugin) => plugin.manifest.id), [
            "test.independent",
        ]);
        const saved = await records.get("test.dynamic");
        assertEquals(saved?.enabled, false);
        assertEquals(
            saved?.lastError,
            "runtime_failed: plugin worker closed unexpectedly",
        );
        const dependent = await records.get("test.child");
        assertEquals(dependent?.enabled, false);
        assertEquals(
            dependent?.lastError,
            "runtime_failed: dependency_unavailable: plugin test.dynamic runtime failed",
        );
        assertEquals((await records.get("test.independent"))?.enabled, true);
        assertEquals(
            await manager.host.invoke("test.independent", { method: "ping" }),
            "alive",
        );
    } finally {
        await manager.host.close?.();
        kv.close();
    }
});
