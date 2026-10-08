import { assert, assertEquals, assertRejects } from "@std/assert";
import { computePluginArtifactDigest } from "@heimdall/plugin-host";
import {
    createManagedPlugins,
    type ManagedPluginPackage,
} from "../src/composition/managed-plugins.ts";
import { loadRuntimeUiContributions } from "../src/composition/ui-contributions.ts";
import { DenoKvConfigStore } from "../src/storage/deno-kv.ts";
import { ConfigPluginRecordStore } from "../src/storage/plugin-records.ts";
import {
    type ConfigStore,
    StorageConflictError,
    type StorageKey,
} from "@heimdall/storage";

const id = "test.real-upgrade";
async function packageInput(
    version: string,
    broken = false,
): Promise<ManagedPluginPackage> {
    const code = broken
        ? `export function invoke() { throw new Error("broken tools.list"); }`
        : `export function invoke(method) { if (method === "tools.list") return [{name:"version_${
            version.replaceAll(".", "_")
        }",description:"Version ${version}",inputSchema:{type:"object"}}]; return {text:"${version}",isError:false}; }`;
    return {
        format: "heimdall-plugin/v1",
        entrypoint: "plugin.js",
        code,
        digest: await computePluginArtifactDigest(
            new TextEncoder().encode(code),
        ),
        manifest: {
            id,
            name: `版本 ${version}`,
            version,
            apiVersion: "1",
            kind: "tool",
            trust: "isolated",
            ui: [{
                pluginId: id,
                id: `version-${version}`,
                slot: "chat.sidebar",
                title: `版本 ${version}`,
                schema: { blocks: [{ kind: "text", text: version }] },
            }],
        },
    };
}

function intercept(
    store: ConfigStore,
    beforeWrite: (path: StorageKey) => Promise<void>,
    prefix: StorageKey = [],
): ConfigStore {
    return {
        namespace: (...path) =>
            intercept(store.namespace(...path), beforeWrite, [
                ...prefix,
                ...path,
            ]),
        get: (...args) => store.get(...args),
        list: (...args) => store.list(...args),
        delete: (...args) => store.delete(...args),
        async set(path, value, options) {
            await beforeWrite([...prefix, ...path]);
            return await store.set(path, value, options);
        },
    };
}

