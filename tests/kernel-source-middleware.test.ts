import { assertEquals, assertRejects } from "@std/assert";
import type {
    GenerationRequest,
    InferenceSource,
    MiddlewarePlugin,
    OperationRequest,
    RequestContext,
    StreamEvent,
    StreamFrame,
} from "@heimdall/contracts";
import {
    KernelRuntime,
    MiddlewareRegistry,
    SourceMiddlewareError,
    SourceRegistry,
    SourceUnavailableError,
} from "@heimdall/kernel";
import { applySourceSettings } from "@heimdall/core/composition/source-records.ts";

function request(): OperationRequest<GenerationRequest> {
    return {
        version: 1,
        requestId: "bound-request",
        operation: "generation.create",
        traits: { model: "public", streaming: true },
        payload: { model: "public", messages: [], instructions: "" },
        metadata: { identity: "original" },
    };
}

function frame(
    input: OperationRequest,
    seq: number,
    event: StreamEvent,
): StreamFrame {
    return {
        version: 1,
        requestId: input.requestId,
        streamId: "bound-stream",
        seq,
        eventId: `bound:${seq}`,
        timestamp: "2026-10-01T00:00:00.000Z",
        event,
    };
}

function provider(
    id: string,
    execute?: InferenceSource["execute"],
): InferenceSource {
    return {
        id,
        capabilities: [{ operation: "generation.create", streaming: true }],
        execute: execute ?? (async function* (input) {
            yield frame(input, 1, { kind: "run.started", request: input });
            yield frame(input, 2, {
                kind: "part.delta",
                messageId: "m",
                partId: "p",
                delta: "answer",
            });
            yield frame(input, 3, { kind: "run.completed" });
        }),
    };
}

function middleware(
    id: string,
    calls: string[],
    order: number,
): MiddlewarePlugin {
    return {
        manifest: {
            id,
            version: "1.0.0",
            apiVersion: "1",
            name: id,
            kind: "middleware",
            trust: "trusted",
        },
        order,
        transformRequest(input) {
            calls.push(`request:${id}`);
            // Even an in-place mutation must not leak between source attempts.
            const payload = input.payload as { instructions: string };
            payload.instructions += id;
        },
        transformFrames(_input, _context, frames) {
            calls.push(`frames:${id}`);
            return (async function* () {
                for await (const item of frames) {
                    yield item.event.kind === "part.delta" &&
                            typeof item.event.delta === "string"
                        ? {
                            ...item,
                            event: {
                                ...item.event,
                                delta: item.event.delta + id,
                            },
                        }
                        : item;
                }
            })();
        },
    };
}

async function execution(
    runtime: KernelRuntime,
    controller = new AbortController(),
) {
    const input = request();
    const context: RequestContext = {
        requestId: input.requestId,
        request: new Request("http://localhost/v1/chat/completions"),
        route: {
            path: "/v1/chat/completions",
            method: "POST",
            operation: input.operation,
        },
        signal: controller.signal,
        metadata: { trace: "test" },
    };
    return await runtime.run(
        input,
        runtime.createLifecycle(input, controller.signal),
        {
            requestContext: context,
        },
    );
}

async function collect(
    frames: AsyncIterable<StreamFrame>,
): Promise<StreamFrame[]> {
    const result = [];
    for await (const item of frames) result.push(item);
    return result;
}

for (const mode of ["inherit", "explicit", "empty"] as const) {
    Deno.test(`source middleware ${mode} selects one chain and preserves explicit order`, async () => {
        const calls: string[] = [];
        const registry = new MiddlewareRegistry();
        registry.register(middleware("a", calls, 0));
        registry.register(middleware("b", calls, 10));
        const sources = new SourceRegistry();
        sources.register(provider("source"));
        sources.register(
            applySourceSettings(provider("other"), { priority: 100 }),
        );
        const bindings = new Map<string, readonly string[]>([["other", []]]);
        if (mode === "explicit") bindings.set("source", ["b", "disabled", "a"]);
        if (mode === "empty") bindings.set("source", []);
        const runtime = new KernelRuntime({
            sources,
            middleware: registry,
            sourceMiddleware: () => bindings,
        });
        const prepared = await execution(runtime);
        const frames = await collect(prepared.frames);
        const expected = mode === "empty"
            ? []
            : mode === "inherit"
            ? ["a", "b"]
            : ["b", "a"];
        assertEquals(calls, [
            ...expected.map((id) => `request:${id}`),
            ...expected.map((id) => `frames:${id}`),
        ]);
        assertEquals(frames[1]?.event, {
            kind: "part.delta",
            messageId: "m",
            partId: "p",
            delta: `answer${expected.join("")}`,
        });
        assertEquals(
            (prepared.request.payload as GenerationRequest).instructions,
            "",
        );
    });
}

