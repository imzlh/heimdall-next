import { assertEquals, assertRejects } from "@std/assert";
import type { InferenceSource, SourceProbeResult } from "@heimdall/contracts";
import { SourceRegistry } from "@heimdall/kernel";
import {
    probeSource,
    probeSources,
} from "@heimdall/core/composition/probe-loop.ts";
import { startBackgroundTasks } from "@heimdall/core/composition/background-tasks.ts";
import { createRuntimeSettings } from "@heimdall/core/composition/runtime-settings.ts";
import { loadBuiltinComposition } from "@heimdall/core/composition/builtins.ts";

const success = { ok: true, message: "connected", models: ["new-model"] };
const journal = { pruneOlderThan: () => ({ deleted: 0, done: true }) };

function source(
    id: string,
    probe: NonNullable<InferenceSource["probe"]>,
): InferenceSource {
    return {
        id,
        capabilities: [{ operation: "generation.create", streaming: true }],
        execute: async function* () {},
        probe,
    };
}

async function bounded<T>(operation: PromiseLike<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error("probe did not settle within 2s")),
                    2000,
                );
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

Deno.test("hung probes time out without blocking later channels or accepting late output", async () => {
    const registry = new SourceRegistry();
    const late = Promise.withResolvers<SourceProbeResult>();
    let signal: AbortSignal | undefined;
    registry.register(source("hung", (value) => {
        signal = value;
        return late.promise;
    }));
    registry.register(source("working", () => Promise.resolve(success)));
    await bounded(probeSources(registry, 10));
    assertEquals(signal?.aborted, true);
    assertEquals(registry.probeOf("hung")?.ok, false);
    assertEquals(registry.probeOf("hung")?.message, "probe timed out");
    assertEquals(registry.probeOf("working")?.ok, true);
    late.resolve(success);
    await late.promise;
    assertEquals(registry.probeOf("hung")?.ok, false);
    assertEquals(registry.discoveredModels("hung"), []);
});

Deno.test("operator cancellation releases a probe without cooling the source or probing later channels", async () => {
    const registry = new SourceRegistry();
    const entered = Promise.withResolvers<AbortSignal>();
    const late = Promise.withResolvers<SourceProbeResult>();
    registry.register(source("first", (signal) => {
        entered.resolve(signal);
        return late.promise;
    }));
    let calls = 0;
    registry.register(source("second", () => {
        calls++;
        return Promise.resolve(success);
    }));
    const controller = new AbortController();
    const running = probeSources(registry, 10_000, controller.signal);
    const signal = await entered.promise;
    controller.abort();
    await assertRejects(() => bounded(running), DOMException, "aborted");
    assertEquals(signal.aborted, true);
    assertEquals(calls, 0);
    assertEquals(registry.probeOf("first"), undefined);
    assertEquals(registry.healthOf("first"), "ready");
    late.reject(new Error("late provider failure with private credentials"));
    await Promise.resolve();
});

Deno.test("removed or replaced channels reject old probe results without breaking the loop", async () => {
    for (const replace of [false, true]) {
        const registry = new SourceRegistry();
        const entered = Promise.withResolvers<void>();
        const late = Promise.withResolvers<SourceProbeResult>();
        registry.register(source("changing", () => {
            entered.resolve();
            return late.promise;
        }));
        registry.register(source("stable", () => Promise.resolve(success)));
        const running = probeSources(registry);
        await entered.promise;
        if (replace) {
            registry.replace(
                source("changing", () => Promise.resolve(success)),
            );
        } else registry.unregister("changing");
        late.resolve({
            ok: false,
            message: "old config rejected",
            models: ["old-model"],
        });
        await bounded(running);
        assertEquals(registry.probeOf("stable")?.ok, true);
        if (replace) {
            assertEquals(registry.probeOf("changing"), undefined);
            assertEquals(registry.healthOf("changing"), "ready");
            assertEquals(registry.discoveredModels("changing"), []);
        }
    }
});

