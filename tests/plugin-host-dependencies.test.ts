import { assertEquals, assertRejects } from "@std/assert";
import {
    createPluginHost,
    InMemoryPluginRecordStore,
    type PluginArtifact,
    PluginLifecycleError,
    type PluginRuntime,
} from "@heimdall/plugin-host";

function artifact(id: string, dependencies: string[] = []): PluginArtifact {
    return {
        manifest: {
            id,
            name: id,
            version: "1.0.0",
            apiVersion: "1",
            kind: "tool",
            trust: "isolated",
            dependencies,
        },
        entrypoint: "plugin.js",
        bytes: new TextEncoder().encode("export {}"),
    };
}

function runtime(): PluginRuntime {
    return {
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        invoke: () => Promise.resolve("ok"),
    };
}

Deno.test("lifecycle enforces dependency availability and protects disabled dependents from uninstall", async () => {
    const host = createPluginHost({
        policy: { allowUnsigned: true },
        runtimeFactory: runtime,
    });
    await host.install(artifact("test.child", ["test.base"]));
    assertEquals(
        (await assertRejects(
            () => host.enable("test.child"),
            PluginLifecycleError,
        )).code,
        "dependency_unavailable",
    );
    assertEquals(
        (await host.get("test.child"))?.lastError,
        "plugin test.child requires enabled dependency test.base",
    );
    await host.install(artifact("test.base"));
    await assertRejects(
        () => host.enable("test.child"),
        PluginLifecycleError,
        "test.base",
    );
    await host.enable("test.base");
    await host.enable("test.child");
    assertEquals(
        (await assertRejects(
            () => host.disable("test.base"),
            PluginLifecycleError,
        )).code,
        "dependency_in_use",
    );
    await host.disable("test.child");
    await host.disable("test.base");
    await assertRejects(
        () => host.uninstall("test.base"),
        PluginLifecycleError,
        "test.child",
    );
    await host.uninstall("test.child");
    assertEquals(await host.uninstall("test.base"), true);
});

Deno.test("dependent startup locks its prerequisites while unrelated plugins remain available", async () => {
    const starting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const host = createPluginHost({
        policy: { allowUnsigned: true },
        runtimeFactory: (input) => ({
            ...runtime(),
            async start() {
                if (input.manifest.id === "test.child") {
                    starting.resolve();
                    await release.promise;
                }
            },
        }),
    });
    await host.install(artifact("test.base"));
    await host.install(artifact("test.child", ["test.base"]));
    await host.install(artifact("test.other"));
    await host.enable("test.base");
    const enabling = host.enable("test.child");
    await starting.promise;
    const disabling = assertRejects(
        () => host.disable("test.base"),
        PluginLifecycleError,
        "test.child",
    );
    try {
        assertEquals((await host.enable("test.other")).enabled, true);
    } finally {
        release.resolve();
    }
    await enabling;
    await disabling;
    await host.close?.();
});

Deno.test("shared in-memory stores reject duplicate installs and stale lifecycle revisions", async () => {
    const store = new InMemoryPluginRecordStore();
    const first = createPluginHost({ store, policy: { allowUnsigned: true } });
    const second = createPluginHost({ store, policy: { allowUnsigned: true } });
    const results = await Promise.allSettled([
        first.install(artifact("test.shared")),
        second.install(artifact("test.shared")),
    ]);
    assertEquals(
        results.filter((result) => result.status === "fulfilled").length,
        1,
    );
    const stale = (await store.get("test.shared"))!;
    await store.put({ ...stale, lastError: "changed" });
    await assertRejects(() => store.put(stale), PluginLifecycleError);
    await assertRejects(
        () => store.delete("test.shared", stale.revision),
        PluginLifecycleError,
    );
    assertEquals((await store.get("test.shared"))?.lastError, "changed");
});

Deno.test("unexpected worker termination reconciles durable state and releases registrations", async () => {
    let running = false;
    let stopped = 0;
    const host = createPluginHost({
        policy: { allowUnsigned: true },
        runtimeFactory: () => ({
            ...runtime(),
            isActive: () => running,
            start() {
                running = true;
                return Promise.resolve();
            },
            stop() {
                running = false;
                stopped++;
                return Promise.resolve();
            },
        }),
    });
    await host.install(artifact("test.worker"));
    await host.enable("test.worker");
    running = false;
    const record = await host.get("test.worker");
    assertEquals(record?.enabled, false);
    assertEquals(
        record?.lastError,
        "runtime_required: plugin runtime is not active",
    );
    assertEquals(stopped, 1);
    await host.enable("test.worker");
    assertEquals(await host.invoke("test.worker", { method: "ping" }), "ok");
    await host.close?.();
});
