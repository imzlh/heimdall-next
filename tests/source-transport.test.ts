import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { ResolvedSourceProxy } from "@heimdall/contracts";
import {
    SourceProxyError,
    SourceTransport,
} from "../packages/source-sdk/mod.ts";

const direct: ResolvedSourceProxy = { mode: "direct", selectedBy: "source" };

function serve(handler: Deno.ServeHandler): Deno.HttpServer<Deno.NetAddr> {
    return Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        handler,
    );
}

function origin(server: Deno.HttpServer<Deno.NetAddr>): string {
    return `http://127.0.0.1:${server.addr.port}`;
}

Deno.test("source transport routes direct HTTP separately from an authenticated proxy", async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const upstream = serve(() => new Response("direct"));
    const proxy = serve((request) => {
        requests.push({
            url: request.url,
            authorization: request.headers.get("proxy-authorization"),
        });
        return new Response("proxied");
    });
    try {
        using straight = new SourceTransport({ getProxy: () => direct });
        assertEquals(
            await (await straight.fetch(origin(upstream))).text(),
            "direct",
        );
        using tunneled = new SourceTransport({
            getProxy: () => ({
                mode: "proxy",
                selectedBy: "source",
                proxy: {
                    id: "local",
                    name: "local",
                    url: origin(proxy),
                    basicAuth: {
                        username: "proxy-user",
                        password: "proxy-pass",
                    },
                },
            }),
        });
        const target = `${origin(upstream)}/v1/models`;
        assertEquals(await (await tunneled.fetch(target)).text(), "proxied");
        assertEquals(requests, [{
            url: target,
            authorization: `Basic ${btoa("proxy-user:proxy-pass")}`,
        }]);
    } finally {
        await Promise.all([upstream.shutdown(), proxy.shutdown()]);
    }
});

Deno.test("explicit direct transport bypasses process HTTP_PROXY without mutating it", async () => {
    const upstream = serve(() => new Response("origin"));
    const proxy = serve(() => new Response("ambient-proxy"));
    const module =
        new URL("../packages/source-sdk/mod.ts", import.meta.url).href;
    try {
        const script = `
            import { SourceTransport } from ${JSON.stringify(module)};
            const target = ${JSON.stringify(origin(upstream))};
            const ambient = await (await fetch(target)).text();
            using transport = new SourceTransport({
                getProxy: () => ({ mode: "direct", selectedBy: "source" }),
            });
            const direct = await (await transport.fetch(target)).text();
            console.log(JSON.stringify({ ambient, direct, env: Deno.env.get("HTTP_PROXY") }));
        `;
        const result = await new Deno.Command(Deno.execPath(), {
            args: ["eval", "--quiet", "--cached-only", script],
            env: {
                HTTP_PROXY: origin(proxy),
                HTTPS_PROXY: origin(proxy),
                ALL_PROXY: origin(proxy),
                NO_PROXY: "",
            },
            stdout: "piped",
            stderr: "piped",
        }).output();
        assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
        assertEquals(JSON.parse(new TextDecoder().decode(result.stdout)), {
            ambient: "ambient-proxy",
            direct: "origin",
            env: origin(proxy),
        });
    } finally {
        await Promise.all([upstream.shutdown(), proxy.shutdown()]);
    }
});

Deno.test("direct client follows each target origin and rejects implicit redirects", async () => {
    let redirected = 0;
    const destination = serve(() => {
        redirected++;
        return new Response("second");
    });
    const first = serve((request) =>
        new URL(request.url).pathname === "/redirect"
            ? Response.redirect(origin(destination), 302)
            : new Response("first")
    );
    try {
        using transport = new SourceTransport({ getProxy: () => direct });
        assertEquals(
            await (await transport.fetch(origin(first))).text(),
            "first",
        );
        assertEquals(
            await (await transport.fetch(origin(destination))).text(),
            "second",
        );
        await assertRejects(() => transport.fetch(`${origin(first)}/redirect`));
        assertEquals(redirected, 1);
        const manual = await transport.fetch(`${origin(first)}/redirect`, {
            redirect: "manual",
        });
        assertEquals(manual.status, 302);
        await manual.body?.cancel();
    } finally {
        await Promise.all([first.shutdown(), destination.shutdown()]);
    }
});