for (const kind of ["none", "removed", "unsupported"] as const) {
    Deno.test(`an ${kind} unrelated binding preserves global middleware before source routing`, async () => {
        const registry = new MiddlewareRegistry();
        registry.register({
            ...middleware("route", [], 0),
            transformRequest(input) {
                return {
                    ...input,
                    traits: { ...input.traits, model: "routed" },
                };
            },
        });
        const sources = new SourceRegistry();
        sources.register({
            ...provider("source"),
            capabilities: [{
                operation: "generation.create",
                models: ["routed"],
                streaming: true,
            }],
        });
        sources.register({
            ...provider("unrelated"),
            capabilities: [{
                operation: "generation.create",
                models: ["another-model"],
                streaming: true,
            }],
        });
        const runtime = new KernelRuntime({
            sources,
            middleware: registry,
            sourceMiddleware: () =>
                kind === "none" ? new Map() : new Map([[
                    kind === "removed" ? "missing" : "unrelated",
                    [],
                ]]),
        });
        const prepared = await execution(runtime);
        assertEquals(prepared.request.traits.model, "routed");
        assertEquals(
            (await collect(prepared.frames)).at(-1)?.event.kind,
            "run.completed",
        );
    });
}

for (const mode of ["no-alias", "inherited-backup", "mapped-bound"] as const) {
    Deno.test(`global model rewriting respects explicit bindings with ${mode}`, async () => {
        const called: string[] = [];
        const seen: unknown[] = [];
        const registry = new MiddlewareRegistry();
        registry.register({
            ...middleware("route", called, 0),
            transformRequest(input) {
                called.push("route");
                return {
                    ...input,
                    traits: { ...input.traits, model: "routed" },
                };
            },
        });
        registry.register(middleware("global-extra", called, 1));
        const sources = new SourceRegistry();
        const target: InferenceSource = {
            ...provider("bound", async function* (input) {
                seen.push([
                    "bound",
                    input.traits.model,
                    (input.payload as GenerationRequest).instructions,
                ]);
                yield frame(input, 1, { kind: "run.started", request: input });
                yield frame(input, 2, { kind: "run.completed" });
            }),
            capabilities: [{
                operation: "generation.create",
                models: ["routed"],
                streaming: true,
                priority: 0,
            }],
        };
        sources.register(
            mode === "mapped-bound"
                ? applySourceSettings(target, {
                    modelMap: { public: "routed" },
                })
                : target,
        );
        if (mode === "inherited-backup") {
            sources.register({
                ...provider("inherited", async function* (input) {
                    seen.push([
                        "inherited",
                        input.traits.model,
                        (input.payload as GenerationRequest).instructions,
                    ]);
                    yield frame(input, 1, {
                        kind: "run.started",
                        request: input,
                    });
                    yield frame(input, 2, { kind: "run.completed" });
                }),
                capabilities: [{
                    operation: "generation.create",
                    models: ["routed"],
                    streaming: true,
                    priority: 1,
                }],
            });
        }
        const runtime = new KernelRuntime({
            sources,
            middleware: registry,
            sourceMiddleware: () => new Map([["bound", []]]),
        });
        const prepared = await execution(runtime);
        if (mode === "no-alias") {
            await assertRejects(
                () => collect(prepared.frames),
                SourceUnavailableError,
            );
            assertEquals(seen, []);
        } else {
            await collect(prepared.frames);
            assertEquals(
                seen,
                mode === "mapped-bound"
                    ? [["bound", "routed", ""]]
                    : [["inherited", "routed", "global-extra"]],
            );
        }
        if (mode === "mapped-bound") assertEquals(called, []);
        assertEquals(sources.healthOf("bound"), "ready");
    });
}

