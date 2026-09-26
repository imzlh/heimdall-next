import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { ProxyPoolInput } from "@heimdall/admin-contracts";
import type { ConfigStore } from "@heimdall/storage";
import { StorageConflictError } from "@heimdall/storage";
import {
    createProxyPool,
    parseSourceProxySelection,
    type ProxyPoolHandle,
} from "@heimdall/core/composition/proxy-pool.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";

const firstProxy = {
    id: "office",
    name: "办公室",
    url: "http://127.0.0.1:8080",
    enabled: true,
};
const secondProxy = {
    id: "backup",
    name: "备用代理",
    url: "socks5://127.0.0.1:1080",
    enabled: true,
};
const credentials = { username: "proxy-username", password: "proxy-password" };

async function withPool(
    run: (pool: ProxyPoolHandle, store: ConfigStore) => Promise<void>,
): Promise<void> {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-proxy-pool-",
    });
    const kv = await Deno.openKv(`${directory}/pool.sqlite3`);
    try {
        const store = new DenoKvConfigStore(kv);
        await run(await createProxyPool(store), store);
    } finally {
        kv.close();
        await Deno.remove(directory, { recursive: true });
    }
}

Deno.test("proxy pool starts direct and source overrides stay independent", async () => {
    await withPool(async (pool) => {
        assertEquals(pool.view(), {
            pool: { defaultProxyId: null, entries: [] },
            versionstamp: "",
        });
        assertEquals(pool.resolve(), { mode: "direct", selectedBy: "global" });
        assertEquals(pool.resolve({ mode: "direct" }), {
            mode: "direct",
            selectedBy: "source",
        });
        await pool.save({
            defaultProxyId: "office",
            entries: [firstProxy, secondProxy],
        });
        const inherited = pool.resolve();
        assert(inherited.mode === "proxy");
        assertEquals(inherited.selectedBy, "global");
        assertEquals(inherited.proxy.id, "office");
        assertEquals(pool.resolve({ mode: "inherit" }), inherited);
        assertEquals(pool.resolve({ mode: "direct" }), {
            mode: "direct",
            selectedBy: "source",
        });
        const explicit = pool.resolve({ mode: "proxy", proxyId: "backup" });
        assert(explicit.mode === "proxy");
        assertEquals(explicit.selectedBy, "source");
        assertEquals(explicit.proxy.id, "backup");
    });
});

Deno.test("proxy views redact auth while trusted resolution gets detached credentials", async () => {
    await withPool(async (pool) => {
        const input = {
            defaultProxyId: "office",
            entries: [{ ...firstProxy, basicAuth: { ...credentials } }],
        };
        const saved = await pool.save(input);
        assertEquals(saved.pool.entries[0], {
            ...firstProxy,
            url: "http://127.0.0.1:8080/",
            authConfigured: true,
        });
        const viewText = JSON.stringify(saved);
        assertEquals(viewText.includes(credentials.username), false);
        assertEquals(viewText.includes(credentials.password), false);
        const resolved = pool.resolve();
        assert(resolved.mode === "proxy");
        assertEquals(resolved.proxy.basicAuth, credentials);
        // Plugins and view consumers receive snapshots, not pool references.
        Reflect.set(resolved.proxy.basicAuth!, "password", "plugin-modified");
        Reflect.set(resolved.proxy, "url", "http://plugin.invalid/");
        Reflect.set(saved.pool.entries[0]!, "name", "view-modified");
        input.entries[0]!.basicAuth.password = "input-modified";
        input.entries[0]!.name = "input-modified";
        const again = pool.resolve();
        assert(again.mode === "proxy");
        assertEquals(again.proxy.basicAuth, credentials);
        assertEquals(again.proxy.name, firstProxy.name);
        assertEquals(again.proxy.url, "http://127.0.0.1:8080/");
    });
});

