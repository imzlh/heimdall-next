import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ResolvedSourceProxy } from "@heimdall/contracts";
import type { ConfigStore, WriteOptions } from "@heimdall/storage";
import { StorageConflictError } from "@heimdall/storage";
import { loadBuiltinComposition } from "@heimdall/core/composition/builtins.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";
import type { StoredSourceConfig } from "@heimdall/core/composition/source-records.ts";

const pluginId = "test.source.proxy-observer";
const context = {
    request: new Request("http://localhost/admin/sources"),
    requestId: "source-proxy-test",
};
const office = {
    id: "office",
    name: "Office",
    url: "http://127.0.0.1:7890/",
    enabled: true,
    basicAuth: {
        username: "private-proxy-user",
        password: "private-proxy-pass",
    },
};
const backup = {
    id: "backup",
    name: "Backup",
    url: "http://127.0.0.1:7891/",
    enabled: true,
};

async function setup() {
    const resources = new AsyncDisposableStack();
    const root = await Deno.makeTempDir({ prefix: "heimdall-source-proxy-" });
    resources.defer(() => Deno.remove(root, { recursive: true }));
    const kv = await Deno.openKv(`${root}/config.sqlite3`);
    resources.defer(() => kv.close());
    const rawStore = new DenoKvConfigStore(kv);
    let beforeWrite:
        | ((value: unknown, options?: WriteOptions) => Promise<void>)
        | undefined;
    const wrap = (store: ConfigStore): ConfigStore => ({
        namespace: (...path) => wrap(store.namespace(...path)),
        get: (...args) => store.get(...args),
        set: async (key, value, options) => {
            await beforeWrite?.(value, options);
            return await store.set(key, value, options);
        },
        delete: (...args) => store.delete(...args),
        list: (...args) => store.list(...args),
    });
    const manifest = {
        id: pluginId,
        version: "1.0.0",
        apiVersion: "1",
        name: "Proxy observer",
        kind: "source",
        trust: "trusted",
        capabilities: ["generation.create"],
    };
    await Deno.mkdir(`${root}/plugins/observer`, { recursive: true });
    await Deno.writeTextFile(
        `${root}/plugins/observer/manifest.json`,
        JSON.stringify(manifest),
    );
    // The fixture deliberately decides whether to read the optional host hook.
    // Its diagnostic probe is only called directly by this test, never over HTTP.
    await Deno.writeTextFile(
        `${root}/plugins/observer/mod.ts`,
        `
export const sourcePlugin = {
    manifest: ${JSON.stringify(manifest)},
    validate: (config) => config,
    create: (config, options) => ({
        id: config.id,
        capabilities: [{ operation: "generation.create", streaming: true }],
        async *execute() {},
        probe: async () => ({
            ok: true,
            message: JSON.stringify(config.ignoreProxy ? { pluginOwned: true } : options?.getProxy?.()),
        }),
    }),
};
`,
    );
    const load = async () => {
        const composition = await loadBuiltinComposition({
            configStore: wrap(rawStore),
            pluginRoot: new URL(
                `file:///${root.replaceAll("\\", "/")}/plugins/`,
            ),
            env: () => undefined,
        });
        resources.defer(() => composition.close());
        const create = async (
            proxy?: { mode: "inherit" | "direct" } | {
                mode: "proxy";
                proxyId: string;
            },
            ignoreProxy = false,
        ) => {
            const id = crypto.randomUUID();
            const result = await composition.management.createSource!(context, {
                id,
                name: "Channel",
                priority: 0,
                sourcePluginId: pluginId,
                config: { apiKey: "private-source-key", ignoreProxy },
                ...(proxy ? { proxy } : {}),
            });
            return { id, version: result.versionstamp! };
        };
        const selected = async (id: string): Promise<ResolvedSourceProxy> => {
            const result = await composition.sources.get(id)!.probe!(
                new AbortController().signal,
            );
            return JSON.parse(result.message);
        };
        const list = async () => {
            const provider = composition.catalog.sources;
            return typeof provider === "function"
                ? await provider(context)
                : provider ?? [];
        };
        return { composition, create, selected, list };
    };
    return {
        resources,
        store: rawStore,
        load,
        ...await load(),
        beforeWrite: (hook?: typeof beforeWrite) => {
            beforeWrite = hook;
        },
    };
}

