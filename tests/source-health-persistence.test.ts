import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { loadBuiltinComposition } from "../src/composition/builtins.ts";
import { DenoKvConfigStore } from "../src/storage/deno-kv.ts";
import { createServerApp } from "../src/http/app.ts";
import { SourceHealthPersistence } from "../src/composition/source-health-runtime.ts";
import { SourceRegistry } from "@heimdall/kernel";
import type {
    ConfigStore,
    StorageKey,
    StorageKeyPart,
    StoredEntry,
    VersionedValue,
    WriteOptions,
} from "@heimdall/storage";
import type { StoredSourceConfig } from "../src/composition/source-records.ts";

const id = "594a356b-307c-4c6b-a8c9-11dc28de5678";
const context = {
    request: new Request("http://localhost/admin/sources"),
    requestId: "health-policy",
};
const record = {
    sourcePluginId: "heimdall.source.openai-compatible",
    config: { id, baseUrl: "https://health.example/v1" },
    enabled: true,
    instanceStateVersion: 1,
} as const;

Deno.test("source health metadata survives CAS and disk reopen; cooldown restores until an explicit durable reset", async () => {
    await using resources = new AsyncDisposableStack();
    const directory = await Deno.makeTempDir({ prefix: "heimdall-health-" });
    resources.defer(() => Deno.remove(directory, { recursive: true }));
    let kv = await Deno.openKv(`${directory}/config.sqlite`);
    let composition = await loadBuiltinComposition({
        configStore: new DenoKvConfigStore(kv),
        env: () => undefined,
    });
    resources.defer(() => kv.close());
    resources.defer(() => composition.close());
    const create = await composition.management.createSource!(context, {
        id,
        name: "独立健康策略",
        priority: 0,
        ...record,
        healthPolicy: { cooldownMs: 120_000, authCooldownMs: 600_000 },
    });
    assertEquals(composition.sources.healthPolicy(id), {
        cooldownMs: 120_000,
        authCooldownMs: 600_000,
    });
    composition.sources.recordProbe(id, {
        ok: false,
        message: "provider detail never persisted",
    });
    const before = composition.sources.healthSnapshot(id);
    assertExists(before.cooldown);
    assertEquals(
        Date.parse(before.cooldown.until) -
            Date.parse(before.cooldown.startedAt),
        120_000,
    );
    const changed = await composition.management.updateSource!(context, id, {
        healthPolicy: { cooldownMs: 0 },
    }, create.versionstamp);
    assertEquals(
        composition.sources.healthSnapshot(id),
        before,
        "Changing policy preserves the active deadline",
    );
    await assertRejects(() =>
        Promise.resolve(
            composition.management.updateSource!(context, id, {
                healthPolicy: null,
            }, create.versionstamp),
        )
    );
    assertEquals(composition.sources.healthPolicy(id).cooldownMs, 0);
    await composition.close();
    kv.close();
    kv = await Deno.openKv(`${directory}/config.sqlite`);
    const store = new DenoKvConfigStore(kv);
    composition = await loadBuiltinComposition({
        configStore: store,
        env: () => undefined,
    });
    assertEquals(composition.sources.healthSnapshot(id), before);
    assertEquals(composition.sources.healthPolicy(id).cooldownMs, 0);
    const persisted = await store.namespace("heimdall", "source-health").get([
        id,
    ]);
    assert(persisted && !JSON.stringify(persisted).includes("provider detail"));
    const app = createServerApp({
        adminCatalog: composition.catalog,
        adminManagement: composition.management,
    });
    const reset = await app.request("/admin/source-health/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId: id }),
    });
    assertEquals(reset.status, 200, await reset.clone().text());
    assertEquals(
        await store.namespace("heimdall", "source-health").get([id]),
        null,
    );
    composition.sources.recordProbe(id, {
        ok: false,
        message: "no cooldown selected",
    });
    assertEquals(composition.sources.healthOf(id), "ready");
    await composition.management.updateSource!(context, id, {
        healthPolicy: null,
    }, changed.versionstamp);
    assertEquals(composition.sources.healthPolicy(id), {
        cooldownMs: 30_000,
        authCooldownMs: 300_000,
    });
    await composition.close();
    kv.close();
    kv = await Deno.openKv(`${directory}/config.sqlite`);
    composition = await loadBuiltinComposition({
        configStore: new DenoKvConfigStore(kv),
        env: () => undefined,
    });
    assertEquals(composition.sources.healthOf(id), "ready");
});

