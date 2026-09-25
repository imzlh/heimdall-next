import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import {
    computePluginArtifactDigest,
    createPluginHost,
    InMemoryPluginRecordStore,
    type PluginArtifact,
    PluginLifecycleError,
    type PluginRecord,
    type PluginRuntime,
    PluginVerificationError,
} from "../packages/plugin-host/mod.ts";

const artifact: PluginArtifact = {
    manifest: {
        id: "example.lifecycle",
        version: "1.0.0",
        apiVersion: "1",
        name: "Lifecycle test",
        kind: "tool",
        trust: "isolated",
    },
    entrypoint: "mod.ts",
    bytes: new TextEncoder().encode("export const value = 1;"),
};

function deferred<T = void>() {
    return Promise.withResolvers<T>();
}

function runtime(overrides: Partial<PluginRuntime> = {}): PluginRuntime {
    return {
        start: () => Promise.resolve(),
        invoke: () => Promise.resolve("ok"),
        stop: () => Promise.resolve(),
        ...overrides,
    };
}

class FailingStore extends InMemoryPluginRecordStore {
    rejectPut = false;
    rejectDelete = false;

    override put(record: PluginRecord): Promise<void> {
        if (this.rejectPut) return Promise.reject(new Error("write failed"));
        return super.put(record);
    }

    override delete(id: string): Promise<void> {
        if (this.rejectDelete) {
            return Promise.reject(new Error("delete failed"));
        }
        return super.delete(id);
    }
}

Deno.test("concurrent installs commit exactly one artifact and leave the queue usable", async () => {
    const host = createPluginHost({ policy: { allowUnsigned: true } });
    const results = await Promise.allSettled([
        host.install(artifact),
        host.install(artifact),
    ]);
    assertEquals(results.map((result) => result.status), [
        "fulfilled",
        "rejected",
    ]);
    const rejected = results[1];
    if (rejected?.status === "rejected") {
        assertEquals(rejected.reason.code, "already_installed");
    }
    assertEquals((await host.list()).length, 1);
    assertEquals(await host.uninstall(artifact.manifest.id), true);
});

Deno.test("custom verification cannot move an installation outside its lifecycle queue", async () => {
    const host = createPluginHost({
        verifier: {
            verify: () =>
                Promise.resolve({
                    status: "verified",
                    manifest: { ...artifact.manifest, id: "example.other" },
                }),
        },
    });
    await assertRejects(
        () => host.install(artifact),
        PluginVerificationError,
        "identity changed",
    );
    assertEquals(await host.list(), []);
});

Deno.test("concurrent enable starts one runtime and uninstall cannot race it back to life", async () => {
    const starting = deferred();
    const release = deferred();
    let starts = 0;
    let stops = 0;
    const host = createPluginHost({
        policy: { allowUnsigned: true },
        runtimeFactory: () =>
            runtime({
                async start() {
                    starts++;
                    starting.resolve();
                    await release.promise;
                },
                stop() {
                    stops++;
                    return Promise.resolve();
                },
            }),
    });
    await host.install(artifact);
    const first = host.enable(artifact.manifest.id);
    await starting.promise;
    const second = host.enable(artifact.manifest.id);
    const uninstall = host.uninstall(artifact.manifest.id);
    release.resolve();
    const results = await Promise.all([first, second, uninstall]);
    assertEquals(results[0].enabled, true);
    assertEquals(results[1].enabled, true);
    assertEquals(results[2], true);
    assertEquals({ starts, stops }, { starts: 1, stops: 1 });
    assertEquals(await host.get(artifact.manifest.id), undefined);
    const missing = await assertRejects(
        () => host.invoke(artifact.manifest.id, { method: "ping" }),
        PluginLifecycleError,
    );
    assertEquals(missing.code, "not_installed");
});

Deno.test("a blocked plugin lifecycle does not block other plugin ids", async () => {
    const starting = deferred();
    const release = deferred();
    const other = {
        ...artifact,
        manifest: { ...artifact.manifest, id: "example.other" },
    };
    const host = createPluginHost({
        policy: { allowUnsigned: true },
        runtimeFactory: (input) =>
            runtime({
                async start() {
                    if (input.manifest.id === artifact.manifest.id) {
                        starting.resolve();
                        await release.promise;
                    }
                },
            }),
    });
    await Promise.all([host.install(artifact), host.install(other)]);
    const pending = host.enable(artifact.manifest.id);
    await starting.promise;
    try {
        assertEquals((await host.enable(other.manifest.id)).enabled, true);
        assertEquals(
            await host.invoke(other.manifest.id, { method: "ping" }),
            "ok",
        );
    } finally {
        release.resolve();
        await pending;
    }
    await Promise.all([
        host.disable(artifact.manifest.id),
        host.disable(other.manifest.id),
    ]);
});

