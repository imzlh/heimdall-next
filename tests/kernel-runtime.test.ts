import {
    assertEquals,
    assertRejects,
    assertStrictEquals,
    assertThrows,
} from "@std/assert";
import type {
    GenerationRequest,
    InferenceSource,
    MiddlewarePlugin,
    PluginManifest,
    PluginRoute,
    ProtocolPlugin,
    RequestContext,
} from "@heimdall/contracts";
import type { OperationRequest, StreamEvent, StreamFrame } from "@heimdall/hip";
import {
    FrameValidationError,
    KernelRuntime,
    LifecycleHookRegistry,
    MiddlewareRegistry,
    ProtocolRegistry,
    ProtocolRouteConflictError,
    SourceRegistry,
    SourceUnavailableError,
} from "@heimdall/kernel";

const route: PluginRoute = {
    method: "POST",
    path: "/v1/test",
    operation: "generation.create",
};

const protocolManifest = (id: string): PluginManifest => ({
    id,
    version: "1.0.0",
    apiVersion: "1",
    name: id,
    kind: "protocol",
    trust: "trusted",
    routes: [route],
});

function protocol(id: string): ProtocolPlugin {
    return {
        manifest: protocolManifest(id),
        parse(context) {
            return Promise.resolve(requestFor(context.requestId));
        },
        serialize() {
            return Promise.resolve(new Response("ok"));
        },
    };
}

function requestFor(
    requestId = "request-1",
    model = "model-a",
): OperationRequest<GenerationRequest> {
    return {
        version: 1,
        requestId,
        operation: "generation.create",
        payload: { messages: [], model, stream: true },
        traits: { model, streaming: true },
    };
}

function frame(
    streamId: string,
    requestId: string,
    seq: number,
    event: StreamEvent,
): StreamFrame {
    return {
        version: 1,
        streamId,
        requestId,
        seq,
        eventId: `${streamId}:${seq}`,
        timestamp: "2026-09-20T00:00:00.000Z",
        event,
    };
}

function stream(
    request: OperationRequest,
    streamId = "stream-1",
): AsyncIterable<StreamFrame> {
    return (async function* () {
        yield frame(streamId, request.requestId, 1, {
            kind: "run.started",
            request,
        });
        yield frame(streamId, request.requestId, 2, {
            kind: "run.completed",
            finishReason: "stop",
        });
    })();
}

function source(
    id: string,
    models: readonly string[] = ["model-a"],
    priority = 0,
): InferenceSource {
    return {
        id,
        capabilities: [{
            operation: "generation.create",
            models,
            streaming: true,
            priority,
        }],
        execute(request) {
            return stream(request, `${id}-stream`);
        },
    };
}

Deno.test("protocol registry validates declarations and resolves one owner", () => {
    const registry = new ProtocolRegistry();
    const first = protocol("protocol.first");
    registry.register(first);
    assertEquals(registry.get(first.manifest.id), first);
    assertEquals(registry.list(), [first]);

    assertEquals(registry.resolve(route)?.plugin, first);
    assertThrows(
        () => registry.register(protocol("protocol.second")),
        ProtocolRouteConflictError,
    );
});

Deno.test("source registry chooses priority peers round-robin and validates frames", async () => {
    const registry = new SourceRegistry();
    registry.register(source("slow", ["model-a"], 10));
    registry.register(source("first-a", ["model-a"], 1));
    registry.register(source("first-b", ["model-a"], 1));
    const request = requestFor();
    assertEquals(registry.select(request).id, "first-a");
    assertEquals(registry.select(request).id, "first-b");
    assertEquals(registry.select(request).id, "first-a");

    const frames: StreamFrame[] = [];
    for await (
        const item of registry.run(request, {
            requestId: request.requestId,
            signal: new AbortController().signal,
            metadata: {},
        })
    ) frames.push(item);
    assertEquals(frames.length, 2);

    assertThrows(() =>
        registry.run({
            ...request,
            payload: { messages: "invalid" } as unknown as GenerationRequest,
        }, {
            requestId: request.requestId,
            signal: new AbortController().signal,
            metadata: {},
        })
    );

    const unsupported = requestFor("request-2", "missing-model");
    assertThrows(
        () => registry.select(unsupported),
        SourceUnavailableError,
    );

    const invalid = new SourceRegistry();
    invalid.register({
        id: "invalid",
        capabilities: [{ operation: "generation.create", streaming: true }],
        async *execute(request) {
            yield frame("invalid-stream", "other-request", 1, {
                kind: "run.started",
                request,
            });
        },
    });
    await assertRejects(
        async () => {
            for await (
                const _ of invalid.run(request, {
                    requestId: request.requestId,
                    signal: new AbortController().signal,
                    metadata: {},
                })
            ) {
                // Exhaust the stream so the boundary validator runs.
            }
        },
        FrameValidationError,
    );

    const empty = new SourceRegistry();
    empty.register({
        id: "empty-stream",
        capabilities: [{ operation: "generation.create", streaming: true }],
        async *execute() {
            // A source that emits no HIP frame is invalid at the source boundary.
        },
    });
    await assertRejects(
        async () => {
            for await (
                const _ of empty.run(request, {
                    requestId: request.requestId,
                    signal: new AbortController().signal,
                    metadata: {},
                })
            ) {
                // Exhaust the stream so the boundary validator runs.
            }
        },
        FrameValidationError,
    );

    assertThrows(() =>
        new SourceRegistry().register({
            id: "bad-capability",
            capabilities: [{
                operation: "generation.create",
                streaming: "yes" as unknown as boolean,
            }],
            execute: source("bad-capability").execute,
        })
    );
    assertThrows(() =>
        new SourceRegistry().register({
            id: "bad-models",
            capabilities: [{
                operation: "generation.create",
                streaming: true,
                models: "model-a" as unknown as readonly string[],
            }],
            execute: source("bad-models").execute,
        })
    );
});