Deno.test("bound failover rebuilds middleware input and host model mapping for each source", async () => {
    const calls: string[] = [];
    const seen: unknown[] = [];
    const registry = new MiddlewareRegistry();
    registry.register(middleware("a", calls, 0));
    registry.register(middleware("b", calls, 1));
    const sources = new SourceRegistry({ sameSourceAttempts: 2 });
    for (const [index, id] of ["first", "second"].entries()) {
        sources.register(
            applySourceSettings(
                provider(id, async function* (input) {
                    seen.push([
                        id,
                        input.traits.model,
                        (input.payload as GenerationRequest).model,
                        (input.payload as GenerationRequest).instructions,
                    ]);
                    yield frame(input, 1, {
                        kind: "run.started",
                        request: input,
                    });
                    yield frame(
                        input,
                        2,
                        index === 0
                            ? {
                                kind: "run.error",
                                error: {
                                    code: "busy",
                                    message: "retry",
                                    retryable: true,
                                    status: 503,
                                },
                            }
                            : { kind: "run.completed" },
                    );
                }),
                { priority: index, modelMap: { public: `upstream-${id}` } },
            ),
        );
    }
    const runtime = new KernelRuntime({
        sources,
        middleware: registry,
        sourceMiddleware: () => new Map([["first", ["a"]], ["second", ["b"]]]),
    });
    const result = await collect((await execution(runtime)).frames);
    assertEquals(seen, [["first", "upstream-first", "public", "a"], [
        "first",
        "upstream-first",
        "public",
        "a",
    ], ["second", "upstream-second", "public", "b"]]);
    assertEquals(calls, [
        "request:a",
        "frames:a",
        "request:a",
        "frames:a",
        "request:b",
        "frames:b",
    ]);
    assertEquals(result.length, 2);
    assertEquals(sources.healthOf("first"), "cooldown");
});

Deno.test("a running source attempt retains its binding and active middleware snapshot through failover", async () => {
    const calls: string[] = [];
    const registry = new MiddlewareRegistry();
    registry.register(middleware("a", calls, 0));
    registry.register(middleware("b", calls, 1));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sources = new SourceRegistry({
        sameSourceAttempts: 1,
        cooldownMs: 0,
    });
    sources.register(
        applySourceSettings(
            provider("first", async function* (input) {
                started.resolve();
                await release.promise;
                yield frame(input, 1, { kind: "run.started", request: input });
                yield frame(input, 2, {
                    kind: "run.error",
                    error: {
                        code: "busy",
                        message: "retry",
                        status: 503,
                        retryable: true,
                    },
                });
            }),
            { priority: 0 },
        ),
    );
    sources.register(applySourceSettings(provider("second"), { priority: 1 }));
    const bindings = new Map<string, readonly string[]>([["first", ["a"]], [
        "second",
        ["b"],
    ]]);
    const runtime = new KernelRuntime({
        sources,
        middleware: registry,
        sourceMiddleware: () => bindings,
    });
    const result = collect((await execution(runtime)).frames);
    await started.promise;
    registry.unregister("b");
    bindings.set("second", []);
    release.resolve();
    assertEquals((await result)[1]?.event, {
        kind: "part.delta",
        messageId: "m",
        partId: "p",
        delta: "answerb",
    });
    calls.length = 0;
    const next = await collect((await execution(runtime)).frames);
    assertEquals(next[1]?.event, {
        kind: "part.delta",
        messageId: "m",
        partId: "p",
        delta: "answer",
    });
    assertEquals(calls, ["request:a", "frames:a"]);
});

for (const stage of ["request", "frames"] as const) {
    Deno.test(`a bound ${stage} middleware failure does not retry or cool any source`, async () => {
        const registry = new MiddlewareRegistry();
        const plugin = middleware("failure", [], 0);
        registry.register({
            ...plugin,
            ...(stage === "request"
                ? {
                    transformRequest() {
                        throw new Error("bad transform");
                    },
                }
                : {
                    transformFrames() {
                        throw new Error("bad transform");
                    },
                }),
        });
        const sources = new SourceRegistry();
        let opened = 0;
        for (const id of ["first", "second"]) {
            sources.register(provider(id, () => {
                opened++;
                throw new Error("must not open");
            }));
        }
        const runtime = new KernelRuntime({
            sources,
            middleware: registry,
            sourceMiddleware: () =>
                new Map([["first", ["failure"]], ["second", []]]),
        });
        const prepared = await execution(runtime);
        await assertRejects(
            () => collect(prepared.frames),
            SourceMiddlewareError,
        );
        assertEquals(opened, 0);
        assertEquals(sources.healthOf("first"), "ready");
        assertEquals(sources.healthOf("second"), "ready");
    });
}