Deno.test("trusted metadata activation is idempotent without a runtime factory", async () => {
    const trusted: PluginArtifact = {
        ...artifact,
        manifest: { ...artifact.manifest, trust: "trusted" },
    };
    const host = createPluginHost({
        policy: { source: "builtin", trustedPluginIds: [trusted.manifest.id] },
    });
    await host.install(trusted);
    const enabled = await host.enable(trusted.manifest.id);
    assertEquals(await host.enable(trusted.manifest.id), enabled);
    assertEquals((await host.disable(trusted.manifest.id)).enabled, false);
});

Deno.test("persisted enabled state cannot bypass trusted activation policy", async () => {
    const store = new InMemoryPluginRecordStore();
    await store.put({
        manifest: { ...artifact.manifest, trust: "trusted" },
        enabled: true,
        isolated: false,
        updatedAt: "2026-01-01T00:00:00Z",
    });
    const host = createPluginHost({ store, policy: { source: "builtin" } });
    const error = await assertRejects(
        () => host.enable(artifact.manifest.id),
        PluginLifecycleError,
    );
    assertEquals(error.code, "policy_denied");
});

Deno.test("restored trusted records reconcile when the host requires an active runtime", async () => {
    const store = new InMemoryPluginRecordStore();
    await store.put({
        manifest: { ...artifact.manifest, trust: "trusted" },
        enabled: true,
        isolated: false,
        updatedAt: "2026-01-01T00:00:00Z",
    });
    const host = createPluginHost({
        store,
        requireRuntimeOnEnable: true,
        policy: { source: "builtin", trustedPluginIds: [artifact.manifest.id] },
    });
    assertEquals((await host.get(artifact.manifest.id))?.enabled, false);
    assertEquals((await host.list())[0]?.enabled, false);
    const error = await assertRejects(
        () => host.enable(artifact.manifest.id),
        PluginLifecycleError,
    );
    assertEquals(error.code, "runtime_required");
});

Deno.test("disable persistence failure preserves the working runtime and active invocation", async () => {
    const store = new FailingStore();
    const invoked = deferred();
    const release = deferred<string>();
    let signal: AbortSignal | undefined;
    let stops = 0;
    const host = createPluginHost({
        store,
        policy: { allowUnsigned: true },
        runtimeFactory: () =>
            runtime({
                invoke(input) {
                    signal = input.signal;
                    invoked.resolve();
                    return release.promise;
                },
                stop() {
                    stops++;
                    return Promise.resolve();
                },
            }),
    });
    await host.install(artifact);
    await host.enable(artifact.manifest.id);
    const invocation = host.invoke(artifact.manifest.id, { method: "ping" });
    await invoked.promise;
    store.rejectPut = true;
    await assertRejects(
        () => host.disable(artifact.manifest.id),
        Error,
        "write failed",
    );
    assertEquals(stops, 0);
    assertEquals(signal?.aborted, false);
    assertEquals((await host.get(artifact.manifest.id))?.enabled, true);
    release.resolve("still active");
    assertEquals(await invocation, "still active");
    store.rejectPut = false;
    await host.disable(artifact.manifest.id);
    assertEquals(stops, 1);
});

Deno.test("failed stop retains its runtime and blocks replacement until cleanup succeeds", async () => {
    let starts = 0;
    let stops = 0;
    let permitStop = false;
    const host = createPluginHost({
        policy: { allowUnsigned: true },
        runtimeFactory: () =>
            runtime({
                start() {
                    starts++;
                    return Promise.resolve();
                },
                stop() {
                    stops++;
                    return permitStop
                        ? Promise.resolve()
                        : Promise.reject(new Error("cleanup failed"));
                },
            }),
    });
    await host.install(artifact);
    await host.enable(artifact.manifest.id);
    await assertRejects(
        () => host.disable(artifact.manifest.id),
        PluginLifecycleError,
    );
    assertEquals((await host.get(artifact.manifest.id))?.enabled, false);
    await assertRejects(
        () => host.enable(artifact.manifest.id),
        PluginLifecycleError,
    );
    assertEquals({ starts, stops }, { starts: 1, stops: 2 });
    permitStop = true;
    assertEquals((await host.enable(artifact.manifest.id)).enabled, true);
    assertEquals({ starts, stops }, { starts: 2, stops: 3 });
    await host.disable(artifact.manifest.id);
});