Deno.test("kernel runtime applies middleware and lifecycle observers around a source", async () => {
    const sourceRegistry = new SourceRegistry();
    let observedRequest: OperationRequest | undefined;
    sourceRegistry.register({
        ...source("runtime-source", ["rewritten-model"]),
        execute(request) {
            observedRequest = request;
            return stream(request, "runtime-stream");
        },
    });

    const middleware = new MiddlewareRegistry();
    const middlewareManifest: PluginManifest = {
        id: "middleware.rewrite",
        version: "1.0.0",
        apiVersion: "1",
        name: "rewrite",
        kind: "middleware",
        trust: "trusted",
    };
    const rewrite: MiddlewarePlugin = {
        manifest: middlewareManifest,
        transformRequest(input) {
            return {
                ...input,
                traits: { ...input.traits, model: "rewritten-model" },
                payload: {
                    ...(input.payload as GenerationRequest),
                    model: "rewritten-model",
                },
            };
        },
    };
    middleware.register(rewrite);

    const lifecycleEvents: string[] = [];
    const lifecycleHooks = new LifecycleHookRegistry();
    lifecycleHooks.register({
        id: "observer",
        onBegin: () => {
            lifecycleEvents.push("begin");
        },
        onFrame: (item) => {
            lifecycleEvents.push(item.event.kind);
        },
        onComplete: (outcome) => {
            lifecycleEvents.push(outcome);
        },
    });
    const portEvents: string[] = [];
    const runtime = new KernelRuntime({
        sources: sourceRegistry,
        middleware,
        lifecycleHooks,
        lifecycle: {
            begin: () => portEvents.push("begin"),
            append: (item) => portEvents.push(`frame:${item.seq}`),
            complete: (_requestId, outcome) => portEvents.push(outcome),
        },
    });
    const request = requestFor();
    const requestContext: RequestContext = {
        requestId: request.requestId,
        request: new Request("http://localhost/v1/test", { method: "POST" }),
        signal: new AbortController().signal,
        route,
        metadata: { source: "test" },
    };
    const lifecycle = runtime.createLifecycle(request, requestContext.signal, {
        streamId: "runtime-stream",
    });
    const execution = await runtime.run(request, lifecycle, { requestContext });
    assertEquals(
        (execution.request.payload as GenerationRequest).model,
        "rewritten-model",
    );
    const frames: StreamFrame[] = [];
    for await (const item of execution.frames) frames.push(item);
    assertEquals(frames.length, 2);
    assertEquals(observedRequest?.traits.model, "rewritten-model");
    assertEquals(lifecycleEvents, [
        "begin",
        "run.started",
        "run.completed",
        "completed",
    ]);
    assertEquals(portEvents, ["begin", "frame:1", "frame:2", "completed"]);
});

