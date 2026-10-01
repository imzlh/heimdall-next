import {
    assert,
    assertEquals,
    assertRejects,
    assertStrictEquals,
    assertThrows,
} from "@std/assert";
import type { InferenceSource, SourceProbeResult } from "@heimdall/contracts";
import type { OperationRequest, StreamEvent, StreamFrame } from "@heimdall/hip";
import { SourceRegistry } from "@heimdall/kernel";
import { probeSource } from "@heimdall/core/composition/probe-loop.ts";

const sourceId = "health-channel";
const epoch = Date.parse("2026-09-29T00:00:00.000Z");
const upstreamSecret = "https://private.example?key=upstream-private-key";
type Outcome = "ok" | "throw" | 401 | 403 | 404 | 429 | 503;

function request(): OperationRequest {
    return {
        version: 1,
        requestId: "health-request",
        operation: "generation.create",
        payload: { messages: [] },
        traits: { streaming: true },
    };
}

function frame(
    input: OperationRequest,
    seq: number,
    event: StreamEvent,
): StreamFrame {
    return {
        version: 1,
        streamId: "health-stream",
        requestId: input.requestId,
        seq,
        eventId: `health-stream:${seq}`,
        timestamp: new Date(epoch).toISOString(),
        event,
    };
}

function source(outcome: Outcome = "ok", resumed?: Promise<void>): {
    source: InferenceSource;
    started: Promise<void>;
} {
    const started = Promise.withResolvers<void>();
    return {
        started: started.promise,
        source: {
            id: sourceId,
            capabilities: [{ operation: "generation.create", streaming: true }],
            async *execute(input) {
                started.resolve();
                yield frame(input, 1, { kind: "run.started", request: input });
                if (resumed) await resumed;
                if (outcome === "throw") throw new Error(upstreamSecret);
                yield frame(
                    input,
                    2,
                    outcome === "ok"
                        ? { kind: "run.completed", finishReason: "stop" }
                        : {
                            kind: "run.error",
                            error: {
                                code: "upstream_error",
                                message: upstreamSecret,
                                status: outcome,
                            },
                        },
                );
            },
        },
    };
}

async function run(
    registry: SourceRegistry,
    signal = new AbortController().signal,
): Promise<string[]> {
    const input = request();
    const kinds: string[] = [];
    for await (
        const item of registry.run(input, {
            requestId: input.requestId,
            signal,
            metadata: {},
        })
    ) kinds.push(item.event.kind);
    return kinds;
}

Deno.test("health snapshots expose bounded reasons and expire without fabricating successful probes", async (test) => {
    const scenarios = [
        { outcome: 401, reason: "authentication", duration: 5_000 },
        { outcome: 403, reason: "authentication", duration: 5_000 },
        { outcome: 429, reason: "rate_limit", duration: 1_000 },
        { outcome: 404, reason: "upstream", duration: 1_000 },
        { outcome: 503, reason: "upstream", duration: 1_000 },
        { outcome: "throw", reason: "transport", duration: 1_000 },
    ] as const;
    for (const scenario of scenarios) {
        await test.step(String(scenario.outcome), async () => {
            let now = epoch;
            const registry = new SourceRegistry({
                now: () => new Date(now),
                cooldownMs: 1_000,
                authCooldownMs: 5_000,
                sameSourceAttempts: 1,
            });
            registry.register(source(scenario.outcome).source);
            assertEquals(await run(registry), ["run.started", "run.error"]);
            const snapshot = registry.healthSnapshot(sourceId);
            assertEquals(snapshot, {
                health: "cooldown",
                cooldown: {
                    reason: scenario.reason,
                    startedAt: new Date(epoch).toISOString(),
                    until: new Date(epoch + scenario.duration).toISOString(),
                },
            });
            assert(!JSON.stringify(snapshot).includes(upstreamSecret));
            assertEquals(registry.probeOf(sourceId), undefined);
            now += scenario.duration - 1;
            assertEquals(registry.healthOf(sourceId), "cooldown");
            now++;
            assertEquals(registry.healthSnapshot(sourceId), {
                health: "ready",
            });
            assertEquals(registry.healthOf(sourceId), "ready");
            assertEquals(registry.select(request()).id, sourceId);
            assertEquals(registry.probeOf(sourceId), undefined);
        });
    }
});