Deno.test("failed startup cleanup is retried before another runtime can start", async () => {
    let factories = 0;
    let stops = 0;
    let cleanupReady = false;
    const host = createPluginHost({
        policy: { allowUnsigned: true },
        runtimeFactory: () => {
            factories++;
            return factories === 1
                ? runtime({
                    start: () => Promise.reject(new Error("startup failed")),
                    stop() {
                        stops++;
                        return cleanupReady
                            ? Promise.resolve()
                            : Promise.reject(new Error("busy"));
                    },
                })
                : runtime();
        },
    });
    await host.install(artifact);
    await assertRejects(
        () => host.enable(artifact.manifest.id),
        PluginLifecycleError,
    );
    await assertRejects(
        () => host.enable(artifact.manifest.id),
        PluginLifecycleError,
    );
    assertEquals({ factories, stops }, { factories: 1, stops: 2 });
    cleanupReady = true;
    await host.enable(artifact.manifest.id);
    assertEquals({ factories, stops }, { factories: 2, stops: 3 });
    await host.disable(artifact.manifest.id);
});

Deno.test("failed enable persistence stops the new runtime and permits a clean retry", async () => {
    const store = new FailingStore();
    let starts = 0;
    let stops = 0;
    const host = createPluginHost({
        store,
        policy: { allowUnsigned: true },
        runtimeFactory: () =>
            runtime({
                start() {
                    starts++;
                    return Promise.resolve();
                },
                stop() {
                    stops++;
                    return Promise.resolve();
                },
            }),
    });
    await host.install(artifact);
    store.rejectPut = true;
    await assertRejects(
        () => host.enable(artifact.manifest.id),
        PluginLifecycleError,
        "persist",
    );
    assertEquals({ starts, stops }, { starts: 1, stops: 1 });
    assertEquals((await host.get(artifact.manifest.id))?.enabled, false);
    store.rejectPut = false;
    await host.enable(artifact.manifest.id);
    assertEquals(starts, 2);
    await host.disable(artifact.manifest.id);
});

Deno.test("failed uninstall persistence retains the artifact for activation retry", async () => {
    const store = new FailingStore();
    const host = createPluginHost({
        store,
        policy: { allowUnsigned: true },
        runtimeFactory: () => runtime(),
    });
    await host.install(artifact);
    await host.enable(artifact.manifest.id);
    store.rejectDelete = true;
    await assertRejects(
        () => host.uninstall(artifact.manifest.id),
        Error,
        "delete failed",
    );
    assertEquals((await host.get(artifact.manifest.id))?.enabled, false);
    assertEquals((await host.enable(artifact.manifest.id)).enabled, true);
    store.rejectDelete = false;
    assertEquals(await host.uninstall(artifact.manifest.id), true);
});

Deno.test("list reconciliation rereads metadata and cannot resurrect an uninstalled record", async () => {
    const listed = deferred();
    const release = deferred();
    class DelayedListStore extends InMemoryPluginRecordStore {
        override async list(): Promise<readonly PluginRecord[]> {
            const snapshot = await super.list();
            listed.resolve();
            await release.promise;
            return snapshot;
        }
    }
    const store = new DelayedListStore();
    await store.put({
        manifest: artifact.manifest,
        enabled: true,
        isolated: true,
        updatedAt: "2026-01-01T00:00:00Z",
    });
    const host = createPluginHost({ store, policy: { allowUnsigned: true } });
    const listing = host.list();
    await listed.promise;
    assertEquals(await host.uninstall(artifact.manifest.id), true);
    release.resolve();
    assertEquals(await listing, []);
    assertEquals(await host.get(artifact.manifest.id), undefined);
});

Deno.test("install snapshots caller buffers before asynchronous verification", async () => {
    const bytes = new Uint8Array(artifact.bytes!);
    const original = new Uint8Array(bytes);
    const digest = await computePluginArtifactDigest(original);
    const received: Uint8Array[] = [];
    const host = createPluginHost({
        policy: { allowUnsigned: true },
        runtimeFactory: (input) => {
            received.push(new Uint8Array(input.bytes!));
            input.bytes!.fill(7);
            return runtime({
                start(input) {
                    received.push(new Uint8Array(input.bytes!));
                    input.bytes!.fill(9);
                    return Promise.resolve();
                },
            });
        },
    });
    const installing = host.install({ ...artifact, bytes });
    bytes.fill(0);
    assertEquals((await installing).digest, digest);
    await host.enable(artifact.manifest.id);
    await host.disable(artifact.manifest.id);
    await host.enable(artifact.manifest.id);
    assertEquals(received, [original, original, original, original]);
    await host.disable(artifact.manifest.id);
});

Deno.test("installation snapshots reject manifest accessors without executing them", async () => {
    let reads = 0;
    const host = createPluginHost({ policy: { allowUnsigned: true } });
    const input: PluginArtifact = {
        ...artifact,
        manifest: {
            ...artifact.manifest,
            get configSchema() {
                reads++;
                return {};
            },
        },
    };
    await assertRejects(() => host.install(input), PluginVerificationError);
    assertEquals(reads, 0);
    assertEquals(await host.list(), []);
});