Deno.test("source proxy preferences stay live without recreating active plugin instances", async () => {
    const originalFetch = globalThis.fetch;
    const fixture = await setup();
    await using _resources = fixture.resources;
    const { composition, create, selected, list } = fixture;
    const saved = await composition.management.saveProxies!(context, {
        defaultProxyId: "office",
        entries: [office, backup],
    });
    const inherited = await create();
    const direct = await create({ mode: "direct" });
    const explicit = await create({ mode: "proxy", proxyId: "office" });
    const active = composition.sources.get(inherited.id);
    const first = await selected(inherited.id);
    assert(first.mode === "proxy");
    assertEquals(first.proxy.basicAuth, office.basicAuth);
    assertEquals(first.selectedBy, "global");
    await composition.management.saveProxies!(context, {
        defaultProxyId: "backup",
        entries: [office, backup],
    }, saved.versionstamp);
    assertEquals(composition.sources.get(inherited.id), active);
    const inheritedAfter = await selected(inherited.id);
    assert(inheritedAfter.mode === "proxy");
    assertEquals(inheritedAfter.proxy.id, "backup");
    assertEquals(await selected(direct.id), {
        mode: "direct",
        selectedBy: "source",
    });
    const explicitAfter = await selected(explicit.id);
    assert(explicitAfter.mode === "proxy");
    assertEquals(explicitAfter.proxy.id, "office");
    const updated = await composition.management.updateSource!(
        context,
        inherited.id,
        {
            proxy: { mode: "direct" },
        },
        inherited.version,
    );
    assertEquals(composition.sources.get(inherited.id), active);
    assertEquals(await selected(inherited.id), {
        mode: "direct",
        selectedBy: "source",
    });
    const projection = JSON.stringify({ catalog: await list(), updated });
    for (
        const secret of [
            office.basicAuth.username,
            office.basicAuth.password,
            "private-source-key",
            office.url,
        ]
    ) {
        assert(!projection.includes(secret));
    }
    assertEquals(globalThis.fetch, originalFetch);
});

