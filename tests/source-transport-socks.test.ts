import { assertEquals } from "@std/assert";
import { SourceTransport } from "../packages/source-sdk/mod.ts";

for (const withNoProxy of [false, true]) {
    Deno.test(`SOCKS authentication stays in the handshake${withNoProxy ? " despite environment NO_PROXY" : ""}`, async () => {
        const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
        let socket: Deno.TcpConn | undefined;
        const username = "socks-user";
        const password = "socks-password";
        const serve = (async () => {
            socket = await listener.accept();
            const read = async (length: number): Promise<Uint8Array> => {
                const buffer = new Uint8Array(length);
                let offset = 0;
                while (offset < length) {
                    const size = await socket!.read(buffer.subarray(offset));
                    if (size === null) {
                        throw new Error("SOCKS peer closed early");
                    }
                    offset += size;
                }
                return buffer;
            };
            const greeting = await read(2);
            assertEquals(greeting[0], 5);
            const methods = await read(greeting[1]!);
            assertEquals(methods.includes(2), true);
            await socket.write(new Uint8Array([5, 2]));
            const auth = await read(2);
            assertEquals(auth[0], 1);
            assertEquals(
                new TextDecoder().decode(await read(auth[1]!)),
                username,
            );
            const passwordLength = (await read(1))[0]!;
            assertEquals(
                new TextDecoder().decode(await read(passwordLength)),
                password,
            );
            await socket.write(new Uint8Array([1, 0]));
            const request = await read(4);
            assertEquals([...request.subarray(0, 3)], [5, 1, 0]);
            const addressLength = request[3] === 1
                ? 4
                : request[3] === 4
                ? 16
                : (await read(1))[0]!;
            await read(addressLength + 2);
            await socket.write(
                new Uint8Array([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]),
            );
            let headers = "";
            while (!headers.endsWith("\r\n\r\n") && headers.length < 8192) {
                headers += String.fromCharCode((await read(1))[0]!);
            }
            assertEquals(
                headers.toLowerCase().includes("proxy-authorization"),
                false,
            );
            assertEquals(headers.includes(username), false);
            assertEquals(headers.includes(password), false);
            await socket.write(
                new TextEncoder().encode(
                    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                ),
            );
        })();
        void serve.catch(() => {});
        try {
            if (withNoProxy) {
                const module =
                    new URL("../packages/source-sdk/mod.ts", import.meta.url)
                        .href;
                const script = `
                import { SourceTransport } from ${JSON.stringify(module)};
                await using transport = new SourceTransport({
                    signal: AbortSignal.timeout(5000),
                    getProxy: () => ({ mode: "proxy", selectedBy: "source", proxy: {
                        id: "socks", name: "SOCKS", url: ${
                    JSON.stringify(`socks5://127.0.0.1:${listener.addr.port}`)
                },
                        basicAuth: { username: ${
                    JSON.stringify(username)
                }, password: ${JSON.stringify(password)} },
                    } }),
                });
                console.log(await (await transport.fetch("http://127.0.0.1:65534/models")).text());
            `;
                const result = await new Deno.Command(Deno.execPath(), {
                    args: ["eval", "--quiet", "--cached-only", script],
                    env: {
                        NO_PROXY: "*",
                        HTTP_PROXY: "http://127.0.0.1:65533",
                        HTTPS_PROXY: "http://127.0.0.1:65533",
                    },
                    stdout: "piped",
                    stderr: "piped",
                }).output();
                assertEquals(
                    result.code,
                    0,
                    new TextDecoder().decode(result.stderr),
                );
                assertEquals(
                    new TextDecoder().decode(result.stdout).trim(),
                    "ok",
                );
                await serve;
                return;
            }
            await using transport = new SourceTransport({
                signal: AbortSignal.timeout(5000),
                getProxy: () => ({
                    mode: "proxy",
                    selectedBy: "source",
                    proxy: {
                        id: "socks",
                        name: "SOCKS",
                        url: `socks5://127.0.0.1:${listener.addr.port}`,
                        basicAuth: { username, password },
                    },
                }),
            });
            assertEquals(
                await (await transport.fetch("http://127.0.0.1:65534/models"))
                    .text(),
                "ok",
            );
            await serve;
        } finally {
            listener.close();
            socket?.close();
            await Promise.allSettled([serve]);
        }
    });
}
