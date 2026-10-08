import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
    comparePluginVersions,
    computePluginArtifactDigest,
    createPluginHost,
    InMemoryPluginRecordStore,
    type PluginArtifact,
    PluginLifecycleError,
    type PluginRecord,
    type PluginRuntime,
} from "@heimdall/plugin-host";

const id = "test.upgrade";
async function artifact(
    version: string,
    dependencies?: string[],
): Promise<PluginArtifact> {
    const bytes = new TextEncoder().encode(
        `export const version = "${version}";`,
    );
    return {
        manifest: {
            id,
            name: "Upgradeable",
            version,
            apiVersion: "1",
            kind: "tool",
            trust: "isolated",
            ...(dependencies ? { dependencies } : {}),
        },
        entrypoint: "plugin.js",
        bytes,
        digest: await computePluginArtifactDigest(bytes),
    };
}

class ControlledStore extends InMemoryPluginRecordStore {
    beforeReplace?: (record: PluginRecord) => Promise<void>;
    afterReplace?: (record: PluginRecord) => void | Promise<void>;
    override async replace(
        record: PluginRecord,
        value: PluginArtifact,
        previous?: PluginArtifact,
    ): Promise<PluginRecord> {
        await this.beforeReplace?.(record);
        const saved = await super.replace(record, value, previous);
        await this.afterReplace?.(saved);
        return saved;
    }
}

function fixture(store = new ControlledStore()) {
    const live = new Set<object>();
    const advertised = new Map<string, string>();
    const failures = new Map<string, () => void>();
    let peak = 0;
    let startHook: ((version: string) => Promise<void>) | undefined;
    let stopHook: (() => void) | undefined;
    const host = createPluginHost({
        store,
        policy: { allowUnsigned: true },
        requireRuntimeOnEnable: true,
        runtimeFactory(value): PluginRuntime {
            const token = {};
            const version = value.manifest.version;
            const pluginId = value.manifest.id;
            let listener: ((error: Error) => void) | undefined;
            return {
                isActive: () => live.has(token),
                onFailure(callback) {
                    listener = callback;
                    return () => {
                        listener = undefined;
                    };
                },
                async start() {
                    live.add(token);
                    peak = Math.max(peak, live.size);
                    failures.set(version, () => {
                        live.delete(token);
                        advertised.delete(pluginId);
                        listener?.(new Error("candidate crashed"));
                    });
                    await startHook?.(version);
                },
                activate() {
                    advertised.set(pluginId, version);
                },
                invoke: (input) =>
                    input.method === "hold"
                        ? new Promise(() => {})
                        : Promise.resolve(version),
                stop() {
                    stopHook?.();
                    live.delete(token);
                    advertised.delete(pluginId);
                    return Promise.resolve();
                },
            };
        },
    });
    return {
        host,
        store,
        live,
        advertised,
        failures,
        peak: () => peak,
        startHook: (hook?: typeof startHook) => {
            startHook = hook;
        },
        stopHook: (hook?: typeof stopHook) => {
            stopHook = hook;
        },
    };
}

Deno.test("plugin SemVer ordering handles prereleases, build metadata and invalid identifiers", () => {
    const ordered = [
        "1.0.0-alpha",
        "1.0.0-alpha.1",
        "1.0.0-alpha.beta",
        "1.0.0-beta",
        "1.0.0-beta.2",
        "1.0.0-beta.11",
        "1.0.0-rc.1",
        "1.0.0",
        "1.0.1",
        "2.0.0",
    ];
    for (let index = 1; index < ordered.length; index++) {
        assertEquals(
            comparePluginVersions(ordered[index]!, ordered[index - 1]!) > 0,
            true,
        );
    }
    assertEquals(comparePluginVersions("1.0.0+one", "1.0.0+two"), 0);
    assertEquals(
        comparePluginVersions(
            "10000000000000000001.0.0",
            "10000000000000000000.0.0",
        ) > 0,
        true,
    );
    for (const value of ["1.0.0\n", "01.0.0", "1.0", "1.0.0-01", "v1.0.0"]) {
        assertThrows(() => comparePluginVersions(value, "1.0.0"), TypeError);
    }
});

Deno.test("upgrade and rollback preserve enabled state and consume one immutable rollback snapshot", async () => {
    const f = fixture();
    try {
        const installed = await f.host.install(await artifact("1.0.0"));
        const disabled = await f.host.upgrade(
            id,
            await artifact("1.1.0"),
            installed.revision!,
        );
        assertEquals(disabled.enabled, false);
        assertEquals(f.live.size, 0);
        const disabledRollback = await f.host.rollback(id, disabled.revision!);
        assertEquals(disabledRollback.enabled, false);
        assertEquals(disabledRollback.manifest.version, "1.0.0");
        assertEquals(f.live.size, 0);
        await f.host.upgrade(
            id,
            await artifact("1.1.0"),
            disabledRollback.revision!,
        );
        const enabled = await f.host.enable(id);
        const v2 = await f.host.upgrade(
            id,
            await artifact("2.0.0"),
            enabled.revision!,
        );
        assertEquals(v2.rollback?.version, "1.1.0");
        assertEquals(await f.host.invoke(id, { method: "version" }), "2.0.0");
        const restored = await f.host.rollback(id, v2.revision!);
        assertEquals(restored.manifest.version, "1.1.0");
        assertEquals(restored.enabled, true);
        assertEquals(restored.rollback, undefined);
        assertEquals(await f.store.readRollbackArtifact(id), undefined);
        assertEquals(f.advertised.get(id), "1.1.0");
        assertEquals(f.peak(), 1);
        await assertRejects(
            () => f.host.rollback(id, restored.revision!),
            PluginLifecycleError,
            "no previous package",
        );
    } finally {
        await f.host.close();
    }
});

