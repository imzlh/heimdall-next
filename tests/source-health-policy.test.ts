import {
    assert,
    assertEquals,
    assertStrictEquals,
    assertThrows,
} from "@std/assert";
import {
    DEFAULT_SOURCE_HEALTH_POLICY,
    type InferenceSource,
    type OperationRequest,
    parseSourceHealthPolicy,
    type SourceCooldown,
    type StreamFrame,
} from "@heimdall/contracts";
import { SourceRegistry } from "@heimdall/kernel";

const epoch = Date.parse("2026-10-01T00:00:00.000Z");
const timestamp = (time: number) => new Date(time).toISOString();

function cooldown(
    duration = 5_000,
    reason: SourceCooldown["reason"] = "probe",
): SourceCooldown {
    return {
        reason,
        startedAt: timestamp(epoch),
        until: timestamp(epoch + duration),
    };
}

function source(id: string, status?: number): InferenceSource {
    return {
        id,
        capabilities: [{
            operation: "generation.create",
            models: [id],
            streaming: true,
        }],
        async *execute(input) {
            const base = {
                version: 1 as const,
                requestId: input.requestId,
                streamId: `stream:${id}`,
                timestamp: timestamp(epoch),
            };
            yield {
                ...base,
                seq: 1,
                eventId: `${id}:1`,
                event: { kind: "run.started", request: input },
            };
            yield {
                ...base,
                seq: 2,
                eventId: `${id}:2`,
                event: status === undefined ? { kind: "run.completed" } : {
                    kind: "run.error",
                    error: {
                        code: "upstream_error",
                        message: "private upstream response",
                        status,
                    },
                },
            };
        },
    };
}

async function run(
    registry: SourceRegistry,
    id: string,
): Promise<StreamFrame[]> {
    const request: OperationRequest = {
        version: 1,
        requestId: `request:${id}`,
        operation: "generation.create",
        traits: { model: id, streaming: true },
        payload: { messages: [] },
    };
    const frames: StreamFrame[] = [];
    for await (
        const frame of registry.run(request, {
            requestId: request.requestId,
            signal: new AbortController().signal,
            metadata: {},
        })
    ) frames.push(frame);
    return frames;
}

Deno.test("health policy parser accepts bounded JSON durations and rejects executable or ambiguous input", () => {
    assertEquals(parseSourceHealthPolicy(undefined), null);
    assertEquals(parseSourceHealthPolicy(null), null);
    assertEquals(parseSourceHealthPolicy({}), {});
    assertEquals(
        parseSourceHealthPolicy({ cooldownMs: 0, authCooldownMs: 86_400_000 }),
        {
            cooldownMs: 0,
            authCooldownMs: 86_400_000,
        },
    );
    assertEquals(
        parseSourceHealthPolicy(
            Object.assign(Object.create(null), { cooldownMs: 1 }),
        ),
        {
            cooldownMs: 1,
        },
    );
    assertEquals(DEFAULT_SOURCE_HEALTH_POLICY, {
        cooldownMs: 30_000,
        authCooldownMs: 300_000,
    });
    const input = { cooldownMs: 1_000 };
    const parsed = parseSourceHealthPolicy(input);
    input.cooldownMs = 2_000;
    assertEquals(parsed, { cooldownMs: 1_000 });
    for (
        const input of [
            [],
            "inherit",
            0,
            true,
            new Date(),
            { unknown: 1 },
            { cooldownMs: -1 },
            { cooldownMs: 0.1 },
            { cooldownMs: NaN },
            { cooldownMs: Infinity },
            { cooldownMs: 86_400_001 },
            { cooldownMs: "1000" },
            { cooldownMs: null },
            { authCooldownMs: -1 },
            { authCooldownMs: 0.1 },
            { authCooldownMs: NaN },
            { authCooldownMs: Infinity },
            { authCooldownMs: 86_400_001 },
            { cooldownMs: 1, [Symbol("hidden")]: 2 },
            Object.create({ cooldownMs: 100 }),
        ]
    ) assertThrows(() => parseSourceHealthPolicy(input), TypeError);
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "cooldownMs", {
        enumerable: true,
        get() {
            getterCalls++;
            return 1_000;
        },
    });
    assertThrows(() => parseSourceHealthPolicy(accessor), TypeError);
    assertEquals(getterCalls, 0);
});