Deno.test("manual cooldown reset preserves failed probe evidence and discovered models", () => {
    const registry = new SourceRegistry({ now: () => new Date(epoch) });
    registry.register(source().source);
    registry.recordProbe(sourceId, {
        ok: true,
        message: "models available",
        models: ["remembered-model"],
    });
    registry.recordProbe(sourceId, { ok: false, message: "probe unavailable" });
    const probe = registry.probeOf(sourceId);
    assertEquals(registry.healthSnapshot(sourceId).cooldown?.reason, "probe");
    const pending = registry.beginHealthCheck(sourceId);
    assertEquals(registry.clearCooldown(sourceId), { health: "ready" });
    assertStrictEquals(registry.probeOf(sourceId), probe);
    assertEquals(registry.discoveredModels(sourceId), ["remembered-model"]);
    assertEquals(
        registry.recordProbe(sourceId, { ok: true, message: "stale" }, pending),
        false,
    );
    assertStrictEquals(registry.probeOf(sourceId), probe);
    assertEquals(registry.clearCooldown(sourceId), { health: "ready" });
    assertThrows(() => registry.clearCooldown("missing"), TypeError);
    assertThrows(() => registry.healthSnapshot("missing"), TypeError);
});

Deno.test("new probes and replacement instances reject old health tokens", async (test) => {
    for (
        const change of [
            "new-probe",
            "replace",
            "preserve",
            "reregister",
        ] as const
    ) {
        await test.step(change, () => {
            const registry = new SourceRegistry({ now: () => new Date(epoch) });
            registry.register(source().source);
            registry.recordProbe(sourceId, {
                ok: true,
                message: "discovered",
                models: ["original-model"],
            });
            registry.recordProbe(sourceId, {
                ok: false,
                message: "original failure",
            });
            const original = registry.healthSnapshot(sourceId);
            const originalProbe = registry.probeOf(sourceId);
            const stale = registry.beginHealthCheck(sourceId);
            if (change === "new-probe") {
                const current = registry.beginHealthCheck(sourceId);
                assertEquals(
                    registry.recordProbe(sourceId, {
                        ok: false,
                        message: "current failure",
                    }, current),
                    true,
                );
            } else if (change === "reregister") {
                registry.unregister(sourceId);
                assertEquals(
                    registry.recordProbe(sourceId, {
                        ok: true,
                        message: "removed result",
                    }, stale),
                    false,
                );
                registry.register(source().source);
            } else {
                registry.replace(source().source, {
                    preserveDiscovery: change === "preserve",
                });
            }
            const expectedHealth = registry.healthSnapshot(sourceId);
            const expectedProbe = registry.probeOf(sourceId);
            const expectedModels = registry.discoveredModels(sourceId);
            for (const ok of [true, false]) {
                assertEquals(
                    registry.recordProbe(sourceId, {
                        ok,
                        message: "late result",
                        models: ["late-model"],
                    }, stale),
                    false,
                );
                assertEquals(registry.healthSnapshot(sourceId), expectedHealth);
                assertStrictEquals(registry.probeOf(sourceId), expectedProbe);
                assertEquals(
                    registry.discoveredModels(sourceId),
                    expectedModels,
                );
            }
            if (change === "preserve") {
                assertEquals(expectedHealth, original);
                assertStrictEquals(expectedProbe, originalProbe);
                assertEquals(expectedModels, ["original-model"]);
            } else if (change !== "new-probe") {
                assertEquals(expectedHealth, { health: "ready" });
                assertEquals(expectedProbe, undefined);
                assertEquals(expectedModels, []);
            }
        });
    }
});

