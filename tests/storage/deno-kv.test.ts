import { assertEquals, assertRejects } from "@std/assert";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";
import { ConfigPluginRecordStore } from "@heimdall/core/storage/plugin-records.ts";
import { StorageConflictError } from "@heimdall/storage";

Deno.test("Deno KV config store namespaces and enforces version checks", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-kv-" });
    const path = `${directory}/config.sqlite3`;
    const kv = await Deno.openKv(path);
    try {
        const store = new DenoKvConfigStore(kv).namespace("config");
        assertEquals(await store.get(["source"]), null);
        const first = await store.set(["source"], { enabled: true });
        assertEquals(
            (await store.get<{ enabled: boolean }>(["source"]))?.value,
            {
                enabled: true,
            },
        );
        await assertRejects(
            () =>
                store.set(["source"], { enabled: false }, {
                    expectedVersionstamp: "stale",
                }),
            StorageConflictError,
        );
        const second = await store.set(["source"], { enabled: false }, {
            expectedVersionstamp: first,
        });
        assertEquals(second !== first, true);
        const entries = [];
        for await (const entry of store.list()) entries.push(entry);
        assertEquals(entries.length, 1);
        await store.delete(["source"], second);
        assertEquals(await store.get(["source"]), null);
    } finally {
        kv.close();
        await Deno.remove(directory, { recursive: true }).catch(() =>
            undefined
        );
    }
});

Deno.test("PluginHost records persist in a namespaced KV store", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-plugin-kv-" });
    const kv = await Deno.openKv(`${directory}/plugins.sqlite3`);
    try {
        const records = new ConfigPluginRecordStore(new DenoKvConfigStore(kv));
        const makeRecord = (id: string) => ({
            manifest: {
                id,
                version: "1.0.0",
                apiVersion: "1" as const,
                name: id,
                kind: "api" as const,
                trust: "isolated" as const,
            },
            enabled: false,
            isolated: true,
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        await records.put(makeRecord("zeta.plugin"));
        await records.put(makeRecord("alpha.plugin"));
        assertEquals(
            (await records.get("alpha.plugin"))?.manifest.id,
            "alpha.plugin",
        );
        assertEquals(
            (await records.list()).map((record) => record.manifest.id),
            ["alpha.plugin", "zeta.plugin"],
        );
        await records.delete("alpha.plugin");
        assertEquals(await records.get("alpha.plugin"), undefined);
        await assertRejects(
            () => records.get("../escape"),
            TypeError,
        );
    } finally {
        kv.close();
        await Deno.remove(directory, { recursive: true }).catch(() =>
            undefined
        );
    }
});