Deno.test("runtime reports an incomplete source stream as an error", async () => {
    const sourceRegistry = new SourceRegistry();
    sourceRegistry.register({
        id: "incomplete",
        capabilities: [{ operation: "generation.create", streaming: true }],
        async *execute(request) {
            yield frame("incomplete-stream", request.requestId, 1, {
                kind: "run.started",
                request,
            });
        },
    });
    const outcomes: string[] = [];
    const runtime = new KernelRuntime({
        sources: sourceRegistry,
        lifecycle: {
            begin: () => undefined,
            append: () => undefined,
            complete: (_requestId, outcome) => outcomes.push(outcome),
        },
    });
    const request = requestFor();
    const lifecycle = runtime.createLifecycle(
        request,
        new AbortController().signal,
        {
            streamId: "incomplete-stream",
        },
    );
    const execution = await runtime.run(request, lifecycle);
    await assertRejects(
        async () => {
            for await (const _ of execution.frames) {
                // Exhaust the stream to trigger terminal validation.
            }
        },
        Error,
        "terminal event",
    );
    assertEquals(outcomes, ["error"]);
});

Deno.test("closing a frame iterator completes lifecycle as cancelled", async () => {
    const sources = new SourceRegistry();
    sources.register(source("early-close"));
    const outcomes: string[] = [];
    const runtime = new KernelRuntime({
        sources,
        lifecycle: {
            begin: () => undefined,
            append: () => undefined,
            complete: (_requestId, outcome) => outcomes.push(outcome),
        },
    });
    const request = requestFor();
    const execution = await runtime.run(
        request,
        runtime.createLifecycle(request, new AbortController().signal, {
            streamId: "early-close-stream",
        }),
    );
    for await (const _ of execution.frames) break;
    assertEquals(outcomes, ["cancelled"]);
});

Deno.test("runtime finalizes the lifecycle port when an observer fails", async () => {
    const sources = new SourceRegistry();
    sources.register(source("observer-failure"));
    const outcomes: string[] = [];
    const hooks = new LifecycleHookRegistry();
    hooks.register({
        id: "broken-observer",
        onComplete: () => {
            throw new Error("observer failed");
        },
    });
    const runtime = new KernelRuntime({
        sources,
        lifecycleHooks: hooks,
        lifecycle: {
            begin: () => undefined,
            append: () => undefined,
            complete: (_requestId, outcome) => outcomes.push(outcome),
        },
    });
    const request = requestFor();
    const execution = await runtime.run(
        request,
        runtime.createLifecycle(request, new AbortController().signal, {
            streamId: "observer-failure-stream",
        }),
    );
    await assertRejects(
        async () => {
            for await (const _ of execution.frames) {
                // Drain the stream to run completion observers.
            }
        },
        Error,
        "observer failed",
    );
    assertEquals(outcomes, ["completed"]);
});

Deno.test("runtime cancellation closes a pending stream without waiting for source cleanup", async () => {
    const controller = new AbortController();
    const reason = new Error("request cancelled while waiting for output");
    const waiting = Promise.withResolvers<void>();
    const sources = new SourceRegistry();
    let closes = 0;
    let calls = 0;
    sources.register({
        ...source("uncooperative"),
        execute(request) {
            calls++;
            let reads = 0;
            return {
                [Symbol.asyncIterator]() {
                    return {
                        next() {
                            reads++;
                            if (reads === 1) {
                                return Promise.resolve({
                                    done: false as const,
                                    value: frame(
                                        "pending",
                                        request.requestId,
                                        1,
                                        {
                                            kind: "run.started",
                                            request,
                                        },
                                    ),
                                });
                            }
                            if (reads === 2) {
                                return Promise.resolve({
                                    done: false as const,
                                    value: frame(
                                        "pending",
                                        request.requestId,
                                        2,
                                        {
                                            kind: "part.started",
                                            messageId: "message-1",
                                            part: {
                                                id: "part-1",
                                                type: "text",
                                                text: "",
                                            },
                                        },
                                    ),
                                });
                            }
                            waiting.resolve();
                            return new Promise<IteratorResult<StreamFrame>>(
                                () => {},
                            );
                        },
                        return() {
                            closes++;
                            return new Promise<IteratorResult<StreamFrame>>(
                                () => {},
                            );
                        },
                    };
                },
            };
        },
    });
    const outcomes: string[] = [];
    const errors: unknown[] = [];
    const hooks = new LifecycleHookRegistry();
    hooks.register({
        id: "error-observer",
        onError: (error) => {
            errors.push(error);
        },
    });
    const runtime = new KernelRuntime({
        sources,
        lifecycleHooks: hooks,
        lifecycle: {
            begin: () => undefined,
            append: () => undefined,
            complete: (_requestId, outcome) => outcomes.push(outcome),
        },
    });
    const request = requestFor();
    const execution = await runtime.run(
        request,
        runtime.createLifecycle(request, controller.signal),
    );
    const iterator = execution.frames[Symbol.asyncIterator]();
    assertEquals((await iterator.next()).value?.event.kind, "run.started");
    assertEquals((await iterator.next()).value?.event.kind, "part.started");
    const pending = iterator.next();
    await waiting.promise;
    controller.abort(reason);
    assertStrictEquals(
        await assertRejects(() => withinDeadline(pending)),
        reason,
    );
    assertEquals(outcomes, ["cancelled"]);
    assertEquals(errors, [reason]);
    assertEquals(closes, 1);
    assertEquals(calls, 1);
    assertEquals(sources.healthOf("uncooperative"), "ready");
});

