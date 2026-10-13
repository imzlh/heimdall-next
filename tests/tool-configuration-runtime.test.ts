import { assert, assertEquals, assertRejects } from "@std/assert";
import type {
    JsonValue,
    PluginManifest,
    ToolPlugin,
    ToolPluginFactory,
} from "@heimdall/contracts";
import { type ConfigStore, StorageConflictError } from "@heimdall/storage";
import { computePluginArtifactDigest } from "@heimdall/plugin-host";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";
import { ToolConfigurations } from "@heimdall/core/composition/tool-configuration.ts";
import {
    createManagedPlugins,
    type ManagedPluginPackage,
} from "@heimdall/core/composition/managed-plugins.ts";
import {
    createChatToolset,
    newRunBudget,
} from "@heimdall/core/chat/tools/toolset.ts";

const manifest: PluginManifest = {
    id: "test.configurable",
    name: "Configurable fixture",
    kind: "tool",
    trust: "trusted",
    apiVersion: "1",
    version: "1.0.0",
    configSchema: {
        version: 1,
        id: "test.configurable",
        fields: [
            { type: "string", name: "name", label: "Name", required: true },
            { type: "secret", name: "secret", label: "Secret" },
        ],
    },
};

const factory: ToolPluginFactory = {
    manifest,
    validateConfig(input) {
        const value = input as Record<string, JsonValue>;
        if (typeof value.name !== "string") {
            throw new TypeError("name is required");
        }
        return value;
    },
    redactConfig(config) {
        const { secret: _secret, ...publicConfig } = config as Record<
            string,
            JsonValue
        >;
        return publicConfig;
    },
    mergeConfig(input, previous) {
        return {
            ...(previous as Record<string, JsonValue> | undefined),
            ...(input as Record<string, JsonValue>),
        };
    },
    create({ config }) {
        const value = config as Record<string, JsonValue> | undefined;
        if (value?.name === "broken") throw new Error("Cannot create plugin");
        const name = String(value?.name ?? "initial");
        return {
            manifest,
            tools: [{
                definition: {
                    name,
                    description: "fixture",
                    inputSchema: { type: "object" },
                },
                execute: () => ({
                    text: String(value?.secret ?? "initial"),
                    isError: false,
                }),
            }],
        };
    },
};

function pausedWrites(
    store: ConfigStore,
    beforeWrite: () => Promise<void>,
): ConfigStore {
    return {
        namespace: (...path) =>
            pausedWrites(store.namespace(...path), beforeWrite),
        get: (key) => store.get(key),
        list: (key) => store.list(key),
        delete: (key, revision) => store.delete(key, revision),
        async set(key, value, options) {
            await beforeWrite();
            return await store.set(key, value, options);
        },
    };
}

async function packageInput(name: string): Promise<ManagedPluginPackage> {
    const code = `export function invoke(method) {
        if (method === "tools.list") return [{name:${
        JSON.stringify(name)
    },description:"fixture",inputSchema:{type:"object"}}];
        return {text:"managed",isError:false};
    }`;
    return {
        format: "heimdall-plugin/v1",
        manifest: {
            id: "test.managed-config",
            name: "Managed fixture",
            kind: "tool",
            trust: "isolated",
            version: "1.0.0",
            apiVersion: "1",
        },
        code,
        digest: await computePluginArtifactDigest(
            new TextEncoder().encode(code),
        ),
        entrypoint: "plugin.js",
    };
}

Deno.test("tool configuration rejects malformed or foreign form schemas before advertising configuration", async () => {
    using kv = await Deno.openKv(":memory:");
    const configuration = new ToolConfigurations(
        new DenoKvConfigStore(kv),
        () => undefined,
        new Map(),
        new Map(),
        () => {},
    );
    const invalidSchemas: NonNullable<PluginManifest["configSchema"]>[] = [
        { type: "object", properties: { name: { type: "string" } } },
        { version: 2, id: manifest.id, fields: [] },
        { version: 1, id: "another.plugin", fields: [] },
        {
            version: 1,
            id: manifest.id,
            fields: [{ type: "executable", name: "name", label: "Name" }],
        },
    ];
    for (const schema of invalidSchemas) {
        const invalid = { ...manifest, configSchema: schema };
        await assertRejects(
            () =>
                configuration.load({ ...factory, manifest: invalid }, invalid),
            TypeError,
        );
        assertEquals(configuration.canConfigure(manifest.id), false);
        await assertRejects(() => configuration.get(manifest.id));
    }
});

Deno.test("tool configuration returns a detached copy of the validated declared form schema", async () => {
    using kv = await Deno.openKv(":memory:");
    const plugins = new Map<string, ToolPlugin>();
    const configuration = new ToolConfigurations(
        new DenoKvConfigStore(kv),
        () => undefined,
        plugins,
        new Map(),
        () => {},
    );
    const schema = {
        version: 1,
        id: manifest.id,
        fields: [{ type: "string", name: "name", label: "Name" }],
    };
    const declared = { ...manifest, configSchema: schema };
    const expected = structuredClone(schema);
    const implementation = {
        ...factory,
        manifest: { ...manifest, configSchema: { different: true } },
    };
    plugins.set(
        manifest.id,
        await configuration.load(implementation, declared),
    );
    schema.fields[0]!.label = "Changed after registration";
    const initial = await configuration.get(manifest.id);
    assertEquals(initial.configSchema, expected);
    const saved = await configuration.save(
        manifest.id,
        { name: "updated" },
        null,
    );
    assertEquals(saved.configSchema, expected);
    assertEquals((await configuration.get(manifest.id)).configSchema, expected);
});

