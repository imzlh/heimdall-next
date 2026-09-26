import { assert, assertEquals, assertRejects } from "@std/assert";
import { SourceTransport } from "../packages/source-sdk/mod.ts";

const fixtures = new URL("./fixtures/source-transport/", import.meta.url);

Deno.test("direct TLS and authenticated CONNECT retain HTTPS and certificate verification", async () => {
    const certPath = new URL("localhost-cert.pem", fixtures);
    const [cert, key] = await Promise.all([
        Deno.readTextFile(certPath),
        Deno.readTextFile(new URL("localhost-key.pem", fixtures)),
    ]);
    const requests: string[] = [];
    const upstream = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        cert,
        key,
        onListen() {},
    }, (request) => {
        requests.push(request.url);
        // Proxy credentials belong to CONNECT, never the encrypted request.
        assertEquals(request.headers.get("proxy-authorization"), null);
        return new Response("encrypted-response");
    });
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const connects: string[] = [];
    const sockets = new Set<Deno.TcpConn>();
    const handlers: Promise<void>[] = [];
    const accepting = (async () => {
        try {
            for await (const client of listener) {
                sockets.add(client);
                const handling = (async () => {
                    const header: number[] = [];
                    const byte = new Uint8Array(1);
                    while (header.length < 8192) {
                        if (await client.read(byte) === null) {
                            throw new Error("CONNECT ended early");
                        }
                        header.push(byte[0]!);
                        if (header.slice(-4).join(",") === "13,10,13,10") break;
                    }
                    connects.push(
                        new TextDecoder().decode(new Uint8Array(header)),
                    );
                    const target = await Deno.connect({
                        hostname: "127.0.0.1",
                        port: upstream.addr.port,
                    });
                    sockets.add(target);
                    await client.write(
                        new TextEncoder().encode(
                            "HTTP/1.1 200 Connection established\r\n\r\n",
                        ),
                    );
                    await Promise.allSettled([
                        client.readable.pipeTo(target.writable),
                        target.readable.pipeTo(client.writable),
                    ]);
                })();
                handlers.push(handling);
                // Retain failures for the final assertion without unhandled promises.
                void handling.catch(() => {});
            }
        } catch (error) {
            if (!(error instanceof Deno.errors.BadResource)) throw error;
        }
    })();
    const target = `https://127.0.0.1:${upstream.addr.port}/models`;
    try {
        using untrusted = new SourceTransport({
            getProxy: () => ({ mode: "direct", selectedBy: "source" }),
        });
        // A pinned TCP client must still validate the server's TLS certificate.
        await assertRejects(() => untrusted.fetch(target));
        const module =
            new URL("../packages/source-sdk/mod.ts", import.meta.url).href;
        const script = `
            import { SourceTransport } from ${JSON.stringify(module)};
            const target = ${JSON.stringify(target)};
            using direct = new SourceTransport({ getProxy: () => ({ mode: "direct", selectedBy: "source" }) });
            const plain = await (await direct.fetch(target)).text();
            using proxy = new SourceTransport({ getProxy: () => ({ mode: "proxy", selectedBy: "source", proxy: {
                id: "test", name: "Test", url: ${
            JSON.stringify(`http://127.0.0.1:${listener.addr.port}`)
        },
                basicAuth: { username: "connect-user", password: "connect-password" },
            } }) });
            const proxied = await (await proxy.fetch(target)).text();
            console.log(JSON.stringify({ plain, proxied }));
        `;
        // Deno accepts an OS path, not a file URL, for its certificate bundle.
        const path = decodeURIComponent(certPath.pathname).replace(
            /^\/(?:([A-Za-z]):\/)/,
            "$1:/",
        );
        const result = await new Deno.Command(Deno.execPath(), {
            args: ["eval", "--quiet", "--cached-only", script],
            env: { DENO_CERT: path, NODE_EXTRA_CA_CERTS: path },
            stdout: "piped",
            stderr: "piped",
        }).output();
        assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
        assertEquals(JSON.parse(new TextDecoder().decode(result.stdout)), {
            plain: "encrypted-response",
            proxied: "encrypted-response",
        });
        assertEquals(requests, [target, target]);
        assertEquals(connects.length, 1);
        assert(
            connects[0]!.startsWith(
                `CONNECT 127.0.0.1:${upstream.addr.port} HTTP/1.1\r\n`,
            ),
        );
        assert(
            connects[0]!.toLowerCase().includes(
                `proxy-authorization: basic ${
                    btoa("connect-user:connect-password")
                }`.toLowerCase(),
            ),
        );
    } finally {
        listener.close();
        for (const socket of sockets) {
            try {
                socket.close();
            } catch { /* A completed pipe already closed it. */ }
        }
        await accepting;
        const results = await Promise.allSettled(handlers);
        await upstream.shutdown();
        for (const result of results) assertEquals(result.status, "fulfilled");
    }
});