Deno.test("runtime finalizes a post-output source exception exactly once", async () => {
    const sources = new SourceRegistry();
    const failure = new Error("source disconnected after output");
    let calls = 0;
    sources.register({
        ...source("broken-stream"),
        async *execute(request) {
            calls++;
            yield frame("broken-stream", request.requestId, 1, {
                kind: "run.started",
                request,
            });
            yield frame("broken-stream", request.requestId, 2, {
                kind: "tool.call",
                messageId: "message-1",
                callId: "call-1",
                name: "action",
                arguments: {},
            });
            throw failure;
        },
    });
    const outcomes: string[] = [];
    const runtime = new KernelRuntime({
        sources,
        lifecycle: {
            begin: () => undefined,
            append: () => undefined,
            complete: (_requestId, outcome) => outcomes.push(outcome),
        },
    });
    const request = requestFor();
    const execution = await runtime.run(
        request,
        runtime.createLifecycle(request, new AbortController().signal),
    );
    const kinds: string[] = [];
    const error = await assertRejects(async () => {
        for await (const item of execution.frames) kinds.push(item.event.kind);
    });
    assertStrictEquals(error, failure);
    assertEquals(kinds, ["run.started", "tool.call"]);
    assertEquals(calls, 1);
    assertEquals(outcomes, ["error"]);
});

Deno.test("cancellation during iterator cleanup still finalizes the lifecycle", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during source cleanup");
    const closing = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<IteratorResult<StreamFrame>>();
    const source = {
        id: "slow-close",
        capabilities: [{ operation: "generation.create", streaming: true }],
        execute(request: OperationRequest) {
            return {
                [Symbol.asyncIterator]() {
                    return {
                        next: () =>
                            Promise.resolve({
                                done: false as const,
                                value: frame(
                                    "slow-close",
                                    request.requestId,
                                    1,
                                    {
                                        kind: "run.started",
                                        request,
                                    },
                                ),
                            }),
                        return() {
                            closing.resolve();
                            return closed.promise;
                        },
                    };
                },
            };
        },
    };
    const outcomes: string[] = [];
    const runtime = new KernelRuntime({
        sources: {
            select: () => source,
            run: (request) => source.execute(request),
        },
        lifecycle: {
            begin: () => undefined,
            append: () => undefined,
            complete: (_requestId, outcome) => outcomes.push(outcome),
        },
    });
    const request = requestFor();
    const execution = await runtime.run(
        request,
        runtime.createLifecycle(request, controller.signal),
    );
    const iterator = execution.frames[Symbol.asyncIterator]();
    assertEquals((await iterator.next()).value?.event.kind, "run.started");
    const returned = iterator.return!();
    await closing.promise;
    controller.abort(reason);
    assertStrictEquals(
        await assertRejects(() => withinDeadline(returned)),
        reason,
    );
    assertEquals(outcomes, ["cancelled"]);
    // A source that finishes cleanup later must not produce an unhandled error.
    closed.reject(new Error("late cleanup failure"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

Deno.test("a lifecycle observer can cancel before the source router starts", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by lifecycle observer");
    const hooks = new LifecycleHookRegistry();
    hooks.register({
        id: "cancel-before-routing",
        onBegin: () => controller.abort(reason),
    });
    let calls = 0;
    const outcomes: string[] = [];
    const runtime = new KernelRuntime({
        sources: {
            select: () => source("unused"),
            run: (request) => {
                calls++;
                return stream(request);
            },
        },
        lifecycleHooks: hooks,
        lifecycle: {
            begin: () => undefined,
            append: () => undefined,
            complete: (_requestId, outcome) => outcomes.push(outcome),
        },
    });
    const request = requestFor();
    const execution = await runtime.run(
        request,
        runtime.createLifecycle(request, controller.signal),
    );
    assertStrictEquals(
        await assertRejects(() =>
            execution.frames[Symbol.asyncIterator]().next()
        ),
        reason,
    );
    assertEquals(calls, 0);
    assertEquals(outcomes, ["cancelled"]);
});

async function withinDeadline<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error("cancellation stayed pending")),
                    1_000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