Deno.test("real worker upgrade, restart and rollback replace tool definitions and Chat declarations without stale contributions", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-upgrade-" });
    const path = `${directory}/plugins.sqlite3`;
    let kv = await Deno.openKv(path);
    let manager = createManagedPlugins(
        new DenoKvConfigStore(kv),
        () => [],
        () => [],
    );
    const uiOptions = {
        pluginRoot: new URL("./missing-upgrade-plugins/", import.meta.url),
        env: () => undefined,
    };
    try {
        await manager.install(await packageInput("1.0.0"));
        const enabled = await manager.host.enable(id);
        const v2 = await manager.upgrade(
            id,
            await packageInput("2.0.0"),
            enabled.revision!,
        );
        assertEquals(v2.enabled, true);
        assertEquals(v2.rollback?.version, "1.0.0");
        assertEquals(
            manager.tools().flatMap((plugin) =>
                plugin.tools.map((tool) => tool.definition.name)
            ),
            ["version_2_0_0"],
        );
        assertEquals(
            (await loadRuntimeUiContributions(manager.host, uiOptions)).map((
                entry,
            ) => entry.title),
            ["版本 2.0.0"],
        );
        assertEquals(
            await manager.host.invoke(id, { method: "tools.execute" }),
            { text: "2.0.0", isError: false },
        );
        await manager.host.close?.();
        kv.close();
        kv = await Deno.openKv(path);
        manager = createManagedPlugins(
            new DenoKvConfigStore(kv),
            () => [],
            () => [],
        );
        await manager.host.restore?.();
        const current = (await manager.host.get(id))!;
        assertEquals(current.manifest.version, "2.0.0");
        assertEquals(current.rollback?.version, "1.0.0");
        await assertRejects(() => manager.host.rollback!(id, v2.revision!)); // restart changes the revision
        const restored = await manager.host.rollback!(id, current.revision!);
        assertEquals(restored.enabled, true);
        assertEquals(restored.rollback, undefined);
        assertEquals(
            manager.tools().flatMap((plugin) =>
                plugin.tools.map((tool) => tool.definition.name)
            ),
            ["version_1_0_0"],
        );
        assertEquals(
            (await loadRuntimeUiContributions(manager.host, uiOptions)).map((
                entry,
            ) => entry.title),
            ["版本 1.0.0"],
        );
        assertEquals(
            await manager.host.invoke(id, { method: "tools.execute" }),
            { text: "1.0.0", isError: false },
        );
        await manager.host.close?.();
        manager = createManagedPlugins(
            new DenoKvConfigStore(kv),
            () => [],
            () => [],
        );
        await manager.host.restore?.();
        assertEquals((await manager.host.get(id))?.manifest.version, "1.0.0");
        await manager.host.uninstall(id);
        const keys = [];
        for await (
            const entry of kv.list({ prefix: ["heimdall", "plugins"] })
        ) keys.push(entry.key);
        assertEquals(keys, []);
    } finally {
        await manager.host.close?.();
        kv.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("broken worker upgrade and interrupted chunk writes restore old executable tools and durable metadata", async () => {
    using kv = await Deno.openKv(":memory:");
    let failWrite = false;
    const store = intercept(new DenoKvConfigStore(kv), (path) => {
        if (failWrite && path.includes("artifacts")) {
            return Promise.reject(new Error("disk full"));
        }
        return Promise.resolve();
    });
    const manager = createManagedPlugins(store, () => [], () => []);
    try {
        await manager.install(await packageInput("1.0.0"));
        const previous = await manager.host.enable(id);
        await assertRejects(() =>
            manager.upgrade(id, broken, previous.revision!)
        );
        assertEquals(await manager.host.get(id), previous);
        assertEquals(
            await manager.host.invoke(id, { method: "tools.execute" }),
            { text: "1.0.0", isError: false },
        );
        failWrite = true;
        await assertRejects(
            () => manager.upgrade(id, second, previous.revision!),
            Error,
            "disk full",
        );
        assertEquals(await manager.host.get(id), previous);
        assertEquals(manager.tools()[0]?.manifest.version, "1.0.0");
        const generations = new Set();
        for await (
            const entry of kv.list({
                prefix: ["heimdall", "plugins", "artifacts", id],
            })
        ) generations.add(entry.key[4]);
        assertEquals(generations.size, 1);
    } finally {
        failWrite = false;
        await manager.host.close?.();
    }
});

const broken = await packageInput("2.0.0", true);
const second = await packageInput("2.0.0");

Deno.test("durable CAS conflict leaves concurrent disabled metadata untouched and removes candidate registrations", async () => {
    using kv = await Deno.openKv(":memory:");
    const plain = new ConfigPluginRecordStore(new DenoKvConfigStore(kv));
    let conflicting = false;
    let concurrentRevision: string | undefined;
    const store = intercept(new DenoKvConfigStore(kv), async (path) => {
        if (conflicting && path.length === 3 && path.at(-1) === id) {
            conflicting = false;
            const current = (await plain.get(id))!;
            await plain.put({
                ...current,
                enabled: false,
                lastError: "another operator disabled this plugin",
            });
            concurrentRevision = (await plain.get(id))!.revision;
        }
    });
    const manager = createManagedPlugins(store, () => [], () => []);
    try {
        await manager.install(await packageInput("1.0.0"));
        const current = await manager.host.enable(id);
        conflicting = true;
        await assertRejects(
            () => manager.upgrade(id, second, current.revision!),
            StorageConflictError,
        );
        const latest = (await plain.get(id))!;
        assertEquals(latest.revision, concurrentRevision);
        assertEquals(latest.enabled, false);
        assertEquals(latest.manifest.version, "1.0.0");
        assertEquals(manager.tools(), []);
        assertEquals((await plain.readArtifact(id))!.manifest.version, "1.0.0");
        assertEquals(await plain.readRollbackArtifact(id), undefined);
    } finally {
        await manager.host.close?.();
    }
});

Deno.test("corrupted rollback bytes cannot replace the healthy current worker", async () => {
    using kv = await Deno.openKv(":memory:");
    const manager = createManagedPlugins(
        new DenoKvConfigStore(kv),
        () => [],
        () => [],
    );
    try {
        await manager.install(await packageInput("1.0.0"));
        const old = await manager.host.enable(id);
        const current = await manager.upgrade(id, second, old.revision!);
        const saved = await kv.get<{ previous: { artifact: { key: string } } }>(
            ["heimdall", "plugins", id],
        );
        assert(saved.value);
        const key = [
            "heimdall",
            "plugins",
            "artifacts",
            id,
            saved.value.previous.artifact.key,
            0,
        ];
        const chunk = await kv.get<Uint8Array>(key);
        assert(chunk.value);
        chunk.value[0] = (chunk.value[0] ?? 0) ^ 1;
        await kv.set(key, chunk.value);
        await assertRejects(() =>
            manager.host.rollback!(id, current.revision!)
        );
        assertEquals((await manager.host.get(id))?.manifest.version, "2.0.0");
        assertEquals(manager.tools()[0]?.manifest.version, "2.0.0");
        assertEquals(
            await manager.host.invoke(id, { method: "tools.execute" }),
            { text: "2.0.0", isError: false },
        );
    } finally {
        await manager.host.close?.();
    }
});

Deno.test("replacement reserves old and staged tool names against concurrent enables until recovery completes", async () => {
    using kv = await Deno.openKv(":memory:");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let block = false;
    const manager = createManagedPlugins(
        intercept(new DenoKvConfigStore(kv), async (path) => {
            if (block && path.length === 3 && path.at(-1) === id) {
                block = false;
                entered.resolve();
                await release.promise;
                throw new Error("replacement commit failed");
            }
        }),
        () => [],
        () => [],
    );
    try {
        const first = await packageInput("1.0.0");
        await manager.install(first);
        for (
            const [contender, input] of [["test.claim-old", first], [
                "test.claim-new",
                second,
            ]] as const
        ) {
            await manager.install({
                ...input,
                manifest: {
                    ...input.manifest as object,
                    id: contender,
                    ui: [],
                },
            });
        }
        const previous = await manager.host.enable(id);
        block = true;
        const upgrading = assertRejects(
            () => manager.upgrade(id, second, previous.revision!),
            Error,
            "replacement commit failed",
        );
        await entered.promise;
        assertEquals(manager.tools(), []);
        await assertRejects(() => manager.host.enable("test.claim-old"));
        await assertRejects(() => manager.host.enable("test.claim-new"));
        release.resolve();
        await upgrading;
        assertEquals(manager.tools().map((plugin) => plugin.manifest.id), [id]);
        assertEquals(
            await manager.host.invoke(id, { method: "tools.execute" }),
            { text: "1.0.0", isError: false },
        );
        await manager.host.enable("test.claim-new");
        assertEquals(manager.tools().length, 2);
    } finally {
        release.resolve();
        await manager.host.close?.();
    }
});