Deno.test("a middleware-generated failure never retries or cools an upstream", async () => {
    let opened = 0;
    let hooks = 0;
    const registry = new MiddlewareRegistry();
    registry.register({
        ...middleware("policy", [], 0),
        transformFrames(input) {
            hooks++;
            return (async function* () {
                yield frame(input, 1, { kind: "run.started", request: input });
                yield frame(input, 2, {
                    kind: "run.error",
                    error: {
                        code: "policy",
                        message: "unavailable",
                        status: 503,
                        retryable: true,
                    },
                });
            })();
        },
    });
    const sources = new SourceRegistry({ sameSourceAttempts: 2 });
    for (const id of ["first", "second"]) {
        sources.register(provider(id, () => {
            opened++;
            throw new Error("must not execute");
        }));
    }
    const runtime = new KernelRuntime({
        sources,
        middleware: registry,
        sourceMiddleware: () =>
            new Map([["first", ["policy"]], ["second", ["policy"]]]),
    });
    const failure = await assertRejects(
        () => execution(runtime).then((prepared) => collect(prepared.frames)),
        SourceMiddlewareError,
    );
    assertEquals([failure.code, failure.status], ["policy", 503]);
    assertEquals(opened, 0);
    assertEquals(hooks, 1);
    assertEquals(sources.healthOf("first"), "ready");
    assertEquals(sources.healthOf("second"), "ready");
});

Deno.test("a later middleware preparation failure closes both intermediate wrapper and upstream", async () => {
    const closed: string[] = [];
    const registry = new MiddlewareRegistry();
    registry.register({
        ...middleware("reader", [], 0),
        async transformFrames(_input, _context, frames) {
            const wrapper = (async function* () {
                try {
                    yield* frames;
                } finally {
                    closed.push("wrapper");
                }
            })();
            await wrapper.next();
            return wrapper;
        },
    });
    registry.register({
        ...middleware("failure", [], 1),
        transformFrames() {
            throw new Error("hook failure");
        },
    });
    const sources = new SourceRegistry();
    sources.register(provider("source", async function* (input) {
        try {
            yield frame(input, 1, { kind: "run.started", request: input });
            yield frame(input, 2, { kind: "run.completed" });
        } finally {
            closed.push("source");
        }
    }));
    const runtime = new KernelRuntime({
        sources,
        middleware: registry,
        sourceMiddleware: () => new Map([["source", ["reader", "failure"]]]),
    });
    await assertRejects(
        () => execution(runtime).then((prepared) => collect(prepared.frames)),
        SourceMiddlewareError,
    );
    assertEquals(closed.sort(), ["source", "wrapper"]);
});

Deno.test("upstream cleanup cannot replace a middleware failure with a retryable source error", async () => {
    let opened = 0;
    const registry = new MiddlewareRegistry();
    registry.register({
        ...middleware("reader", [], 0),
        async transformFrames(_input, _context, frames) {
            await frames[Symbol.asyncIterator]().next();
            throw new Error("original middleware failure");
        },
    });
    const sources = new SourceRegistry({ sameSourceAttempts: 2 });
    sources.register(provider("source", async function* (input) {
        opened++;
        try {
            yield frame(input, 1, { kind: "run.started", request: input });
        } finally {
            await Promise.reject(new Error("cleanup failure"));
        }
    }));
    const runtime = new KernelRuntime({
        sources,
        middleware: registry,
        sourceMiddleware: () => new Map([["source", ["reader"]]]),
    });
    const error = await assertRejects(
        () => execution(runtime).then((prepared) => collect(prepared.frames)),
        SourceMiddlewareError,
    );
    assertEquals((error.cause as Error).message, "original middleware failure");
    assertEquals(opened, 1);
    assertEquals(sources.healthOf("source"), "ready");
});