Deno.test("late request success and failure cannot undo an operator reset, newer probe, or replacement", async (test) => {
    for (const outcome of ["ok", "throw", 401, 503] as const) {
        for (
            const change of ["reset", "probe", "replace", "preserve"] as const
        ) {
            await test.step(`${outcome}: ${change}`, async () => {
                let now = epoch;
                const resumed = Promise.withResolvers<void>();
                const paused = source(outcome, resumed.promise);
                const registry = new SourceRegistry({
                    now: () => new Date(now),
                    sameSourceAttempts: 1,
                });
                registry.register(paused.source);
                registry.recordProbe(sourceId, {
                    ok: false,
                    message: "existing probe failure",
                });
                const pending = run(registry);
                await paused.started;
                if (change === "reset") registry.clearCooldown(sourceId);
                else if (change === "probe") {
                    registry.recordProbe(sourceId, {
                        ok: false,
                        message: "newer probe failure",
                    });
                } else {
                    registry.replace(source().source, {
                        preserveDiscovery: change === "preserve",
                    });
                }
                const expectedHealth = registry.healthSnapshot(sourceId);
                const expectedProbe = registry.probeOf(sourceId);
                now += 1_000;
                resumed.resolve();
                assertEquals(await pending, [
                    "run.started",
                    outcome === "ok" ? "run.completed" : "run.error",
                ]);
                assertEquals(registry.healthSnapshot(sourceId), expectedHealth);
                assertStrictEquals(registry.probeOf(sourceId), expectedProbe);
            });
        }
    }
});

Deno.test("concurrent requests apply completed health results without letting an older completion overwrite a newer one", async (test) => {
    for (const completionOrder of ["older-first", "newer-first"] as const) {
        await test.step(completionOrder, async () => {
            const firstResume = Promise.withResolvers<void>();
            const secondResume = Promise.withResolvers<void>();
            const first = source(503, firstResume.promise);
            const second = source("ok", secondResume.promise);
            let calls = 0;
            const registry = new SourceRegistry({ sameSourceAttempts: 1 });
            registry.register({
                ...first.source,
                execute(input, context) {
                    const selected = calls++ === 0 ? first : second;
                    return selected.source.execute(input, context);
                },
            });
            const firstPending = run(registry);
            await first.started;
            const secondPending = run(registry);
            await second.started;
            if (completionOrder === "older-first") {
                firstResume.resolve();
                assertEquals(await firstPending, ["run.started", "run.error"]);
                assertEquals(
                    registry.healthSnapshot(sourceId).cooldown?.reason,
                    "upstream",
                );
                secondResume.resolve();
                assertEquals(await secondPending, [
                    "run.started",
                    "run.completed",
                ]);
            } else {
                secondResume.resolve();
                assertEquals(await secondPending, [
                    "run.started",
                    "run.completed",
                ]);
                assertEquals(registry.healthSnapshot(sourceId), {
                    health: "ready",
                });
                firstResume.resolve();
                assertEquals(await firstPending, ["run.started", "run.error"]);
            }
            assertEquals(registry.healthSnapshot(sourceId), {
                health: "ready",
            });
            assertEquals(calls, 2);
        });
    }
});