Deno.test("source transport close aborts an in-flight response body and releases its client", async () => {
    const cancelled = Promise.withResolvers<void>();
    const server = serve(() =>
        new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode("first"));
                },
                cancel() {
                    cancelled.resolve();
                },
            }),
        )
    );
    try {
        using transport = new SourceTransport({ getProxy: () => direct });
        const response = await transport.fetch(origin(server));
        const reader = response.body!.getReader();
        assertEquals(
            new TextDecoder().decode((await reader.read()).value),
            "first",
        );
        const pending = assertRejects(() => reader.read());
        transport.close();
        await pending;
        reader.releaseLock();
        await cancelled.promise;
        transport.close();
        await assertRejects(
            () => transport.fetch(origin(server)),
            Error,
            "closed",
        );
        assertThrows(
            () => transport.webSocket(origin(server).replace("http:", "ws:")),
            Error,
            "closed",
        );
    } finally {
        await server.shutdown();
    }
});

Deno.test("optional transport keeps custom routing while propagating all cancellation owners", async () => {
    for (const owner of ["operation", "request", "close"] as const) {
        const operation = new AbortController();
        const request = new AbortController();
        const started = Promise.withResolvers<RequestInit>();
        using transport = new SourceTransport({
            signal: operation.signal,
            fetch: (_input, init) => {
                started.resolve(init!);
                return new Promise<Response>((_resolve, reject) => {
                    init!.signal!.addEventListener(
                        "abort",
                        () => reject(init!.signal!.reason),
                        { once: true },
                    );
                });
            },
        });
        const pending = assertRejects(() =>
            transport.fetch("http://custom.invalid/", {
                signal: request.signal,
                redirect: "follow",
            })
        );
        const init = await started.promise;
        assertEquals(
            (init as RequestInit & { client?: Deno.HttpClient }).client,
            undefined,
        );
        assertEquals(init.redirect, "follow");
        if (owner === "operation") operation.abort();
        else if (owner === "request") request.abort();
        else transport.close();
        await pending;
        assertEquals(init.signal?.aborted, true);
    }
});

Deno.test("unavailable proxy cannot fall back to direct and pre-aborted work does not resolve a proxy", () => {
    for (const reason of ["missing", "disabled"] as const) {
        assertThrows(() =>
            new SourceTransport({
                getProxy: () => ({
                    mode: "unavailable",
                    selectedBy: "source",
                    proxyId: "gone",
                    reason,
                }),
            }), SourceProxyError);
    }
    let reads = 0;
    assertThrows(() =>
        new SourceTransport({
            signal: AbortSignal.abort(),
            getProxy: () => {
                reads++;
                return direct;
            },
        }), DOMException);
    assertEquals(reads, 0);
});

Deno.test("source transport redacts proxy credentials and encoded nested diagnostics", () => {
    const username = "diagnostic-user";
    const password = "proxy p@ssword";
    const key = "provider/key";
    using transport = new SourceTransport({
        getProxy: () => ({
            mode: "proxy",
            selectedBy: "global",
            proxy: {
                id: "p",
                name: "Proxy",
                url: "http://127.0.0.1:8000",
                basicAuth: { username, password },
            },
        }),
        secrets: [key],
    });
    const error = transport.redactError({
        code: `provider_${password}`,
        providerCode: username,
        message: `Basic ${btoa(`${username}:${password}`)}`,
        retryable: false,
        details: {
            [key]: [encodeURIComponent(password), {
                key: encodeURIComponent(key),
            }],
        },
    });
    const output = JSON.stringify(error);
    for (
        const secret of [
            username,
            password,
            key,
            encodeURIComponent(password),
            encodeURIComponent(key),
            btoa(`${username}:${password}`),
        ]
    ) {
        assert(!output.includes(secret));
    }
    assertEquals(error.message, "Basic [redacted]");
});