Deno.test("cancellation closes an upstream even when the outer frame middleware never yields again", async () => {
    const entered = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const registry = new MiddlewareRegistry();
    registry.register({
        ...middleware("hang", [], 0),
        transformFrames(_input, _context, frames) {
            return (async function* () {
                await frames[Symbol.asyncIterator]().next();
                entered.resolve();
                await new Promise<never>(() => {});
                yield* frames;
            })();
        },
    });
    const sources = new SourceRegistry();
    sources.register(provider("source", async function* (input) {
        try {
            yield frame(input, 1, { kind: "run.started", request: input });
        } finally {
            closed.resolve();
        }
    }));
    const runtime = new KernelRuntime({
        sources,
        middleware: registry,
        sourceMiddleware: () => new Map([["source", ["hang"]]]),
    });
    const controller = new AbortController();
    const pending = execution(runtime, controller).then((prepared) =>
        collect(prepared.frames)
    );
    await entered.promise;
    controller.abort(new DOMException("stopped", "AbortError"));
    await assertRejects(() => pending, DOMException);
    await closed.promise;
    assertEquals(sources.healthOf("source"), "ready");
});

Deno.test("a live wrapper returned after cancellation is immediately closed", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const registry = new MiddlewareRegistry();
    registry.register({
        ...middleware("late", [], 0),
        async transformFrames(input) {
            const wrapper = (async function* () {
                try {
                    yield frame(input, 1, {
                        kind: "run.started",
                        request: input,
                    });
                } finally {
                    closed.resolve();
                }
            })();
            await wrapper.next();
            entered.resolve();
            await release.promise;
            return wrapper;
        },
    });
    const sources = new SourceRegistry();
    sources.register(provider("source"));
    const runtime = new KernelRuntime({
        sources,
        middleware: registry,
        sourceMiddleware: () => new Map([["source", ["late"]]]),
    });
    const controller = new AbortController();
    const pending = execution(runtime, controller).then((prepared) =>
        collect(prepared.frames)
    );
    await entered.promise;
    controller.abort(new DOMException("stopped", "AbortError"));
    await assertRejects(() => pending, DOMException);
    release.resolve();
    await closed.promise;
});

Deno.test("a frame middleware failing after an eager upstream read closes the source", async () => {
    let closed = 0;
    const registry = new MiddlewareRegistry();
    registry.register({
        ...middleware("reader", [], 0),
        async transformFrames(_input, _context, frames) {
            await frames[Symbol.asyncIterator]().next();
            throw new Error("reader failed");
        },
    });
    const sources = new SourceRegistry();
    sources.register(provider("source", async function* (input) {
        try {
            yield frame(input, 1, { kind: "run.started", request: input });
            yield frame(input, 2, { kind: "run.completed" });
        } finally {
            closed++;
        }
    }));
    const runtime = new KernelRuntime({
        sources,
        middleware: registry,
        sourceMiddleware: () => new Map([["source", ["reader"]]]),
    });
    await assertRejects(
        () => execution(runtime).then((item) => collect(item.frames)),
        SourceMiddlewareError,
    );
    assertEquals(closed, 1);
    assertEquals(sources.healthOf("source"), "ready");
});

for (const stage of ["request", "frames"] as const) {
    Deno.test(`cancellation interrupts a pending bound ${stage} hook and completes lifecycle`, async () => {
        const entered = Promise.withResolvers<void>();
        const registry = new MiddlewareRegistry();
        const never = () => {
            entered.resolve();
            return new Promise<never>(() => {});
        };
        registry.register({
            ...middleware("pending", [], 0),
            ...(stage === "request"
                ? { transformRequest: never }
                : { transformFrames: never }),
        });
        const sources = new SourceRegistry();
        sources.register(provider("source"));
        const completed: string[] = [];
        const runtime = new KernelRuntime({
            sources,
            middleware: registry,
            sourceMiddleware: () => new Map([["source", ["pending"]]]),
            lifecycle: {
                begin() {},
                append() {},
                complete(_id, outcome) {
                    completed.push(outcome);
                },
            },
        });
        const controller = new AbortController();
        const pending = execution(runtime, controller).then((item) =>
            collect(item.frames)
        );
        await entered.promise;
        controller.abort(new DOMException("stopped", "AbortError"));
        await assertRejects(() => pending, DOMException, "stopped");
        assertEquals(completed, ["cancelled"]);
        assertEquals(sources.healthOf("source"), "ready");
    });
}
