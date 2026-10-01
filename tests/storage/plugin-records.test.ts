import { assertEquals, assertRejects } from "@std/assert";
import {
    computePluginArtifactDigest,
    type PluginArtifact,
    type PluginRecord,
} from "@heimdall/plugin-host";
import {
    type ConfigStore,
    StorageConflictError,
    type StorageKey,
} from "@heimdall/storage";
import { DenoKvConfigStore } from "../../src/storage/deno-kv.ts";
import { ConfigPluginRecordStore } from "../../src/storage/plugin-records.ts";

async function fixture() {
    const manifest = {
        id: "test.durable",
        name: "Durable",
        version: "1.0.0",
        apiVersion: "1" as const,
        kind: "tool" as const,
        trust: "isolated" as const,
    };
    const bytes = new Uint8Array(100_000).fill(42);
    const digest = await computePluginArtifactDigest(bytes);
    const record: PluginRecord = {
        manifest,
        enabled: false,
        isolated: true,
        digest,
        updatedAt: "2026-09-29T00:00:00Z",
    };
    const artifact: PluginArtifact = {
        manifest,
        entrypoint: "plugin.js",
        bytes,
        digest,
    };
    return { record, artifact };
}

function intercept(
    store: ConfigStore,
    hooks: {
        set?(path: StorageKey): void;
        deleted?(path: StorageKey): Promise<void>;
    },
    prefix: StorageKey = [],
): ConfigStore {
    return {
        namespace: (...path) =>
            intercept(store.namespace(...path), hooks, [...prefix, ...path]),
        get: (...args) => store.get(...args),
        list: (...args) => store.list(...args),
        set: (path, value, options) => {
            hooks.set?.([...prefix, ...path]);
            return store.set(path, value, options);
        },
        async delete(path, revision) {
            await store.delete(path, revision);
            await hooks.deleted?.([...prefix, ...path]);
        },
    };
}

Deno.test("durable plugin revisions reject stale update/delete without losing package bytes", async () => {
    const kv = await Deno.openKv(":memory:");
    try {
        const records = new ConfigPluginRecordStore(new DenoKvConfigStore(kv));
        const { record, artifact } = await fixture();
        await records.install(record, artifact);
        const stale = (await records.get(record.manifest.id))!;
        await records.put({ ...stale, lastError: "current state" });
        await assertRejects(
            () => records.put({ ...stale, enabled: true }),
            StorageConflictError,
        );
        await assertRejects(
            () => records.delete(record.manifest.id, stale.revision),
            StorageConflictError,
        );
        assertEquals(
            (await records.get(record.manifest.id))?.lastError,
            "current state",
        );
        assertEquals(
            (await records.readArtifact(record.manifest.id))?.bytes,
            artifact.bytes,
        );
    } finally {
        kv.close();
    }
});

Deno.test("concurrent durable installs commit one complete generation and clean losing chunks", async () => {
    const kv = await Deno.openKv(":memory:");
    try {
        const first = new ConfigPluginRecordStore(new DenoKvConfigStore(kv));
        const second = new ConfigPluginRecordStore(new DenoKvConfigStore(kv));
        const { record, artifact } = await fixture();
        const results = await Promise.allSettled([
            first.install(record, artifact),
            second.install(record, artifact),
        ]);
        assertEquals(
            results.filter((result) => result.status === "fulfilled").length,
            1,
        );
        assertEquals(
            (await first.readArtifact(record.manifest.id))?.bytes,
            artifact.bytes,
        );
        const generations = new Set();
        for await (
            const entry of kv.list({
                prefix: [
                    "heimdall",
                    "plugins",
                    "artifacts",
                    record.manifest.id,
                ],
            })
        ) generations.add(entry.key[4]);
        assertEquals(generations.size, 1);
    } finally {
        kv.close();
    }
});

Deno.test("interrupted chunk writes never publish a partial installation", async () => {
    const kv = await Deno.openKv(":memory:");
    try {
        const store = intercept(new DenoKvConfigStore(kv), {
            set(path) {
                if (
                    path.includes("artifacts") && path.at(-1) === 1
                ) throw new Error("disk full");
            },
        });
        const records = new ConfigPluginRecordStore(store);
        const { record, artifact } = await fixture();
        await assertRejects(
            () => records.install(record, artifact),
            Error,
            "disk full",
        );
        assertEquals(await records.list(), []);
        const keys = [];
        for await (
            const entry of kv.list({ prefix: ["heimdall", "plugins"] })
        ) keys.push(entry.key);
        assertEquals(keys, []);
    } finally {
        kv.close();
    }
});

Deno.test("uninstall cleanup cannot delete a newly installed generation for the same id", async () => {
    const kv = await Deno.openKv(":memory:");
    try {
        const { record, artifact } = await fixture();
        const plain = new ConfigPluginRecordStore(new DenoKvConfigStore(kv));
        let replacement = false;
        const records = new ConfigPluginRecordStore(
            intercept(new DenoKvConfigStore(kv), {
                async deleted(path) {
                    if (
                        path.length === 3 && path[2] === record.manifest.id &&
                        !replacement
                    ) {
                        replacement = true;
                        await plain.install(record, artifact);
                    }
                },
            }),
        );
        await records.install(record, artifact);
        await records.delete(
            record.manifest.id,
            (await records.get(record.manifest.id))!.revision,
        );
        assertEquals(replacement, true);
        assertEquals(
            (await records.readArtifact(record.manifest.id))?.bytes,
            artifact.bytes,
        );
    } finally {
        kv.close();
    }
});
