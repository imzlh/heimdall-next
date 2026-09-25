import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import type { OperationRequest, StreamEvent, StreamFrame } from "@heimdall/hip";
import type { InferenceSource } from "@heimdall/contracts";
import { SourceRegistry } from "@heimdall/kernel";

function request(): OperationRequest {
    return {
        version: 1,
        requestId: "req-1",
        operation: "generation.create",
        payload: { messages: [], model: "model-a" },
        traits: { model: "model-a", streaming: true },
    };
}

function frame(
    input: OperationRequest,
    seq: number,
    event: StreamEvent,
): StreamFrame {
    return {
        version: 1,
        streamId: "stream-1",
        requestId: input.requestId,
        seq,
        eventId: `stream-1:${seq}`,
        timestamp: "2026-09-22T00:00:00.000Z",
        event,
    };
}

function source(
    id: string,
    behavior: "ok" | "status" | "text-then-error" | "cancel",
    status = 200,
    calls: string[] = [],
): InferenceSource {
    return {
        id,
        capabilities: [{
            operation: "generation.create",
            models: ["model-a"],
            streaming: true,
            priority: 1,
        }],
        execute(input) {
            calls.push(id);
            return (async function* () {
                yield frame(input, 1, { kind: "run.started", request: input });
                if (behavior === "ok") {
                    yield frame(input, 2, {
                        kind: "run.completed",
                        finishReason: "stop",
                    });
                    return;
                }
                if (behavior === "cancel") {
                    yield frame(input, 2, {
                        kind: "run.cancelled",
                        reason: "client",
                    });
                    return;
                }
                if (behavior === "text-then-error") {
                    yield frame(input, 2, {
                        kind: "part.started",
                        messageId: "m",
                        part: { id: "p", type: "text", text: "" },
                    });
                    yield frame(input, 3, {
                        kind: "run.error",
                        error: {
                            code: "upstream_error",
                            message: "broke after output",
                            status: 502,
                            retryable: true,
                        },
                    });
                    return;
                }
                yield frame(input, 2, {
                    kind: "run.error",
                    error: {
                        code: "upstream_error",
                        message: `status ${status}`,
                        status,
                        retryable: status >= 500,
                    },
                });
            })();
        },
    };
}

async function kinds(
    registry: SourceRegistry,
    input = request(),
): Promise<string[]> {
    const result: string[] = [];
    for await (
        const item of registry.run(input, {
            requestId: input.requestId,
            signal: new AbortController().signal,
            metadata: {},
        })
    ) result.push(item.event.kind);
    return result;
}

Deno.test("source registry fails over before content and cools the failed source", async () => {
    const calls: string[] = [];
    const registry = new SourceRegistry({ cooldownMs: 1_000 });
    registry.register(source("bad", "status", 503, calls));
    registry.register(source("good", "ok", 200, calls));
    assertEquals(await kinds(registry), ["run.started", "run.completed"]);
    assertEquals(calls, ["bad", "bad", "bad", "good"]);
    assertEquals(registry.healthOf("bad"), "cooldown");
    assertEquals(registry.healthOf("good"), "ready");
    assertEquals(registry.select(request()).id, "good");
});

Deno.test("source registry does not fail over after output or on a client error", async () => {
    const contentCalls: string[] = [];
    const content = new SourceRegistry();
    content.register(source("bad", "text-then-error", 502, contentCalls));
    content.register(source("good", "ok", 200, contentCalls));
    assertEquals(await kinds(content), [
        "run.started",
        "part.started",
        "run.error",
    ]);
    assertEquals(contentCalls, ["bad"]);
    assertEquals(content.healthOf("bad"), "ready");

    const rejectedCalls: string[] = [];
    const rejected = new SourceRegistry();
    rejected.register(source("bad", "status", 400, rejectedCalls));
    rejected.register(source("good", "ok", 200, rejectedCalls));
    assertEquals(await kinds(rejected), ["run.started", "run.error"]);
    assertEquals(rejectedCalls, ["bad"]);
    assertEquals(rejected.healthOf("bad"), "ready");
});