Deno.test("candidate startup and durable write failures restore the exact old active package", async () => {
    for (const fail of ["startup", "write"]) {
        const f = fixture();
        try {
            await f.host.install(await artifact("1.0.0"));
            const previous = await f.host.enable(id);
            if (fail === "startup") {
                f.startHook((version) =>
                    version === "2.0.0"
                        ? Promise.reject(new Error("startup failed"))
                        : Promise.resolve()
                );
            } else {f.store.beforeReplace = () =>
                    Promise.reject(new Error("storage failed"));}
            await assertRejects(() =>
                f.host.upgrade(id, artifactValue, previous.revision!)
            );
            assertEquals(await f.host.get(id), previous);
            assertEquals(
                await f.host.invoke(id, { method: "version" }),
                "1.0.0",
            );
            assertEquals(f.advertised.get(id), "1.0.0");
            assertEquals(f.live.size, 1);
            assertEquals(f.peak(), 1);
        } finally {
            await f.host.close();
        }
    }
});

const artifactValue = await artifact("2.0.0");

Deno.test("worker death during the commit compensates by CAS and preserves the previous rollback", async () => {
    const f = fixture();
    try {
        await f.host.install(await artifact("1.0.0"));
        const enabled = await f.host.enable(id);
        const v2 = await f.host.upgrade(id, artifactValue, enabled.revision!);
        f.store.afterReplace = (record) => {
            if (record.manifest.version === "3.0.0") f.failures.get("3.0.0")!();
        };
        await assertRejects(() => f.host.upgrade(id, third, v2.revision!));
        const restored = (await f.host.get(id))!;
        assertEquals(restored.manifest.version, "2.0.0");
        assertEquals(restored.rollback?.version, "1.0.0");
        assertEquals(restored.enabled, true);
        assertEquals(await f.host.invoke(id, { method: "version" }), "2.0.0");
        assertEquals(f.advertised.get(id), "2.0.0");
        assertEquals(f.peak(), 1);
        assertEquals(
            (await f.host.rollback(id, restored.revision!)).manifest.version,
            "1.0.0",
        );
    } finally {
        await f.host.close();
    }
});

const third = await artifact("3.0.0");

Deno.test("candidate staging withdraws old capabilities, cancels old calls and holds new admission until commit", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
        await f.host.install(await artifact("1.0.0"));
        const previous = await f.host.enable(id);
        const pending = assertRejects(
            () => f.host.invoke(id, { method: "hold" }),
            DOMException,
        );
        // Order admission before the replacement through the host queue.
        await Promise.resolve();
        f.startHook(async (version) => {
            if (version === "2.0.0") {
                entered.resolve();
                await release.promise;
            }
        });
        const upgrading = f.host.upgrade(id, artifactValue, previous.revision!);
        await entered.promise;
        assertEquals(f.advertised.size, 0);
        assertEquals(f.live.size, 1);
        const next = f.host.invoke(id, { method: "version" });
        release.resolve();
        await upgrading;
        await pending;
        assertEquals(await next, "2.0.0");
        assertEquals(f.peak(), 1);
    } finally {
        release.resolve();
        await f.host.close();
    }
});

Deno.test("concurrent package replacement and stale revisions never overwrite another lifecycle write", async () => {
    const f = fixture();
    try {
        await f.host.install(await artifact("1.0.0"));
        const previous = await f.host.enable(id);
        const results = await Promise.allSettled([
            f.host.upgrade(id, artifactValue, previous.revision!),
            f.host.upgrade(id, third, previous.revision!),
        ]);
        assertEquals(results.map((result) => result.status), [
            "fulfilled",
            "rejected",
        ]);
        const v2 = (await f.host.get(id))!;
        f.startHook(async (version) => {
            if (version === "3.0.0") {
                await f.store.put({
                    ...v2,
                    enabled: false,
                    lastError: "external disable",
                });
            }
        });
        await assertRejects(
            () => f.host.upgrade(id, third, v2.revision!),
            PluginLifecycleError,
        );
        const latest = (await f.host.get(id))!;
        assertEquals(latest.enabled, false);
        assertEquals(latest.manifest.version, "2.0.0");
        assertEquals(latest.lastError, "external disable");
        assertEquals(f.advertised.size, 0);
        assertEquals(f.live.size, 0);
    } finally {
        await f.host.close();
    }
});

