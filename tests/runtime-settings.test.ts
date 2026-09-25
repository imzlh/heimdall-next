import { assertEquals, assertRejects } from "@std/assert";
import { SourceRegistry } from "@heimdall/kernel";
import { StorageConflictError } from "@heimdall/storage";
import { createServer } from "../main.ts";
import {
    createRuntimeSettings,
    hydrateRuntimeSettings,
    saveRuntimeSettings,
} from "@heimdall/core/composition/runtime-settings.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";

Deno.test("gateway follows runtime settings without recreating the server", async () => {
    const settings = createRuntimeSettings({
        proxyKey: "first-key",
        limitPerMinute: 0,
        probeIntervalMs: 0,
    });
    const app = createServer({
        gateway: { settings: () => settings.get() },
    });
    assertEquals(
        (await app.request("http://localhost/v1/models")).status,
        401,
    );
    settings.replace({
        proxyKey: "",
        limitPerMinute: 1,
        probeIntervalMs: 0,
    }, "");
    assertEquals(
        (await app.request("http://localhost/v1/models", {
            headers: { authorization: "Bearer first-key" },
        })).status,
        200,
    );
    assertEquals(
        (await app.request("http://localhost/v1/models")).status,
        429,
    );
});

Deno.test("runtime settings persist without returning the proxy key", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-settings-" });
    const kv = await Deno.openKv(`${directory}/settings.sqlite3`);
    try {
        const store = new DenoKvConfigStore(kv);
        const settings = createRuntimeSettings({
            proxyKey: "env-key",
            limitPerMinute: 120,
            probeIntervalMs: 300_000,
        });
        const saved = await saveRuntimeSettings(store, settings, {
            proxyKey: "stored-key",
            limitPerMinute: 15,
        });
        assertEquals(saved.settings, {
            proxyKeyConfigured: true,
            limitPerMinute: 15,
            probeIntervalMs: 300_000,
        });
        assertEquals(JSON.stringify(saved).includes("stored-key"), false);
        assertEquals(settings.get().proxyKey, "stored-key");

        const restarted = createRuntimeSettings({
            proxyKey: "env-key",
            limitPerMinute: 120,
            probeIntervalMs: 300_000,
        });
        await hydrateRuntimeSettings(store, restarted);
        assertEquals(restarted.get().limitPerMinute, 15);
        assertEquals(restarted.get().proxyKey, "stored-key");

        await assertRejects(
            () =>
                saveRuntimeSettings(
                    store,
                    restarted,
                    { limitPerMinute: 1 },
                    "stale",
                ),
            StorageConflictError,
        );
        await assertRejects(
            () =>
                saveRuntimeSettings(
                    store,
                    restarted,
                    { limitPerMinute: 7.5 },
                    restarted.versionstamp(),
                ),
            TypeError,
        );
    } finally {
        kv.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("anthropic-version selects the Anthropic model list shape", async () => {
    const registry = new SourceRegistry();
    registry.register({
        id: "claude",
        capabilities: [{
            operation: "generation.create",
            models: ["claude-a"],
            streaming: true,
        }],
        execute() {
            return (async function* () {})();
        },
    });
    const app = createServer({ sourceRegistry: registry });
    const openai = await (await app.request("http://localhost/v1/models"))
        .json();
    assertEquals(openai.object, "list");
    assertEquals(openai.data[0].id, "claude-a");

    const anthropic = await (await app.request("http://localhost/v1/models", {
        headers: { "anthropic-version": "2023-06-01" },
    })).json();
    assertEquals(anthropic.data, [{
        id: "claude-a",
        type: "model",
        display_name: "claude-a",
        created_at: "1970-01-01T00:00:00Z",
    }]);
    assertEquals(anthropic.has_more, false);
    assertEquals(anthropic.first_id, "claude-a");
    assertEquals(anthropic.last_id, "claude-a");
});