Deno.test("stored nested manifest metadata is detached from the caller", async () => {
    const field = { label: "Original" };
    const store = new InMemoryPluginRecordStore();
    await store.put({
        manifest: { ...artifact.manifest, configSchema: { field } },
        enabled: false,
        isolated: true,
        updatedAt: "2026-01-01T00:00:00Z",
    });
    field.label = "Changed";
    assertEquals(
        (await store.get(artifact.manifest.id))?.manifest.configSchema,
        {
            field: { label: "Original" },
        },
    );
});

Deno.test("already-aborted invocation never reaches the runtime", async () => {
    let invocations = 0;
    const host = createPluginHost({
        policy: { allowUnsigned: true },
        runtimeFactory: () =>
            runtime({
                invoke() {
                    invocations++;
                    return Promise.resolve(undefined);
                },
            }),
    });
    await host.install(artifact);
    await host.enable(artifact.manifest.id);
    const reason = new Error("cancelled");
    const failure = await assertRejects(() =>
        host.invoke(artifact.manifest.id, {
            method: "ping",
            signal: AbortSignal.abort(reason),
        })
    );
    assertStrictEquals(failure, reason);
    assertEquals(invocations, 0);
    await host.disable(artifact.manifest.id);
});

Deno.test("a queued invocation aborts before startup finishes and never dispatches later", async () => {
    const starting = deferred();
    const release = deferred();
    let invocations = 0;
    const host = createPluginHost({
        policy: { allowUnsigned: true },
        runtimeFactory: () =>
            runtime({
                async start() {
                    starting.resolve();
                    await release.promise;
                },
                invoke() {
                    invocations++;
                    return Promise.resolve(undefined);
                },
            }),
    });
    await host.install(artifact);
    const enabling = host.enable(artifact.manifest.id);
    await starting.promise;
    const controller = new AbortController();
    const waiting = host.invoke(artifact.manifest.id, {
        method: "ping",
        signal: controller.signal,
    });
    controller.abort();
    try {
        await assertRejects(() => waiting, DOMException, "aborted");
    } finally {
        release.resolve();
        await enabling;
    }
    await host.disable(artifact.manifest.id);
    assertEquals(invocations, 0);
});

Deno.test("disable cancels every running invocation without waiting for runtime results", async () => {
    const started = deferred();
    const results = deferred<string>();
    const signals: AbortSignal[] = [];
    const host = createPluginHost({
        policy: { allowUnsigned: true },
        runtimeFactory: () =>
            runtime({
                invoke(input) {
                    signals.push(input.signal!);
                    if (signals.length === 2) started.resolve();
                    return results.promise;
                },
            }),
    });
    await host.install(artifact);
    await host.enable(artifact.manifest.id);
    const one = host.invoke(artifact.manifest.id, { method: "one" });
    const two = host.invoke(artifact.manifest.id, { method: "two" });
    const rejected = Promise.all([
        assertRejects(() => one, DOMException, "disabled"),
        assertRejects(() => two, DOMException, "disabled"),
    ]);
    await started.promise;
    await host.disable(artifact.manifest.id);
    await rejected;
    assertEquals(signals.map((signal) => signal.aborted), [true, true]);
    results.reject(new Error("late runtime rejection"));
    // Let the ignored runtime failure settle; Deno rejects unhandled failures.
    await new Promise((resolve) => setTimeout(resolve, 0));
});

Deno.test("caller deadlines terminate runtime waits even when the runtime ignores abort", async () => {
    const started = deferred();
    const results = deferred<string>();
    const controller = new AbortController();
    let runtimeSignal: AbortSignal | undefined;
    const host = createPluginHost({
        policy: { allowUnsigned: true },
        runtimeFactory: () =>
            runtime({
                invoke(input) {
                    runtimeSignal = input.signal;
                    started.resolve();
                    return results.promise;
                },
            }),
    });
    await host.install(artifact);
    await host.enable(artifact.manifest.id);
    const pending = host.invoke(artifact.manifest.id, {
        method: "ping",
        signal: controller.signal,
    });
    await started.promise;
    const deadline = new DOMException("deadline exceeded", "TimeoutError");
    controller.abort(deadline);
    assertStrictEquals(await assertRejects(() => pending), deadline);
    assertStrictEquals(runtimeSignal?.reason, deadline);
    results.resolve("late result");
    assertEquals((await host.get(artifact.manifest.id))?.enabled, true);
    await host.disable(artifact.manifest.id);
});