Deno.test("a newer manual probe supersedes an older periodic probe", async () => {
    const registry = new SourceRegistry();
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<SourceProbeResult>();
    let calls = 0;
    registry.register(source("same", () => {
        if (++calls === 1) {
            entered.resolve();
            return late.promise;
        }
        return Promise.resolve(success);
    }));
    const old = probeSource(registry, "same");
    await entered.promise;
    assertEquals(await probeSource(registry, "same"), success);
    late.resolve({ ok: false, message: "old failure" });
    assertEquals(await old, undefined);
    assertEquals(registry.probeOf("same")?.ok, true);
    assertEquals(registry.discoveredModels("same"), ["new-model"]);
});

Deno.test("background disposal cancels uncooperative probes and removes settings observers", async () => {
    const registry = new SourceRegistry();
    const entered = Promise.withResolvers<AbortSignal>();
    let calls = 0;
    registry.register(source("hanging", (signal) => {
        calls++;
        entered.resolve(signal);
        return new Promise(() => {});
    }));
    const settings = createRuntimeSettings({
        proxyKey: "",
        limitPerMinute: 0,
        probeIntervalMs: 3600000,
    });
    const tasks = startBackgroundTasks(registry, settings, journal, 0);
    const signal = await entered.promise;
    await bounded(tasks[Symbol.asyncDispose]());
    assertEquals(signal.aborted, true);
    assertEquals(registry.probeOf("hanging"), undefined);
    settings.replace(
        { ...settings.get(), probeIntervalMs: 1 },
        "after-disposal",
    );
    await tasks[Symbol.asyncDispose]();
    assertEquals(calls, 1);
});

Deno.test("probe interval updates apply immediately and disabling cancels active work", async () => {
    const registry = new SourceRegistry();
    let entered = Promise.withResolvers<AbortSignal>();
    let calls = 0;
    registry.register(source("live", (signal) => {
        calls++;
        entered.resolve(signal);
        return new Promise(() => {});
    }));
    const settings = createRuntimeSettings({
        proxyKey: "",
        limitPerMinute: 0,
        probeIntervalMs: 0,
    });
    await using _tasks = startBackgroundTasks(registry, settings, journal, 0);
    assertEquals(calls, 0);
    settings.replace(
        { ...settings.get(), probeIntervalMs: 3600000 },
        "enabled",
    );
    const first = await bounded(entered.promise);
    settings.replace(
        { ...settings.get(), proxyKey: "changed-key" },
        "unrelated",
    );
    assertEquals(first.aborted, false);
    settings.replace({ ...settings.get(), probeIntervalMs: 0 }, "disabled");
    assertEquals(first.aborted, true);
    entered = Promise.withResolvers<AbortSignal>();
    settings.replace({ ...settings.get(), probeIntervalMs: 1000 }, "reenabled");
    const second = await bounded(entered.promise);
    assertEquals(second.aborted, false);
    assertEquals(calls, 2);
    assertEquals(registry.probeOf("live"), undefined);
});

Deno.test("management probes use the request cancellation signal and redact thrown provider errors", async () => {
    const builtins = await loadBuiltinComposition({ env: () => undefined });
    try {
        builtins.sources.register(source("throws", () => {
            throw new Error("private-access-token");
        }));
        const probe = builtins.management.probeSource!;
        const context = {
            requestId: "probe-lifecycle",
            request: new Request("http://localhost/admin/source-probe"),
        };
        const result = await probe(context, "throws");
        assertEquals(result.ok, false);
        assertEquals(result.message, "probe failed");
        const controller = new AbortController();
        controller.abort();
        const request = new Request(context.request, {
            signal: controller.signal,
        });
        await assertRejects(
            () => Promise.resolve(probe({ ...context, request }, "throws")),
            DOMException,
        );
    } finally {
        await builtins.close();
    }
});