Deno.test("per-source health policies merge global defaults before registration and survive provider lifecycle", () => {
    const registry = new SourceRegistry({
        cooldownMs: 2_000,
        authCooldownMs: 9_000,
    });
    assertEquals(registry.healthPolicy("disabled"), {
        cooldownMs: 2_000,
        authCooldownMs: 9_000,
    });
    registry.setHealthPolicy("a", { authCooldownMs: 0 });
    assertEquals(registry.healthPolicy("a"), {
        cooldownMs: 2_000,
        authCooldownMs: 0,
    });
    const provider = source("a");
    registry.register(provider);
    registry.setHealthPolicy("a", { cooldownMs: 7_000 });
    assertStrictEquals(registry.get("a"), provider);
    assertEquals(registry.healthPolicy("a"), {
        cooldownMs: 7_000,
        authCooldownMs: 9_000,
    });
    assertEquals(registry.healthPolicy("b"), {
        cooldownMs: 2_000,
        authCooldownMs: 9_000,
    });
    registry.unregister("a");
    assertEquals(registry.healthPolicy("a"), {
        cooldownMs: 7_000,
        authCooldownMs: 9_000,
    });
    registry.register(provider);
    assertEquals(registry.healthPolicy("a").cooldownMs, 7_000);
    registry.setHealthPolicy("a", null);
    assertEquals(registry.healthPolicy("a"), {
        cooldownMs: 2_000,
        authCooldownMs: 9_000,
    });
    registry.setHealthPolicy("a", undefined);
    assertEquals(registry.healthPolicy("a"), {
        cooldownMs: 2_000,
        authCooldownMs: 9_000,
    });
    assertThrows(
        () => registry.setHealthPolicy("a", { authCooldownMs: -1 }),
        TypeError,
    );
    assertEquals(registry.healthPolicy("a"), {
        cooldownMs: 2_000,
        authCooldownMs: 9_000,
    });
});

Deno.test("source-specific policies affect subsequent authentication, upstream and probe failures", async () => {
    const registry = new SourceRegistry({
        now: () => new Date(epoch),
        sameSourceAttempts: 1,
    });
    registry.setHealthPolicy("auth", {
        cooldownMs: 100,
        authCooldownMs: 2_500,
    });
    registry.setHealthPolicy("upstream", {
        cooldownMs: 1_250,
        authCooldownMs: 0,
    });
    registry.register(source("auth", 401));
    registry.register(source("upstream", 503));
    await run(registry, "auth");
    await run(registry, "upstream");
    assertEquals(
        registry.healthSnapshot("auth").cooldown,
        cooldown(2_500, "authentication"),
    );
    assertEquals(
        registry.healthSnapshot("upstream").cooldown,
        cooldown(1_250, "upstream"),
    );
    registry.setHealthPolicy("auth", { cooldownMs: 0, authCooldownMs: 0 });
    assertEquals(
        registry.healthSnapshot("auth").cooldown,
        cooldown(2_500, "authentication"),
    );
    await run(registry, "auth");
    assertEquals(registry.healthSnapshot("auth"), { health: "ready" });
    registry.recordProbe("auth", {
        ok: false,
        message: "failed with cooldown disabled",
    });
    assertEquals(registry.healthSnapshot("auth"), { health: "ready" });
    registry.setHealthPolicy("auth", { cooldownMs: 777 });
    registry.recordProbe("auth", { ok: false, message: "fresh failure" });
    assertEquals(registry.healthSnapshot("auth").cooldown, cooldown(777));
    assertEquals(
        registry.healthSnapshot("upstream").cooldown,
        cooldown(1_250, "upstream"),
    );
});