Deno.test("proxy credentials merge by stable ID and explicit null clears them", async () => {
    await withPool(async (pool) => {
        const saved = await pool.save({
            defaultProxyId: "office",
            entries: [{ ...firstProxy, basicAuth: credentials }, secondProxy],
        });
        const renamed = await pool.save({
            defaultProxyId: "office",
            entries: [secondProxy, { ...firstProxy, name: "重命名" }],
        }, saved.versionstamp);
        const retained = pool.resolve();
        assert(retained.mode === "proxy");
        assertEquals(retained.proxy.name, "重命名");
        assertEquals(retained.proxy.basicAuth, credentials);
        assertEquals(renamed.pool.entries[0]?.authConfigured, false);
        assertEquals(renamed.pool.entries[1]?.authConfigured, true);

        const changed = await pool.save({
            defaultProxyId: "office",
            entries: [{
                ...firstProxy,
                basicAuth: { username: "replacement", password: "" },
            }],
        }, renamed.versionstamp);
        const replacement = pool.resolve();
        assert(replacement.mode === "proxy");
        assertEquals(replacement.proxy.basicAuth, {
            username: "replacement",
            password: "",
        });

        const cleared = await pool.save({
            defaultProxyId: "office",
            entries: [{ ...firstProxy, basicAuth: null }],
        }, changed.versionstamp);
        const clean = pool.resolve();
        assert(clean.mode === "proxy");
        assertEquals(clean.proxy.basicAuth, undefined);
        assertEquals(cleared.pool.entries[0]?.authConfigured, false);
    });
});

Deno.test("deleted proxy credentials are not revived by later ID reuse", async () => {
    await withPool(async (pool, store) => {
        const saved = await pool.save({
            defaultProxyId: "office",
            entries: [{ ...firstProxy, basicAuth: credentials }],
        });
        const deleted = await pool.save(
            { defaultProxyId: null, entries: [] },
            saved.versionstamp,
        );
        const restarted = await createProxyPool(store);
        await restarted.save({
            defaultProxyId: "office",
            entries: [firstProxy],
        }, deleted.versionstamp);
        const resolved = restarted.resolve();
        assert(resolved.mode === "proxy");
        assertEquals(resolved.proxy.basicAuth, undefined);
    });
});

