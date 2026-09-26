import { assert, assertEquals } from "@std/assert";
import type {
    InferenceSource,
    OperationRequest,
    ResolvedSourceProxy,
    StreamFrame,
} from "@heimdall/contracts";
import { createOpenAICompatibleSource } from "../../plugins/openai-source/mod.ts";
import { createAnthropicSource } from "../../plugins/anthropic-source/mod.ts";

const apiKey = "provider-key-private";
const username = "proxy-user-private";
const password = "proxy-password-private";
const request: OperationRequest = {
    version: 1,
    requestId: "proxy-request",
    operation: "generation.create",
    payload: {
        model: "test-model",
        messages: [{
            id: "u",
            role: "user",
            parts: [{ id: "p", type: "text", text: "hello" }],
        }],
    },
    traits: {},
};

function serve(handler: Deno.ServeHandler): Deno.HttpServer<Deno.NetAddr> {
    return Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        handler,
    );
}

function origin(server: Deno.HttpServer<Deno.NetAddr>): string {
    return `http://127.0.0.1:${server.addr.port}`;
}

function selection(server: Deno.HttpServer<Deno.NetAddr>): ResolvedSourceProxy {
    return {
        mode: "proxy",
        selectedBy: "global",
        proxy: {
            id: "proxy",
            name: "Proxy",
            url: origin(server),
            basicAuth: { username, password },
        },
    };
}

async function collect(
    source: InferenceSource,
    signal = new AbortController().signal,
    input = request,
): Promise<StreamFrame[]> {
    return await Array.fromAsync(
        source.execute(input, {
            requestId: input.requestId,
            signal,
            metadata: {},
        }),
    );
}

const factories = [
    { name: "OpenAI", create: createOpenAICompatibleSource },
    { name: "Anthropic", create: createAnthropicSource },
] as const;