Deno.test("tool configuration redacts management snapshots and publishes only after successful validation and CAS", async () => {
    using kv = await Deno.openKv(":memory:");
    const store = new DenoKvConfigStore(kv);
    const plugins = new Map<string, ToolPlugin>();
    const configuration = new ToolConfigurations(
        store,
        () => undefined,
        plugins,
        new Map(),
        () => {},
    );
    plugins.set(manifest.id, await configuration.load(factory, manifest));
    const original = createChatToolset([...plugins.values()]);
    const input = { name: "configured", secret: "private-value" };
    const saved = await configuration.save(manifest.id, input, null);
    assertEquals(saved.config, { name: "configured" });
    assertEquals((await configuration.get(manifest.id)).config, saved.config);
    assertEquals(
        (await store.namespace("heimdall", "tool-config").get<
            { config: unknown }
        >([manifest.id]))?.value.config,
        input,
    );
    input.secret = "changed-outside";
    const execute = (
        tools: ReturnType<typeof createChatToolset>,
        name: string,
    ) => tools.run(
        { callId: "call", name, argumentsText: "{}" },
        newRunBudget(),
        new AbortController().signal,
    );
    assertEquals((await execute(original, "initial")).text, "initial");
    assertEquals(
        (await execute(createChatToolset([...plugins.values()]), "configured"))
            .text,
        "private-value",
    );
    await assertRejects(
        () =>
            configuration.save(manifest.id, { name: "broken" }, saved.revision),
        TypeError,
    );
    await assertRejects(
        () => configuration.save(manifest.id, { name: "another" }, null),
        StorageConflictError,
    );
    assertEquals(await configuration.get(manifest.id), saved);
    assertEquals(
        plugins.get(manifest.id)?.tools[0]?.definition.name,
        "configured",
    );

    const results = await Promise.allSettled([
        configuration.save(manifest.id, { name: "winner" }, saved.revision),
        configuration.save(manifest.id, { name: "loser" }, saved.revision),
    ]);
    assertEquals(results.map((result) => result.status), [
        "fulfilled",
        "rejected",
    ]);
    assertEquals(plugins.get(manifest.id)?.tools[0]?.definition.name, "winner");
    assertEquals(
        (await execute(createChatToolset([...plugins.values()]), "winner"))
            .text,
        "private-value",
    );
    const winner = await configuration.get(manifest.id);
    assertEquals(winner.config, { name: "winner" });
    await configuration.save(
        manifest.id,
        { name: "cleared", secret: "" },
        winner.revision,
    );
    assertEquals(
        (await execute(createChatToolset([...plugins.values()]), "cleared"))
            .text,
        "",
    );
});

Deno.test("tool configuration reserves staged names against managed enable and rejects active managed collisions", async () => {
    using kv = await Deno.openKv(":memory:");
    const store = new DenoKvConfigStore(kv);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const plugins = new Map<string, ToolPlugin>();
    const configuration = new ToolConfigurations(
        pausedWrites(store, async () => {
            entered.resolve();
            await release.promise;
        }),
        () => undefined,
        plugins,
        new Map(),
        (plugin) => managed.assertToolsAvailable(plugin),
    );
    const managed = createManagedPlugins(
        store,
        () => configuration.registeredTools(),
        () => [manifest.id],
    );
    try {
        plugins.set(manifest.id, await configuration.load(factory, manifest));
        await managed.install(await packageInput("next"));
        const saving = configuration.save(manifest.id, { name: "next" }, null);
        await entered.promise;
        assertEquals(
            configuration.registeredTools().flatMap((plugin) =>
                plugin.tools.map((tool) => tool.definition.name)
            ).sort(),
            ["initial", "next"],
        );
        assertEquals(
            plugins.get(manifest.id)?.tools[0]?.definition.name,
            "initial",
        );
        await assertRejects(() => managed.host.enable("test.managed-config"));
        assertEquals(managed.tools(), []);
        release.resolve();
        const saved = await saving;
        const renamed = await configuration.save(manifest.id, {
            name: "renamed",
        }, saved.revision);
        await managed.host.enable("test.managed-config");
        assertEquals(managed.tools().length, 1);
        await assertRejects(
            () =>
                configuration.save(
                    manifest.id,
                    { name: "next" },
                    renamed.revision,
                ),
            TypeError,
        );
        assertEquals(await configuration.get(manifest.id), renamed);
        assertEquals(
            plugins.get(manifest.id)?.tools[0]?.definition.name,
            "renamed",
        );
        assert(
            configuration.registeredTools().every((plugin) =>
                plugin.tools.every((tool) => tool.definition.name !== "next")
            ),
        );
    } finally {
        release.resolve();
        await managed.host.close?.();
    }
});