Deno.test("source proxy changes and deletion only affect runtime after a successful durable write", async () => {
    const fixture = await setup();
    await using _resources = fixture.resources;
    const { composition, create, selected, store } = fixture;
    await composition.management.saveProxies!(context, {
        defaultProxyId: "office",
        entries: [office],
    });
    const source = await create();
    const active = composition.sources.get(source.id);
    const original = await selected(source.id);
    const durable = await store.namespace("heimdall", "source-config").get([
        source.id,
    ]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.beforeWrite(async () => {
        entered.resolve();
        await release.promise;
    });
    const update = composition.management.updateSource!(context, source.id, {
        proxy: { mode: "direct" },
    }, source.version);
    await entered.promise;
    assertEquals(await selected(source.id), original);
    assertEquals(
        await store.namespace("heimdall", "source-config").get([source.id]),
        durable,
    );
    release.resolve();
    const saved = await update;
    fixture.beforeWrite();
    assertEquals(await selected(source.id), {
        mode: "direct",
        selectedBy: "source",
    });
    await assertRejects(
        async () =>
            await composition.management.updateSource!(context, source.id, {
                proxy: { mode: "proxy", proxyId: "office" },
            }, source.version),
        StorageConflictError,
    );
    assertEquals(composition.sources.get(source.id), active);
    assertEquals(await selected(source.id), {
        mode: "direct",
        selectedBy: "source",
    });
    await assertRejects(
        async () =>
            await composition.management.deleteSource!(
                context,
                source.id,
                source.version,
            ),
        StorageConflictError,
    );
    assertEquals(composition.sources.get(source.id), active);
    fixture.beforeWrite(() => Promise.reject(new Error("storage offline")));
    await assertRejects(
        async () =>
            await composition.management.updateSource!(context, source.id, {
                proxy: { mode: "inherit" },
            }, saved.versionstamp),
        Error,
        "storage offline",
    );
    fixture.beforeWrite();
    assertEquals(await selected(source.id), {
        mode: "direct",
        selectedBy: "source",
    });
    await composition.management.deleteSource!(
        context,
        source.id,
        saved.versionstamp,
    );
    assertEquals(composition.sources.get(source.id), undefined);
    const tombstone = await store.namespace("heimdall", "source-config").get<
        StoredSourceConfig
    >([source.id]);
    assertEquals(tombstone?.value.deleted, true);
    assertEquals(tombstone?.value.proxy, undefined);
});

Deno.test("source proxy selection survives provider config edits, plugin toggles and composition restart", async () => {
    const fixture = await setup();
    await using _resources = fixture.resources;
    const { composition, create, store } = fixture;
    await composition.management.saveProxies!(context, {
        defaultProxyId: "backup",
        entries: [office, backup],
    });
    const source = await create({ mode: "proxy", proxyId: "office" });
    const edited = await composition.management.saveSourceConfig!(
        context,
        source.id,
        { endpoint: "updated" },
        source.version,
    );
    const record = await store.namespace("heimdall", "source-config").get<
        StoredSourceConfig
    >([source.id]);
    assertEquals(record?.value.proxy, { mode: "proxy", proxyId: "office" });
    assertEquals(
        (record?.value.config as Record<string, unknown>).apiKey,
        "private-source-key",
    );
    await composition.management.setPluginEnabled!(context, pluginId, false);
    assertEquals(composition.sources.get(source.id), undefined);
    await composition.management.setPluginEnabled!(context, pluginId, true);
    const afterToggle = await fixture.selected(source.id);
    assert(afterToggle.mode === "proxy");
    assertEquals(afterToggle.proxy.id, "office");
    const restarted = await fixture.load();
    assertEquals(await restarted.selected(source.id), afterToggle);
    assertEquals(
        (await restarted.list()).find((item) => item.id === source.id)?.proxy,
        { mode: "proxy", proxyId: "office" },
    );
    assert(edited.versionstamp !== source.version);
});

Deno.test("unavailable proxy is explicit and a plugin remains free to ignore the host preference", async () => {
    const originalFetch = globalThis.fetch;
    const fixture = await setup();
    await using _resources = fixture.resources;
    const { composition, create, selected } = fixture;
    const saved = await composition.management.saveProxies!(context, {
        defaultProxyId: "office",
        entries: [office],
    });
    const source = await create({ mode: "proxy", proxyId: "office" });
    const independent = await create(
        { mode: "proxy", proxyId: "office" },
        true,
    );
    const disabled = await composition.management.saveProxies!(context, {
        defaultProxyId: null,
        entries: [{ ...office, enabled: false }],
    }, saved.versionstamp);
    assertEquals(await selected(source.id), {
        mode: "unavailable",
        selectedBy: "source",
        proxyId: "office",
        reason: "disabled",
    });
    await composition.management.updateSource!(context, source.id, {
        name: "Renamed",
    }, source.version);
    await assertRejects(
        () => create({ mode: "proxy", proxyId: "office" }),
        TypeError,
        "selected proxy is unavailable",
    );
    await composition.management.saveProxies!(context, {
        defaultProxyId: null,
        entries: [],
    }, disabled.versionstamp);
    assertEquals(await selected(source.id), {
        mode: "unavailable",
        selectedBy: "source",
        proxyId: "office",
        reason: "missing",
    });
    assertEquals(await selected(independent.id) as unknown, {
        pluginOwned: true,
    });
    assertEquals(globalThis.fetch, originalFetch);
});