for (const factory of factories) {
    Deno.test(`${factory.name} reads current proxy on each inference and models probe without rebuilding the source`, async () => {
        const seen: {
            route: string;
            path: string;
            auth: string | null;
            api: string | null;
        }[] = [];
        const handler = (route: string): Deno.ServeHandler => async (req) => {
            const path = new URL(req.url).pathname;
            seen.push({
                route,
                path,
                auth: req.headers.get("proxy-authorization"),
                api: req.headers.get(
                    factory.name === "OpenAI" ? "authorization" : "x-api-key",
                ),
            });
            await req.body?.cancel();
            return Response.json(
                path.endsWith("/models")
                    ? { data: [{ id: "test-model" }, { id: password }] }
                    : {
                        choices: [{
                            message: { content: route },
                            finish_reason: "stop",
                        }],
                        content: [{ type: "text", text: route }],
                    },
            );
        };
        const direct = serve(handler("direct"));
        const first = serve(handler("first-proxy"));
        const second = serve(handler("second-proxy"));
        let current = selection(first);
        let reads = 0;
        const source = factory.create({ baseUrl: origin(direct), apiKey }, {
            getProxy: () => {
                reads++;
                return current;
            },
        });
        try {
            assertEquals(
                (await collect(source)).at(-1)?.event.kind,
                "run.completed",
            );
            current = selection(second);
            assertEquals(await source.probe(new AbortController().signal), {
                ok: true,
                message: "models endpoint reachable",
                models: ["test-model"],
            });
            assertEquals(
                (await collect(source)).at(-1)?.event.kind,
                "run.completed",
            );
            current = { mode: "direct", selectedBy: "source" };
            assertEquals(
                (await collect(source)).at(-1)?.event.kind,
                "run.completed",
            );
            assertEquals(reads, 4);
            assertEquals(seen.map((item) => item.route), [
                "first-proxy",
                "second-proxy",
                "second-proxy",
                "direct",
            ]);
            const auth = `Basic ${btoa(`${username}:${password}`)}`;
            assertEquals(seen.map((item) => item.auth), [
                auth,
                auth,
                auth,
                null,
            ]);
            assertEquals(
                seen.map((item) => item.api),
                Array(4).fill(
                    factory.name === "OpenAI" ? `Bearer ${apiKey}` : apiKey,
                ),
            );
            current = {
                mode: "unavailable",
                selectedBy: "source",
                proxyId: "removed",
                reason: "missing",
            };
            const terminal = (await collect(source)).at(-1)?.event;
            assert(terminal?.kind === "run.error");
            assertEquals(terminal.error.code, "proxy_unavailable");
            assertEquals(seen.length, 4);
        } finally {
            await Promise.all([
                direct.shutdown(),
                first.shutdown(),
                second.shutdown(),
            ]);
        }
    });

    Deno.test(`${factory.name} redacts proxy and source credentials from HTTP and streaming errors`, async () => {
        const secretText = `${apiKey} ${password} ${username} ${
            encodeURIComponent(password)
        } Basic ${btoa(`${username}:${password}`)}`;
        for (const streaming of [false, true]) {
            const source = factory.create({
                baseUrl: "http://127.0.0.1:65534",
                apiKey,
            }, {
                getProxy: () => ({
                    mode: "proxy",
                    selectedBy: "global",
                    proxy: {
                        id: "p",
                        name: "P",
                        url: "http://127.0.0.1:8080",
                        basicAuth: { username, password },
                    },
                }),
                fetch: () =>
                    Promise.resolve(
                        streaming
                            ? new Response(
                                `data: ${
                                    JSON.stringify({
                                        type: "error",
                                        error: {
                                            message: secretText,
                                            code: password,
                                            type: password,
                                        },
                                    })
                                }\n\n`,
                                {
                                    headers: {
                                        "content-type": "text/event-stream",
                                    },
                                },
                            )
                            : Response.json({
                                error: {
                                    message: secretText,
                                    code: password,
                                    type: password,
                                    nested: [{ diagnostic: secretText }],
                                },
                            }, { status: 502 }),
                    ),
            });
            const events = await collect(source);
            const terminal = events.at(-1)?.event;
            assert(terminal?.kind === "run.error");
            const output = JSON.stringify(terminal.error);
            for (
                const secret of [
                    apiKey,
                    username,
                    password,
                    btoa(`${username}:${password}`),
                ]
            ) assert(!output.includes(secret));
            assert(output.includes("[redacted]"));
        }
    });

    Deno.test(`${factory.name} cancels a real proxied stream and does not report probe success after cancellation`, async () => {
        for (const probe of [false, true]) {
            const bodyStarted = Promise.withResolvers<void>();
            const cancelled = Promise.withResolvers<void>();
            const proxy = serve(() =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(
                                new TextEncoder().encode(
                                    probe ? '{"data":[' : ": waiting\n\n",
                                ),
                            );
                            bodyStarted.resolve();
                        },
                        cancel() {
                            cancelled.resolve();
                        },
                    }),
                    {
                        headers: {
                            "content-type": probe
                                ? "application/json"
                                : "text/event-stream",
                        },
                    },
                )
            );
            const source = factory.create({
                baseUrl: "http://127.0.0.1:65534",
                apiKey,
            }, { getProxy: () => selection(proxy) });
            const abort = new AbortController();
            try {
                const running = probe
                    ? source.probe(abort.signal)
                    : collect(source, abort.signal);
                await bodyStarted.promise;
                abort.abort();
                const result = await running;
                if (Array.isArray(result)) {
                    assertEquals(result.at(-1)?.event.kind, "run.cancelled");
                    assert(
                        !result.some((frame) =>
                            frame.event.kind === "run.error"
                        ),
                    );
                } else assertEquals(result.ok, false);
                await cancelled.promise;
            } finally {
                await proxy.shutdown();
            }
        }
    });
}

Deno.test("OpenAI non-chat operations use the selected proxy transport", async () => {
    const seen: string[] = [];
    const proxy = serve(async (req) => {
        seen.push(new URL(req.url).pathname);
        await req.body?.cancel();
        return Response.json({ data: [{ embedding: [0.1] }] });
    });
    try {
        const source = createOpenAICompatibleSource({
            baseUrl: "http://127.0.0.1:65534/v1",
        }, { getProxy: () => selection(proxy) });
        const events = await collect(source, undefined, {
            ...request,
            operation: "embedding.create",
            payload: {
                vocabulary: "openai.embedding",
                value: { model: "test-model", input: "hello" },
            },
        });
        assertEquals(events.at(-1)?.event.kind, "run.completed");
        assertEquals(seen, ["/v1/embeddings"]);
    } finally {
        await proxy.shutdown();
    }
});
