import { assertEquals } from "@std/assert";
import { loadBuiltinComposition } from "@heimdall/core/composition/builtins.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";

Deno.test("builtin composition does not import untrusted directory plugins", async () => {
    const root = await Deno.makeTempDir({ prefix: "heimdall-plugin-root-" });
    try {
        const directory = `${root}/unsafe-plugin`;
        await Deno.mkdir(directory);
        await Deno.writeTextFile(
            `${directory}/manifest.json`,
            JSON.stringify({
                id: "example.untrusted",
                version: "1.0.0",
                apiVersion: "1",
                name: "Untrusted",
                kind: "protocol",
                trust: "isolated",
                routes: [],
            }),
        );
        await Deno.writeTextFile(
            `${directory}/mod.ts`,
            "throw new Error('untrusted module imported');",
        );

        const composition = await loadBuiltinComposition({
            pluginRoot: new URL(`file:///${root.replaceAll("\\", "/")}/`),
        });
        const provider = composition.catalog.plugins;
        const plugins = typeof provider === "function"
            ? await provider({
                request: new Request("http://localhost"),
                requestId: "test",
            })
            : provider;
        assertEquals(composition.protocols, []);
        assertEquals(plugins?.[0]?.id, "example.untrusted");
        assertEquals(plugins?.[0]?.enabled, false);
        assertEquals(
            plugins?.[0]?.lastError,
            "untrusted plugins must be installed through PluginHost",
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("source plugin lifecycle state survives composition restart", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-lifecycle-" });
    const kv = await Deno.openKv(`${directory}/state.sqlite3`);
    const context = {
        request: new Request("http://localhost"),
        requestId: "lifecycle-test",
    };
    try {
        const first = await loadBuiltinComposition({
            configStore: new DenoKvConfigStore(kv),
            pluginRoot: new URL("../plugins/", import.meta.url),
            env: () => undefined,
        });
        const saved = await first.management.saveSourceConfig?.(
            context,
            "openai-compatible",
            { baseUrl: "https://upstream.example/v1" },
        );
        assertEquals(first.sources.list().length, 1);
        await first.management.setPluginEnabled?.(
            context,
            "heimdall.source.openai-compatible",
            false,
        );
        assertEquals(first.sources.list(), []);
        const firstPluginProvider = first.catalog.plugins;
        const firstPlugins = typeof firstPluginProvider === "function"
            ? await firstPluginProvider(context)
            : firstPluginProvider ?? [];
        assertEquals(
            firstPlugins?.find((plugin) =>
                plugin.id === "heimdall.source.openai-compatible"
            )?.enabled,
            false,
        );
        const firstSourceProvider = first.catalog.sources;
        const firstSources = typeof firstSourceProvider === "function"
            ? await firstSourceProvider(context)
            : firstSourceProvider ?? [];
        assertEquals(firstSources, [{
            id: "openai-compatible",
            sourcePluginId: "heimdall.source.openai-compatible",
            enabled: false,
            instanceEnabled: true,
            pluginEnabled: false,
            proxy: { mode: "inherit" },
            proxySummary: { mode: "direct", selectedBy: "global" },
            versionstamp: saved?.versionstamp,
            models: [],
            capabilities: [
                "generation.create",
                "completion.create",
                "embedding.create",
                "image.generate",
                "image.edit",
            ],
        }]);
        await first.close();

        const second = await loadBuiltinComposition({
            configStore: new DenoKvConfigStore(kv),
            pluginRoot: new URL("../plugins/", import.meta.url),
            env: () => undefined,
        });
        assertEquals(second.sources.list(), []);
        const secondPluginProvider = second.catalog.plugins;
        const secondPlugins = typeof secondPluginProvider === "function"
            ? await secondPluginProvider(context)
            : secondPluginProvider ?? [];
        assertEquals(
            secondPlugins?.find((plugin) =>
                plugin.id === "heimdall.source.openai-compatible"
            )?.enabled,
            false,
        );
        await second.management.setPluginEnabled?.(
            context,
            "heimdall.source.openai-compatible",
            true,
        );
        assertEquals(second.sources.list().length, 1);
        await second.close();
    } finally {
        kv.close();
        await Deno.remove(directory, { recursive: true }).catch(() =>
            undefined
        );
    }
});