Deno.test("concurrent operator probes publish completed results while a newer probe is pending", async (test) => {
    for (const completionOrder of ["older-first", "newer-first"] as const) {
        await test.step(completionOrder, async () => {
            const firstResult = Promise.withResolvers<SourceProbeResult>();
            const secondResult = Promise.withResolvers<SourceProbeResult>();
            const firstStarted = Promise.withResolvers<void>();
            const secondStarted = Promise.withResolvers<void>();
            let calls = 0;
            const registry = new SourceRegistry();
            registry.register({
                ...source().source,
                probe() {
                    if (calls++ === 0) {
                        firstStarted.resolve();
                        return firstResult.promise;
                    }
                    secondStarted.resolve();
                    return secondResult.promise;
                },
            });
            const firstPending = probeSource(registry, sourceId);
            await firstStarted.promise;
            const secondPending = probeSource(registry, sourceId);
            await secondStarted.promise;
            const failure = { ok: false, message: "older probe failed" };
            const success = {
                ok: true,
                message: "newer probe succeeded",
                models: ["newer-model"],
            };
            if (completionOrder === "older-first") {
                firstResult.resolve(failure);
                assertEquals(await firstPending, failure);
                assertEquals(
                    registry.healthSnapshot(sourceId).cooldown?.reason,
                    "probe",
                );
                assertEquals(registry.probeOf(sourceId)?.ok, false);
                secondResult.resolve(success);
                assertEquals(await secondPending, success);
            } else {
                secondResult.resolve(success);
                assertEquals(await secondPending, success);
                firstResult.resolve(failure);
                assertEquals(await firstPending, undefined);
            }
            assertEquals(registry.healthSnapshot(sourceId), {
                health: "ready",
            });
            assertEquals(registry.probeOf(sourceId)?.message, success.message);
            assertEquals(registry.discoveredModels(sourceId), ["newer-model"]);
        });
    }
});

Deno.test("cooldown policies reject non-finite, fractional, negative and excessively long durations", () => {
    for (const value of [-1, 0.5, NaN, Infinity, 86_400_001]) {
        assertThrows(
            () => new SourceRegistry({ cooldownMs: value }),
            TypeError,
        );
        assertThrows(
            () => new SourceRegistry({ authCooldownMs: value }),
            TypeError,
        );
    }
    new SourceRegistry({ cooldownMs: 0, authCooldownMs: 86_400_000 });
});

Deno.test("cancelled requests do not overwrite the current cooldown with late failures or success", async (test) => {
    for (const outcome of ["ok", "throw", 401, 503] as const) {
        await test.step(String(outcome), async () => {
            const resumed = Promise.withResolvers<void>();
            const paused = source(outcome, resumed.promise);
            const registry = new SourceRegistry({ sameSourceAttempts: 1 });
            registry.register(paused.source);
            const controller = new AbortController();
            const pending = run(registry, controller.signal);
            await paused.started;
            registry.recordProbe(sourceId, {
                ok: false,
                message: "operator probe failure",
            });
            const expected = registry.healthSnapshot(sourceId);
            const reason = new Error("caller cancelled");
            controller.abort(reason);
            resumed.resolve();
            assertStrictEquals(await assertRejects(() => pending), reason);
            assertEquals(registry.healthSnapshot(sourceId), expected);
        });
    }
});

Deno.test("an actual operator probe completing after a reset cannot revive cooldown or replace probe evidence", async (test) => {
    for (const ok of [true, false]) {
        await test.step(ok ? "success" : "failure", async () => {
            const result = Promise.withResolvers<SourceProbeResult>();
            const started = Promise.withResolvers<void>();
            const registry = new SourceRegistry();
            registry.register({
                ...source().source,
                probe: () => {
                    started.resolve();
                    return result.promise;
                },
            });
            registry.recordProbe(sourceId, {
                ok: false,
                message: "previous probe failed",
            });
            const previous = registry.probeOf(sourceId);
            const pending = probeSource(registry, sourceId);
            await started.promise;
            registry.clearCooldown(sourceId);
            result.resolve({
                ok,
                message: "late probe",
                models: ["late-model"],
            });
            assertEquals(await pending, undefined);
            assertEquals(registry.healthSnapshot(sourceId), {
                health: "ready",
            });
            assertStrictEquals(registry.probeOf(sourceId), previous);
            assertEquals(registry.discoveredModels(sourceId), []);
        });
    }
});