Deno.test("upstream authentication cools a source without moving the request", async () => {
    const calls: string[] = [];
    let now = Date.parse("2026-09-22T00:00:00.000Z");
    const registry = new SourceRegistry({
        now: () => new Date(now),
        authCooldownMs: 5_000,
    });
    registry.register(source("bad", "status", 401, calls));
    registry.register(source("good", "ok", 200, calls));
    assertEquals(await kinds(registry), ["run.started", "run.error"]);
    assertEquals(calls, ["bad"]);
    assertEquals(registry.healthOf("bad"), "cooldown");
    assertEquals(registry.select(request()).id, "good");
    now += 5_000;
    assertEquals(registry.healthOf("bad"), "ready");
});

Deno.test("failover stops after three sources and reports the last upstream error", async () => {
    const calls: string[] = [];
    const registry = new SourceRegistry({ maxAttempts: 3 });
    for (const id of ["a", "b", "c", "d"]) {
        registry.register(source(id, "status", 503, calls));
    }
    const input = request();
    const frames: StreamFrame[] = [];
    for await (
        const item of registry.run(input, {
            requestId: input.requestId,
            signal: new AbortController().signal,
            metadata: {},
        })
    ) frames.push(item);
    assertEquals(calls, ["a", "a", "a", "b", "b", "b", "c", "c", "c"]);
    assertEquals(frames.map((item) => item.event.kind), [
        "run.started",
        "run.error",
    ]);
    assertEquals(
        frames[1]?.event.kind === "run.error"
            ? frames[1].event.error.status
            : undefined,
        503,
    );
    assertEquals(frames[0]?.streamId, "failover:req-1");
});

Deno.test("a 404 fails over immediately instead of retrying the same source", async () => {
    const calls: string[] = [];
    const registry = new SourceRegistry();
    const input = request();
    registry.register({
        id: "bad",
        capabilities: [{
            operation: "generation.create",
            models: ["model-a"],
            streaming: true,
            priority: 1,
        }],
        execute() {
            calls.push("bad");
            return (async function* () {
                yield frame(input, 1, { kind: "run.started", request: input });
                yield frame(input, 2, {
                    kind: "run.error",
                    error: {
                        code: "upstream_error",
                        message: "missing",
                        status: 404,
                        retryable: true,
                    },
                });
            })();
        },
    });
    registry.register(source("good", "ok", 200, calls));
    assertEquals(await kinds(registry), ["run.started", "run.completed"]);
    assertEquals(calls, ["bad", "good"]);
    assertEquals(registry.healthOf("bad"), "cooldown");
});

Deno.test("cancellation does not cool the selected source", async () => {
    const calls: string[] = [];
    const registry = new SourceRegistry();
    registry.register(source("bad", "cancel", 200, calls));
    registry.register(source("good", "ok", 200, calls));
    assertEquals(await kinds(registry), ["run.started", "run.cancelled"]);
    assertEquals(calls, ["bad"]);
    assertEquals(registry.healthOf("bad"), "ready");
});

Deno.test("source exceptions after text or tool output never retry the request", async (test) => {
    const events: StreamEvent[] = [
        {
            kind: "part.started",
            messageId: "message-1",
            part: { id: "part-1", type: "text", text: "visible output" },
        },
        {
            kind: "tool.call",
            messageId: "message-1",
            callId: "call-1",
            name: "external_action",
            arguments: {},
        },
    ];
    for (const event of events) {
        await test.step(event.kind, async () => {
            const calls: string[] = [];
            const failure = new Error("connection closed after output");
            const registry = new SourceRegistry();
            registry.register({
                ...source("primary", "ok"),
                async *execute(input) {
                    calls.push("primary");
                    yield frame(input, 1, {
                        kind: "run.started",
                        request: input,
                    });
                    yield frame(input, 2, event);
                    throw failure;
                },
            });
            registry.register(source("backup", "ok", 200, calls));
            const seen: StreamFrame[] = [];
            const input = request();
            const error = await assertRejects(async () => {
                for await (
                    const item of registry.run(input, {
                        requestId: input.requestId,
                        signal: new AbortController().signal,
                        metadata: {},
                    })
                ) seen.push(item);
            });
            assertStrictEquals(error, failure);
            assertEquals(calls, ["primary"]);
            assertEquals(seen.map((item) => item.event.kind), [
                "run.started",
                event.kind,
            ]);
            assertEquals(registry.healthOf("primary"), "ready");
        });
    }
});