Deno.test("cooldowns from previous credentials, expired records and corrupt policies cannot poison healthy source restoration", async () => {
    await using resources = new AsyncDisposableStack();
    const kv = await Deno.openKv(":memory:");
    resources.defer(() => kv.close());
    const store = new DenoKvConfigStore(kv);
    const configs = store.namespace("heimdall", "source-config");
    await configs.set([id], record);
    let composition = await loadBuiltinComposition({
        configStore: store,
        env: () => undefined,
    });
    resources.defer(() => composition.close());
    composition.sources.recordProbe(id, { ok: false, message: "failure" });
    await composition.close();
    const scope = store.namespace("heimdall", "source-health");
    const saved = await scope.get([id]);
    assertExists(saved);
    await configs.set([id], {
        ...record,
        config: { ...record.config, apiKey: "new-secret" },
    });
    composition = await loadBuiltinComposition({
        configStore: store,
        env: () => undefined,
    });
    assertEquals(composition.sources.healthOf(id), "ready");
    assertEquals(await scope.get([id]), null);
    await composition.close();
    await configs.set(["broken"], {
        ...record,
        config: { ...record.config, id: "broken" },
        healthPolicy: { cooldownMs: -1 },
    });
    composition = await loadBuiltinComposition({
        configStore: store,
        env: () => undefined,
    });
    assertExists(composition.sources.get(id));
    assertEquals(composition.sources.get("broken"), undefined);
    const app = createServerApp({
        adminCatalog: composition.catalog,
        adminManagement: composition.management,
    });
    const listed = await (await app.request("/admin/sources")).json();
    assertEquals(
        listed.sources.find((item: { id: string }) => item.id === "broken")
            .configurationErrorField,
        "healthPolicy",
    );
    const repaired = await app.request("/admin/sources?id=broken", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ healthPolicy: null }),
    });
    assertEquals(repaired.status, 200, await repaired.clone().text());
    assertExists(composition.sources.get("broken"));
    const invalid = await app.request(`/admin/sources?id=${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ healthPolicy: { cooldownMs: -1 } }),
    });
    assertEquals(invalid.status, 400);
});

/** Observe the real storage write queue while deterministically delaying/failing writes. */
class ControlledStore implements ConfigStore {
    constructor(
        readonly inner: ConfigStore,
        readonly control: { gate?: Promise<void>; fail?: boolean },
        readonly path: readonly StorageKeyPart[] = [],
    ) {}
    namespace(...path: StorageKeyPart[]): ConfigStore {
        return new ControlledStore(
            this.inner.namespace(...path),
            this.control,
            [...this.path, ...path],
        );
    }
    get<T>(key?: StorageKey): Promise<VersionedValue<T> | null> {
        return this.inner.get<T>(key);
    }
    list<T>(key?: StorageKey): AsyncIterable<StoredEntry<T>> {
        return this.inner.list<T>(key);
    }
    async set<T>(
        key: StorageKey,
        value: T,
        options?: WriteOptions,
    ): Promise<string> {
        if (this.path.includes("source-health")) {
            await this.control.gate;
            if (this.control.fail) throw new Error("storage unavailable");
        }
        return this.inner.set(key, value, options);
    }
    async delete(key: StorageKey, version?: string | null): Promise<void> {
        if (this.path.includes("source-health")) {
            await this.control.gate;
            if (this.control.fail) throw new Error("storage unavailable");
        }
        return this.inner.delete(key, version);
    }
}

Deno.test("health persistence orders pending failure then manual reset and reports failed durable writes until retry", async () => {
    using kv = await Deno.openKv(":memory:");
    const control: { gate?: Promise<void>; fail?: boolean } = {};
    const store = new ControlledStore(new DenoKvConfigStore(kv), control);
    await store.namespace("heimdall", "source-config").set<StoredSourceConfig>([
        id,
    ], record);
    const sources = new SourceRegistry();
    sources.register({
        id,
        capabilities: [{ operation: "generation.create", streaming: false }],
        execute: async function* () {},
    });
    const persistence = new SourceHealthPersistence(store, sources);
    await persistence.restore();
    const gate = Promise.withResolvers<void>();
    control.gate = gate.promise;
    sources.recordProbe(id, { ok: false, message: "delayed" });
    sources.clearCooldown(id);
    gate.resolve();
    await persistence.flush();
    assertEquals(
        await store.namespace("heimdall", "source-health").get([id]),
        null,
    );
    control.fail = true;
    sources.recordProbe(id, { ok: false, message: "write fails" });
    await assertRejects(() => persistence.flush(), Error, "尚未持久化");
    control.fail = false;
    sources.clearCooldown(id);
    await persistence.flush();
    assertEquals(
        await store.namespace("heimdall", "source-health").get([id]),
        null,
    );
    await persistence.close();
});
