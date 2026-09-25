import { assertEquals, assertExists } from "@std/assert";
import { loadBuiltinComposition } from "@heimdall/core/composition/builtins.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";

Deno.test("UI source ownership follows presets, disabled sources, and restarts", async () => {
    await using resources = new AsyncDisposableStack();
    const kv = await Deno.openKv(":memory:");
    resources.defer(() => kv.close());
    const options = {
        configStore: new DenoKvConfigStore(kv),
        pluginRoot: new URL("../plugins/", import.meta.url),
        env: () => undefined,
    };
    const composition = await loadBuiltinComposition(options);
    resources.defer(() => composition.close());
    const ownership = composition.sourcePluginIds;
    assertEquals(await ownership(), {});

    const context = {
        request: new Request("http://localhost"),
        requestId: "ui-source-ownership",
    };
    const { applyPreset, saveSourceConfig, setPluginEnabled } =
        composition.management;
    assertExists(applyPreset);
    assertExists(saveSourceConfig);
    assertExists(setPluginEnabled);
    await applyPreset(context, "heimdall.preset.newapi", {
        id: "custom-production",
        baseUrl: "https://upstream.example/v1",
        apiKey: "private-upstream-key",
    });
    await saveSourceConfig(context, "anthropic", {
        baseUrl: "https://anthropic.example",
        apiKey: "private-anthropic-key",
    });

    const expected = {
        "custom-production": "heimdall.source.openai-compatible",
        anthropic: "heimdall.source.anthropic",
    };
    // The same callback sees new records and returns identifiers only.
    assertEquals(await ownership(), expected);
    await setPluginEnabled(
        context,
        "heimdall.source.openai-compatible",
        false,
    );
    assertEquals(composition.sources.get("custom-production"), undefined);
    assertEquals(await ownership(), expected);

    const restarted = await loadBuiltinComposition(options);
    resources.defer(() => restarted.close());
    assertEquals(await restarted.sourcePluginIds(), expected);
});

Deno.test("UI source ownership uses configured environment source ids", async () => {
    const values: Record<string, string> = {
        HEIMDALL_OPENAI_BASE_URL: "https://openai.example/v1",
        HEIMDALL_OPENAI_SOURCE_ID: "regional-gateway",
        HEIMDALL_ANTHROPIC_API_KEY: "private-anthropic-key",
        HEIMDALL_ANTHROPIC_SOURCE_ID: "reasoning-service",
    };
    const composition = await loadBuiltinComposition({
        env: (name) => values[name],
    });
    try {
        assertEquals(await composition.sourcePluginIds(), {
            "regional-gateway": "heimdall.source.openai-compatible",
            "reasoning-service": "heimdall.source.anthropic",
        });
    } finally {
        await composition.close();
    }
});