Deno.test("proxy pool and credentials survive reopening the KV file", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-proxy-restart-",
    });
    let kv = await Deno.openKv(`${directory}/pool.sqlite3`);
    try {
        const original = await createProxyPool(new DenoKvConfigStore(kv));
        const saved = await original.save({
            defaultProxyId: "office",
            entries: [{ ...firstProxy, basicAuth: credentials }],
        });
        kv.close();
        kv = await Deno.openKv(`${directory}/pool.sqlite3`);
        const restored = await createProxyPool(new DenoKvConfigStore(kv));
        assertEquals(restored.view(), saved);
        assertEquals(restored.resolve(), original.resolve());
    } finally {
        kv.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("source references become unavailable after disable or deletion without direct fallback", async () => {
    await withPool(async (pool) => {
        let saved = await pool.save({
            defaultProxyId: "office",
            entries: [firstProxy, secondProxy],
        });
        const selection = pool.validateSelection({
            mode: "proxy",
            proxyId: "office",
        });
        saved = await pool.save({
            defaultProxyId: "backup",
            entries: [{ ...firstProxy, enabled: false }, secondProxy],
        }, saved.versionstamp);
        assertEquals(pool.resolve(selection), {
            mode: "unavailable",
            selectedBy: "source",
            proxyId: "office",
            reason: "disabled",
        });
        assertThrows(() => pool.validateSelection(selection), TypeError);
        await pool.save({
            defaultProxyId: "backup",
            entries: [secondProxy],
        }, saved.versionstamp);
        assertEquals(pool.resolve(selection), {
            mode: "unavailable",
            selectedBy: "source",
            proxyId: "office",
            reason: "missing",
        });
        const inherited = pool.resolve();
        assert(inherited.mode === "proxy");
        assertEquals(inherited.proxy.id, "backup");
        assertThrows(() => pool.validateSelection(selection), TypeError);
        assertEquals(parseSourceProxySelection(selection), selection);
    });
});

Deno.test("proxy pool CAS requires the current token and rejected writes do not change memory", async () => {
    await withPool(async (pool) => {
        const initial = await pool.save({
            defaultProxyId: "office",
            entries: [firstProxy],
        }, "");
        for (const version of [undefined, "", "stale"]) {
            await assertRejects(
                () => pool.save({ defaultProxyId: null, entries: [] }, version),
                StorageConflictError,
            );
            assertEquals(pool.view(), initial);
        }
        const next = await pool.save({
            defaultProxyId: null,
            entries: [firstProxy],
        }, initial.versionstamp);
        assert(next.versionstamp !== initial.versionstamp);
        await assertRejects(
            () =>
                pool.save(
                    { defaultProxyId: null, entries: [] },
                    initial.versionstamp,
                ),
            StorageConflictError,
        );
        assertEquals(pool.view(), next);
    });
});

Deno.test("simultaneous pool writes have one winner and keep persisted and active state equal", async () => {
    await withPool(async (pool, store) => {
        const initial = await pool.save({ defaultProxyId: null, entries: [] });
        const outcomes = await Promise.allSettled([
            pool.save(
                { defaultProxyId: "office", entries: [firstProxy] },
                initial.versionstamp,
            ),
            pool.save(
                { defaultProxyId: "backup", entries: [secondProxy] },
                initial.versionstamp,
            ),
        ]);
        assertEquals(
            outcomes.filter((value) => value.status === "fulfilled").length,
            1,
        );
        const rejected = outcomes.find((value) => value.status === "rejected");
        assert(rejected?.status === "rejected");
        assert(rejected.reason instanceof StorageConflictError);
        assertEquals((await createProxyPool(store)).view(), pool.view());
    });
});

Deno.test("an independently loaded handle cannot overwrite a newer pool", async () => {
    await withPool(async (pool, store) => {
        const saved = await pool.save({
            defaultProxyId: "office",
            entries: [{ ...firstProxy, basicAuth: credentials }],
        });
        const stale = await createProxyPool(store);
        const newer = await pool.save({
            defaultProxyId: null,
            entries: [secondProxy],
        }, saved.versionstamp);
        await assertRejects(
            () =>
                stale.save(
                    { defaultProxyId: null, entries: [] },
                    saved.versionstamp,
                ),
            StorageConflictError,
        );
        assertEquals(stale.view(), saved);
        // A newer token cannot be applied to a handle's stale credential state.
        await assertRejects(
            () =>
                stale.save(
                    { defaultProxyId: null, entries: [] },
                    newer.versionstamp,
                ),
            StorageConflictError,
        );
        assertEquals((await createProxyPool(store)).view(), newer);
    });
});

function faultStore(
    store: ConfigStore,
    fail: () => "read" | "write" | undefined,
): ConfigStore {
    return {
        namespace: (...path) => faultStore(store.namespace(...path), fail),
        get: (...args) => {
            if (fail() === "read") {
                return Promise.reject(new Error(credentials.password));
            }
            return store.get(...args);
        },
        set: (...args) => {
            if (fail() === "write") {
                return Promise.reject(new Error(credentials.password));
            }
            return store.set(...args);
        },
        delete: (...args) => store.delete(...args),
        list: (...args) => store.list(...args),
    };
}

Deno.test("storage failures retain the active pool and sanitize backend errors", async () => {
    await withPool(async (_pool, store) => {
        let failure: "read" | "write" | undefined;
        const pool = await createProxyPool(faultStore(store, () => failure));
        const initial = await pool.save({
            defaultProxyId: "office",
            entries: [firstProxy],
        });
        failure = "write";
        const error = await assertRejects(
            () =>
                pool.save(
                    { defaultProxyId: null, entries: [] },
                    initial.versionstamp,
                ),
            Error,
            "proxy pool could not be saved",
        );
        assertEquals(String(error).includes(credentials.password), false);
        assertEquals(pool.view(), initial);
        failure = "read";
        const readError = await assertRejects(
            () => createProxyPool(faultStore(store, () => failure)),
            Error,
            "proxy pool storage is unavailable",
        );
        assertEquals(String(readError).includes(credentials.password), false);
    });
});

Deno.test("invalid persisted proxy data fails startup without exposing its content", async () => {
    await withPool(async (_pool, store) => {
        await store.namespace("heimdall", "proxy-pool").set(["pool"], {
            defaultProxyId: "office",
            entries: [{
                ...firstProxy,
                url: `http://user:${credentials.password}@localhost`,
            }],
        });
        const error = await assertRejects(
            () => createProxyPool(store),
            TypeError,
            "stored proxy pool is invalid",
        );
        assertEquals(String(error).includes(credentials.password), false);
    });
});

Deno.test("proxy pool validates protocols, authorities, identifiers and total storage size", async (t) => {
    await withPool(async (pool) => {
        const initial = pool.view();
        const invalidUrls = [
            "ftp://localhost:21",
            "file:///tmp/proxy",
            "http://user:password@localhost:8080",
            "http://@localhost:8080",
            "http://localhost:8080/path",
            "http://localhost:8080/path/..",
            "http://localhost:8080/?token=secret",
            "http://localhost:8080/?",
            "http://localhost:8080/#secret",
            "http://localhost:8080/#",
            "http://localhost:0",
            "socks5://localhost:99999",
            "socks5://localhost:abc",
            "http://localhost\\secret",
            "http://local\nhost:8080",
            " http://localhost:8080",
            "http://",
        ];
        for (const [index, url] of invalidUrls.entries()) {
            await t.step(`reject URL case ${index + 1}`, async () => {
                await assertRejects(
                    () =>
                        pool.save({
                            defaultProxyId: null,
                            entries: [{ ...firstProxy, url }],
                        }),
                    TypeError,
                    "invalid proxy pool configuration",
                );
                assertEquals(pool.view(), initial);
            });
        }
        const invalidPools: unknown[] = [
            null,
            {},
            { defaultProxyId: null, entries: {} },
            { defaultProxyId: null, entries: [firstProxy, firstProxy] },
            { defaultProxyId: "missing", entries: [firstProxy] },
            {
                defaultProxyId: "office",
                entries: [{ ...firstProxy, enabled: false }],
            },
            {
                defaultProxyId: null,
                entries: [{ ...firstProxy, id: "../escape" }],
            },
            {
                defaultProxyId: null,
                entries: [{ ...firstProxy, id: "x".repeat(65) }],
            },
            { defaultProxyId: null, entries: [{ ...firstProxy, name: " " }] },
            {
                defaultProxyId: null,
                entries: [{ ...firstProxy, name: "x".repeat(81) }],
            },
            {
                defaultProxyId: null,
                entries: [{ ...firstProxy, enabled: "true" }],
            },
            {
                defaultProxyId: null,
                entries: [{ ...firstProxy, basicAuth: { username: "u" } }],
            },
            {
                defaultProxyId: null,
                entries: [{
                    ...firstProxy,
                    basicAuth: { username: "u", password: 123 },
                }],
            },
            {
                defaultProxyId: null,
                entries: [{
                    ...firstProxy,
                    basicAuth: { username: "", password: "p" },
                }],
            },
            {
                defaultProxyId: null,
                entries: [{
                    ...firstProxy,
                    basicAuth: { username: "u", password: "p".repeat(1_025) },
                }],
            },
            {
                defaultProxyId: null,
                entries: Array.from(
                    { length: 65 },
                    (_, index) => ({ ...firstProxy, id: `p${index}` }),
                ),
            },
            {
                defaultProxyId: null,
                entries: Array.from(
                    { length: 64 },
                    (_, index) => ({
                        ...firstProxy,
                        id: `p${index}`,
                        basicAuth: {
                            username: "u",
                            password: "中".repeat(1_024),
                        },
                    }),
                ),
            },
        ];
        for (const [index, input] of invalidPools.entries()) {
            await t.step(`reject pool case ${index + 1}`, async () => {
                await assertRejects(
                    () => pool.save(input as ProxyPoolInput),
                    TypeError,
                );
                assertEquals(pool.view(), initial);
            });
        }
        const saved = await pool.save({
            defaultProxyId: null,
            entries: [firstProxy, secondProxy, {
                ...firstProxy,
                id: "secure",
                url: "https://[::1]:8443/",
            }],
        });
        assertEquals(saved.pool.entries.length, 3);
    });
});

Deno.test("source selection parsing preserves only supported JSON choices", () => {
    assertEquals(parseSourceProxySelection(undefined), { mode: "inherit" });
    assertEquals(parseSourceProxySelection({ mode: "direct" }), {
        mode: "direct",
    });
    assertEquals(
        parseSourceProxySelection({ mode: "proxy", proxyId: "deleted" }),
        {
            mode: "proxy",
            proxyId: "deleted",
        },
    );
    for (
        const input of [
            null,
            [],
            {},
            { mode: "global" },
            { mode: "inherit", proxyId: "office" },
            { mode: "direct", proxyId: "office" },
            { mode: "proxy" },
            { mode: "proxy", proxyId: "" },
            { mode: "proxy", proxyId: "../escape" },
            { mode: "proxy", proxyId: "office", url: "http://localhost" },
        ]
    ) {
        assertThrows(
            () => parseSourceProxySelection(input),
            TypeError,
            "invalid source proxy selection",
        );
    }
});

Deno.test("input accessors are rejected without invocation or secret disclosure", async () => {
    await withPool(async (pool) => {
        let calls = 0;
        const entry = {
            ...firstProxy,
            get basicAuth(): never {
                calls++;
                throw new Error(credentials.password);
            },
        };
        const error = await assertRejects(() =>
            pool.save({
                defaultProxyId: null,
                entries: [entry],
            }), TypeError);
        assertEquals(calls, 0);
        assertEquals(String(error).includes(credentials.password), false);
        const choice = {
            get mode(): never {
                calls++;
                throw new Error(credentials.password);
            },
        };
        const choiceError = assertThrows(
            () => pool.validateSelection(choice),
            TypeError,
        );
        assertEquals(calls, 0);
        assertEquals(String(choiceError).includes(credentials.password), false);
    });
});