Deno.test("a thrown failure before output still retries and fails over", async () => {
    const calls: string[] = [];
    const registry = new SourceRegistry();
    registry.register({
        ...source("primary", "ok"),
        async *execute(input) {
            calls.push("primary");
            yield frame(input, 1, { kind: "run.started", request: input });
            throw new Error("connection closed before output");
        },
    });
    registry.register(source("backup", "ok", 200, calls));
    assertEquals(await kinds(registry), ["run.started", "run.completed"]);
    assertEquals(calls, ["primary", "primary", "primary", "backup"]);
    assertEquals(registry.healthOf("primary"), "cooldown");
});

Deno.test("terminal output cannot be retried when source cleanup throws", async (test) => {
    const events: StreamEvent[] = [
        {
            kind: "run.error",
            error: { code: "invalid_request", message: "invalid", status: 400 },
        },
        { kind: "run.cancelled", reason: "upstream cancelled" },
    ];
    for (const event of events) {
        await test.step(event.kind, async () => {
            const calls: string[] = [];
            const registry = new SourceRegistry();
            const failure = new Error("source cleanup failed");
            registry.register({
                ...source("primary", "ok"),
                async *execute(input) {
                    calls.push("primary");
                    try {
                        yield frame(input, 1, {
                            kind: "run.started",
                            request: input,
                        });
                        yield frame(input, 2, event);
                    } finally {
                        // Deliberately model a provider failing during close.
                        // deno-lint-ignore no-unsafe-finally
                        throw failure;
                    }
                },
            });
            registry.register(source("backup", "ok", 200, calls));
            assertStrictEquals(
                await assertRejects(() => kinds(registry)),
                failure,
            );
            assertEquals(calls, ["primary"]);
            assertEquals(registry.healthOf("primary"), "ready");
        });
    }
});

Deno.test("an already cancelled request never selects or executes a source", async () => {
    const calls: string[] = [];
    const registry = new SourceRegistry();
    registry.register(source("primary", "ok", 200, calls));
    const controller = new AbortController();
    const reason = new Error("request deadline elapsed");
    controller.abort(reason);
    const input = request();
    const error = await assertRejects(async () => {
        for await (
            const _ of registry.run(input, {
                requestId: input.requestId,
                signal: controller.signal,
                metadata: {},
            })
        ) { /* A cancelled request must not produce frames. */ }
    });
    assertStrictEquals(error, reason);
    assertEquals(calls, []);
    assertEquals(registry.healthOf("primary"), "ready");
});

Deno.test("cancellation takes precedence over thrown or framed upstream failures", async (test) => {
    for (const behavior of ["throw", "frame"] as const) {
        await test.step(behavior, async () => {
            const calls: string[] = [];
            const registry = new SourceRegistry();
            const controller = new AbortController();
            const reason = new Error("caller disconnected");
            registry.register({
                ...source("primary", "ok"),
                async *execute(input) {
                    calls.push("primary");
                    yield frame(input, 1, {
                        kind: "run.started",
                        request: input,
                    });
                    controller.abort(reason);
                    if (behavior === "throw") throw new Error("fetch aborted");
                    yield frame(input, 2, {
                        kind: "run.error",
                        error: {
                            code: "upstream_error",
                            message: "fetch aborted",
                            retryable: true,
                            status: 503,
                        },
                    });
                },
            });
            registry.register(source("backup", "ok", 200, calls));
            const seen: StreamFrame[] = [];
            const input = request();
            const error = await assertRejects(async () => {
                for await (
                    const item of registry.run(input, {
                        requestId: input.requestId,
                        signal: controller.signal,
                        metadata: {},
                    })
                ) seen.push(item);
            });
            assertStrictEquals(error, reason);
            assertEquals(calls, ["primary"]);
            assertEquals(seen, []);
            assertEquals(registry.healthOf("primary"), "ready");
        });
    }
});