Deno.test("invalid packages and dependency protections reject replacement before disrupting the old worker", async () => {
    const f = fixture();
    try {
        await f.host.install(await artifact("1.0.0"));
        const previous = await f.host.enable(id);
        const wrongId = {
            ...artifactValue,
            manifest: { ...artifactValue.manifest, id: "another.id" },
        };
        for (
            const value of [
                await artifact("1.0.0"),
                await artifact("0.9.0"),
                wrongId,
                { ...artifactValue, bytes: new Uint8Array([1]) },
                await artifact("2.0.0", ["missing.plugin"]),
            ]
        ) {
            await assertRejects(() =>
                f.host.upgrade(id, value, previous.revision!)
            );
            assertEquals(await f.host.get(id), previous);
            assertEquals(f.advertised.get(id), "1.0.0");
        }
        const child = await artifact("1.0.0", [id]);
        await f.host.install({
            ...child,
            manifest: { ...child.manifest, id: "test.dependent" },
        });
        await f.host.enable("test.dependent");
        await assertRejects(
            () => f.host.upgrade(id, artifactValue, previous.revision!),
            PluginLifecycleError,
            "required by test.dependent",
        );
        await f.host.disable("test.dependent");
        const v2 = await f.host.upgrade(id, artifactValue, previous.revision!);
        await f.host.enable("test.dependent");
        await assertRejects(
            () => f.host.rollback(id, v2.revision!),
            PluginLifecycleError,
            "required by test.dependent",
        );
    } finally {
        await f.host.close();
    }
});

Deno.test("failed cleanup blocks a second worker until stop can be retried", async () => {
    const f = fixture();
    try {
        await f.host.install(await artifact("1.0.0"));
        const previous = await f.host.enable(id);
        f.stopHook(() => {
            throw new Error("stop failed");
        });
        await assertRejects(
            () => f.host.upgrade(id, artifactValue, previous.revision!),
            PluginLifecycleError,
        );
        assertEquals(f.live.size, 1);
        assertEquals(f.peak(), 1);
        f.stopHook();
        await f.host.disable(id);
        await f.host.enable(id);
        assertEquals(await f.host.invoke(id, { method: "version" }), "1.0.0");
        assertEquals(f.peak(), 1);
    } finally {
        f.stopHook();
        await f.host.close();
    }
});

Deno.test("shutdown drains a rollback still reading its durable snapshot and leaves no new worker behind", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    class ReadingStore extends ControlledStore {
        hold = false;
        override async readRollbackArtifact(pluginId: string) {
            if (this.hold) {
                this.hold = false;
                entered.resolve();
                await release.promise;
            }
            return await super.readRollbackArtifact(pluginId);
        }
    }
    const store = new ReadingStore();
    const f = fixture(store);
    try {
        await f.host.install(await artifact("1.0.0"));
        const previous = await f.host.enable(id);
        const current = await f.host.upgrade(
            id,
            artifactValue,
            previous.revision!,
        );
        store.hold = true;
        const rollback = f.host.rollback(id, current.revision!);
        await entered.promise;
        const closing = f.host.close();
        release.resolve();
        await rollback;
        await closing;
        assertEquals(f.live.size, 0);
        assertEquals(f.advertised.size, 0);
        assertEquals((await store.get(id))?.manifest.version, "1.0.0");
        assertEquals((await store.get(id))?.enabled, true);
    } finally {
        release.resolve();
        await f.host.close();
    }
});

Deno.test("a concurrent disable during old-worker recovery wins before restored capabilities are published", async () => {
    const f = fixture();
    try {
        await f.host.install(await artifact("1.0.0"));
        const previous = await f.host.enable(id);
        f.startHook(async (version) => {
            if (version === "2.0.0") {
                throw new Error("candidate startup failed");
            }
            const latest = (await f.store.get(id))!;
            await f.store.put({
                ...latest,
                enabled: false,
                lastError: "operator disabled during recovery",
            });
        });
        await assertRejects(() =>
            f.host.upgrade(id, artifactValue, previous.revision!)
        );
        assertEquals((await f.store.get(id))?.enabled, false);
        assertEquals(
            (await f.store.get(id))?.lastError,
            "operator disabled during recovery",
        );
        assertEquals(f.live.size, 0);
        assertEquals(f.advertised.size, 0);
    } finally {
        await f.host.close();
    }
});

Deno.test("a concurrent disable during post-commit cleanup wins before candidate publication", async () => {
    const f = fixture();
    try {
        await f.host.install(await artifact("1.0.0"));
        const previous = await f.host.enable(id);
        f.store.afterReplace = (record) =>
            f.store.put({
                ...record,
                enabled: false,
                lastError: "operator disabled after commit",
            });
        await assertRejects(
            () => f.host.upgrade(id, artifactValue, previous.revision!),
            PluginLifecycleError,
            "changed before replacement activation",
        );
        assertEquals((await f.store.get(id))?.enabled, false);
        assertEquals((await f.store.get(id))?.manifest.version, "2.0.0");
        assertEquals(
            (await f.store.get(id))?.lastError,
            "operator disabled after commit",
        );
        assertEquals(f.live.size, 0);
        assertEquals(f.advertised.size, 0);
    } finally {
        await f.host.close();
    }
});