Deno.test("health policy changes invalidate pending checks without replacing provider or existing evidence", () => {
    const registry = new SourceRegistry({ now: () => new Date(epoch) });
    const provider = source("a");
    registry.register(provider);
    registry.recordProbe("a", {
        ok: true,
        message: "models",
        models: ["remembered"],
    });
    registry.recordProbe("a", { ok: false, message: "existing failure" });
    const previous = registry.healthSnapshot("a");
    const previousProbe = registry.probeOf("a");
    const old = registry.beginHealthCheck("a");
    registry.setHealthPolicy("a", { cooldownMs: 1_000 });
    assertStrictEquals(registry.get("a"), provider);
    assertEquals(registry.healthSnapshot("a"), previous);
    assertStrictEquals(registry.probeOf("a"), previousProbe);
    assertEquals(registry.discoveredModels("a"), ["remembered"]);
    assertEquals(
        registry.recordProbe("a", {
            ok: true,
            message: "late success",
            models: ["late"],
        }, old),
        false,
    );
    assertEquals(
        registry.recordProbe("a", { ok: false, message: "late failure" }, old),
        false,
    );
    assertEquals(registry.healthSnapshot("a"), previous);
    const current = registry.beginHealthCheck("a");
    registry.setHealthPolicy("a", { cooldownMs: 1_000 });
    assertEquals(
        registry.recordProbe("a", { ok: false, message: "current" }, current),
        true,
    );
    assertEquals(registry.healthSnapshot("a").cooldown, cooldown(1_000));
    registry.setHealthPolicy("a", null);
    const inherited = registry.beginHealthCheck("a");
    registry.setHealthPolicy("a", { ...DEFAULT_SOURCE_HEALTH_POLICY });
    assertEquals(
        registry.recordProbe(
            "a",
            { ok: true, message: "equivalent policy" },
            inherited,
        ),
        true,
    );
});

Deno.test("cooldown restoration accepts bounded current state without fabricating probe evidence", () => {
    let now = epoch + 1_000;
    const registry = new SourceRegistry({ now: () => new Date(now) });
    registry.restoreCooldown("a", cooldown());
    registry.register(source("a"));
    assertEquals(registry.healthSnapshot("a"), { health: "ready" });
    const persisted = { ...cooldown() };
    registry.restoreCooldown("a", persisted);
    persisted.until = timestamp(epoch + 90_000);
    assertEquals(registry.healthSnapshot("a").cooldown, cooldown());
    assertEquals(registry.probeOf("a"), undefined);
    assertEquals(registry.discoveredModels("a"), []);
    for (
        const value of [
            null,
            [],
            {},
            { ...cooldown(), reason: "secret upstream text" },
            { ...cooldown(), startedAt: "invalid" },
            { ...cooldown(), until: "invalid" },
            { ...cooldown(), startedAt: timestamp(epoch + 2_000) },
            { ...cooldown(), until: timestamp(now) },
            { ...cooldown(), until: timestamp(epoch - 1) },
            { ...cooldown(), until: timestamp(epoch + 86_400_001) },
            { ...cooldown(), credentials: "private" },
        ]
    ) {
        registry.restoreCooldown("a", value);
        assertEquals(registry.healthSnapshot("a").cooldown, cooldown());
    }
    let accesses = 0;
    const accessor = Object.defineProperty({ ...cooldown() }, "until", {
        get() {
            accesses++;
            return timestamp(epoch + 2_000);
        },
    });
    registry.restoreCooldown("a", accessor);
    assertEquals(accesses, 0);
    assertEquals(registry.healthSnapshot("a").cooldown, cooldown());
    now = epoch + 5_000;
    assertEquals(registry.healthSnapshot("a"), { health: "ready" });
    registry.restoreCooldown("a", cooldown());
    assertEquals(registry.healthSnapshot("a"), { health: "ready" });
    assertEquals(registry.probeOf("a"), undefined);
});