Deno.test("failover skips backup instances removed or replaced while the primary is pending", async (test) => {
    for (const change of ["unregister", "replace"] as const) {
        await test.step(change, async () => {
            const calls: string[] = [];
            const registry = new SourceRegistry({ sameSourceAttempts: 1 });
            const primary = pausedSource("primary", "retryable", calls);
            registry.register(primary.source);
            registry.register(source("backup", "ok", 200, calls));
            registry.register(source("fallback", "ok", 200, calls));
            const pending = kinds(registry);
            await primary.started;
            if (change === "unregister") registry.unregister("backup");
            else {
                // The replacement no longer supports this request's model.
                // Neither the old object nor a blind same-id lookup may run.
                registry.replace({
                    ...source("replacement", "ok", 200, calls),
                    id: "backup",
                    capabilities: [{
                        operation: "generation.create",
                        models: ["other-model"],
                        streaming: true,
                    }],
                });
            }
            primary.release();
            assertEquals(await pending, ["run.started", "run.completed"]);
            assertEquals(calls, ["primary", "fallback"]);
        });
    }
});

Deno.test("an in-flight source is never retried after it was removed or replaced", async (test) => {
    for (const outcome of ["throw", "retryable"] as const) {
        for (const change of ["unregister", "replace"] as const) {
            await test.step(`${outcome}: ${change}`, async () => {
                const calls: string[] = [];
                const registry = new SourceRegistry({ sameSourceAttempts: 3 });
                const primary = pausedSource("primary", outcome, calls);
                registry.register(primary.source);
                registry.register(source("backup", "ok", 200, calls));
                const pending = kinds(registry);
                await primary.started;
                if (change === "unregister") registry.unregister("primary");
                else {
                    registry.replace({
                        ...source("replacement", "ok", 200, calls),
                        id: "primary",
                    });
                }
                primary.release();
                assertEquals(await pending, ["run.started", "run.completed"]);
                assertEquals(calls, ["primary", "backup"]);
                if (change === "replace") {
                    // New requests use the new instance normally.
                    assertEquals(await kinds(registry), [
                        "run.started",
                        "run.completed",
                    ]);
                    assertEquals(calls, ["primary", "backup", "replacement"]);
                }
            });
        }
    }
});

Deno.test("late results cannot change a replacement channel's health", async (test) => {
    for (const outcome of ["throw", "retryable", "auth", "ok"] as const) {
        for (const change of ["replace", "unregister"] as const) {
            await test.step(`${outcome}: ${change}`, async () => {
                const calls: string[] = [];
                const registry = new SourceRegistry({ sameSourceAttempts: 1 });
                const primary = pausedSource("primary", outcome, calls);
                registry.register(primary.source);
                const pending = kinds(registry);
                await primary.started;
                const replacement = source("primary", "ok", 200, calls);
                if (change === "replace") registry.replace(replacement);
                else registry.unregister("primary");
                if (outcome === "ok" && change === "replace") {
                    registry.recordProbe("primary", {
                        ok: false,
                        message: "replacement probe failed",
                    });
                }
                primary.release();
                assertEquals(await pending, [
                    "run.started",
                    outcome === "ok" ? "run.completed" : "run.error",
                ]);
                assertEquals(calls, ["primary"]);
                if (change === "unregister") registry.register(replacement);
                assertEquals(
                    registry.healthOf("primary"),
                    outcome === "ok" && change === "replace"
                        ? "cooldown"
                        : "ready",
                );
            });
        }
    }
});

function pausedSource(
    id: string,
    outcome: "throw" | "retryable" | "auth" | "ok",
    calls: string[],
): {
    source: InferenceSource;
    started: Promise<void>;
    release: () => void;
} {
    const started = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    return {
        started: started.promise,
        release: () => resumed.resolve(),
        source: {
            ...source(id, "ok"),
            async *execute(input) {
                calls.push(id);
                started.resolve();
                yield frame(input, 1, { kind: "run.started", request: input });
                await resumed.promise;
                if (outcome === "throw") throw new Error("late source failure");
                yield frame(
                    input,
                    2,
                    outcome === "ok"
                        ? { kind: "run.completed", finishReason: "stop" }
                        : {
                            kind: "run.error",
                            error: {
                                code: "upstream_error",
                                message: "late source failure",
                                status: outcome === "auth" ? 401 : 503,
                                retryable: outcome !== "auth",
                            },
                        },
                );
            },
        },
    };
}