Deno.test("requests already running when policy changes cannot publish health using the old policy", async (test) => {
    for (const outcome of [undefined, 401, 503] as const) {
        await test.step(String(outcome ?? "success"), async () => {
            const started = Promise.withResolvers<void>();
            const resumed = Promise.withResolvers<void>();
            const provider = source("a", outcome);
            const registry = new SourceRegistry({
                now: () => new Date(epoch),
                sameSourceAttempts: 1,
            });
            registry.register({
                ...provider,
                async *execute(input, context) {
                    started.resolve();
                    await resumed.promise;
                    yield* provider.execute(input, context);
                },
            });
            registry.recordProbe("a", {
                ok: false,
                message: "existing failure",
            });
            const previous = registry.healthSnapshot("a");
            const pending = run(registry, "a");
            await started.promise;
            registry.setHealthPolicy("a", {
                cooldownMs: 123,
                authCooldownMs: 456,
            });
            resumed.resolve();
            await pending;
            assertEquals(registry.healthSnapshot("a"), previous);
        });
    }
});

Deno.test("health observers receive isolated cooldown snapshots, all reset paths and explicit empty clears", async () => {
    let now = epoch;
    const registry = new SourceRegistry({
        now: () => new Date(now),
        sameSourceAttempts: 1,
    });
    registry.register(source("a"));
    const seen: { id: string; value: SourceCooldown | undefined }[] = [];
    registry.subscribeHealth((_id, value) => {
        if (value) {
            try {
                (value as { until: string }).until = "corrupted by listener";
            } catch { /* A frozen snapshot is expected to reject writes. */ }
        }
        throw new Error("listener failed");
    });
    const unsubscribe = registry.subscribeHealth((id, value) =>
        seen.push({ id, value })
    );
    registry.recordProbe("a", { ok: false, message: "private upstream text" });
    assertEquals(seen, [{ id: "a", value: cooldown(30_000) }]);
    assertEquals(registry.healthSnapshot("a").cooldown, cooldown(30_000));
    registry.clearCooldown("a");
    assertEquals(seen.at(-1), { id: "a", value: undefined });
    const beforeEmptyClear = seen.length;
    registry.clearCooldown("a");
    assertEquals(seen.length, beforeEmptyClear + 1);
    assertEquals(seen.at(-1), { id: "a", value: undefined });
    registry.recordProbe("a", { ok: false, message: "failure" });
    registry.recordProbe("a", { ok: true, message: "success" });
    assertEquals(seen.at(-1), { id: "a", value: undefined });
    registry.recordProbe("a", { ok: false, message: "failure" });
    await run(registry, "a");
    assertEquals(seen.at(-1), { id: "a", value: undefined });
    registry.recordProbe("a", { ok: false, message: "failure" });
    now += 30_000;
    assertEquals(registry.healthOf("a"), "ready");
    assertEquals(seen.at(-1), { id: "a", value: undefined });
    const afterExpire = seen.length;
    registry.healthOf("a");
    assertEquals(seen.length, afterExpire);
    registry.recordProbe("a", { ok: false, message: "failure" });
    registry.replace(source("a"));
    assertEquals(seen.at(-1), { id: "a", value: undefined });
    registry.recordProbe("a", { ok: false, message: "failure" });
    registry.unregister("a");
    assertEquals(seen.at(-1), { id: "a", value: undefined });
    const count = seen.length;
    unsubscribe();
    unsubscribe();
    registry.register(source("a"));
    registry.recordProbe("a", { ok: false, message: "failure" });
    assertEquals(seen.length, count);
    assert(!JSON.stringify(seen).includes("private upstream text"));
});
