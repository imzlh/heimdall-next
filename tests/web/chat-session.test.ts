import { assert, assertEquals, assertFalse } from "@std/assert";
import { Hono } from "hono";
import { createServerApp, type ServerEnv } from "@heimdall/core/http/app.ts";
import { createServer } from "../../main.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";
import type { InferenceSource } from "@heimdall/contracts";
import type { StreamFrame } from "@heimdall/hip";

const origin = "http://127.0.0.1";
const token = "private-chat-token";

Deno.test("chat web routes reuse the admin session without authorizing original bearer APIs", async () => {
    const store = openSqliteChatStore(":memory:");
    try {
        const app = createServer({ adminAuthToken: token, chat: { store } });
        assertEquals(
            (await app.request(`${origin}/admin/chat/api/conversations`))
                .status,
            401,
        );
        const login = await app.request(`${origin}/admin/session`, {
            method: "POST",
            headers: { origin },
            body: new URLSearchParams({ token, returnTo: "/admin/chat" }),
        });
        const setCookie = login.headers.get("set-cookie")!;
        assertEquals(login.headers.get("location"), "/admin/chat");
        assert(setCookie.includes("HttpOnly"));
        const cookie = setCookie.split(";")[0]!;
        const created = await app.request(
            `${origin}/admin/chat/api/conversations`,
            {
                method: "POST",
                headers: { origin, cookie },
            },
        );
        assertEquals(created.status, 201);
        const conversationId = (await created.json()).conversation.id as string;
        const history = await app.request(
            `${origin}/admin/chat/api/conversation?id=${conversationId}`,
            { headers: { cookie } },
        );
        assertEquals(history.status, 200);
        assertEquals((await history.json()).conversation.id, conversationId);
        assertEquals(history.headers.get("cache-control"), "no-store");
        assertEquals(
            (await app.request(`${origin}/api/chat/conversations`, {
                headers: { cookie },
            })).status,
            401,
        );
        assertEquals(
            (await app.request(`${origin}/api/chat/conversations`, {
                headers: { authorization: `Bearer ${token}` },
            })).status,
            200,
        );
        const url =
            `${origin}/admin/chat/api/conversation?id=${conversationId}`;
        for (const method of ["PATCH", "DELETE"]) {
            const forbidden = await app.request(url, {
                method,
                headers: { cookie, origin: "https://attacker.test" },
                body: JSON.stringify({ title: "不应保存" }),
            });
            assertEquals(forbidden.status, 403);
            await forbidden.body?.cancel();
            // Cookie sessions never authorize the original Bearer API.
            const bearer = await app.request(
                `${origin}/api/chat/conversation?id=${conversationId}`,
                {
                    method,
                    headers: { cookie, origin },
                    body: JSON.stringify({ title: "不应保存" }),
                },
            );
            assertEquals(bearer.status, 401);
            await bearer.body?.cancel();
        }
        const renamed = await app.request(url, {
            method: "PATCH",
            headers: { origin, cookie, "content-type": "application/json" },
            body: JSON.stringify({ title: "使用后台会话重命名" }),
        });
        assertEquals(renamed.status, 200);
        assertEquals(
            (await renamed.json()).conversation.title,
            "使用后台会话重命名",
        );
        assertEquals(renamed.headers.get("cache-control"), "no-store");
        const deleted = await app.request(url, {
            method: "DELETE",
            headers: { origin, cookie },
        });
        assertEquals(deleted.status, 200);
        assertEquals(await deleted.json(), {
            deleted: true,
            id: conversationId,
        });
        assertEquals(deleted.headers.get("cache-control"), "no-store");
        assertEquals(store.getConversation(conversationId), null);
    } finally {
        store.close();
    }
});

Deno.test("chat login return location is restricted to the two host pages", async () => {
    const app = createServerApp();
    for (
        const returnTo of [
            "https://attacker.test",
            "//attacker.test",
            "/admin/chat?redirect=https://attacker.test",
        ]
    ) {
        const response = await app.request(`${origin}/admin/session`, {
            method: "POST",
            headers: { origin },
            body: new URLSearchParams({ token: "", returnTo }),
        });
        assertEquals(response.status, 303);
        assertEquals(response.headers.get("location"), "/admin");
    }
});

Deno.test("chat web mutations and sockets require exact same origin before invoking the raw handler", async () => {
    const routes = new Hono<ServerEnv>();
    let invoked = 0;
    let received: Request | undefined;
    const handler = (request: Request) => {
        invoked++;
        received = request;
        return Response.json({ ok: true });
    };
    routes.post("/message", (context) => handler(context.req.raw));
    routes.get("/socket", (context) => handler(context.req.raw));
    const app = createServerApp({ chatRoutes: routes });
    for (const path of ["/admin/chat/api/message", "/admin/chat/api/socket"]) {
        const socket = path.endsWith("socket");
        const variants: Record<string, string>[] = [
            {},
            { origin: "null" },
            { origin: "https://attacker.test" },
            { origin: "http://proxy.test", host: "proxy.test" },
            { origin, "sec-fetch-site": "cross-site" },
            { origin, "sec-fetch-site": "same-site" },
        ];
        for (const headers of variants) {
            const response = await app.request(`${origin}${path}`, {
                method: socket ? "GET" : "POST",
                headers: {
                    ...headers,
                    ...(socket ? { upgrade: "websocket" } : {}),
                },
            });
            assertEquals(response.status, 403);
        }
    }
    assertEquals(invoked, 0);
    const request = new Request(`${origin}/admin/chat/api/message`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: '{"text":"hello"}',
    });
    assertEquals((await app.fetch(request)).status, 200);
    assertEquals(received, request);
    assertEquals(invoked, 1);
});

function source(): InferenceSource {
    return {
        id: "web-chat-source",
        capabilities: [{
            operation: "generation.create",
            models: ["web-chat-model"],
            streaming: true,
        }],
        execute(input) {
            return (async function* (): AsyncIterable<StreamFrame> {
                const events: StreamFrame["event"][] = [
                    { kind: "run.started", request: input },
                    {
                        kind: "part.delta",
                        messageId: "reply",
                        partId: "text",
                        delta: "会话已连接",
                    },
                    { kind: "run.completed" },
                ];
                for (const [index, event] of events.entries()) {
                    yield {
                        version: 1,
                        requestId: input.requestId,
                        streamId: "web-chat",
                        seq: index + 1,
                        eventId: `event-${index}`,
                        timestamp: new Date().toISOString(),
                        event,
                    };
                }
            })();
        },
    };
}

/** Small RFC 6455 client for supplying the HttpOnly cookie a browser would send. */
class CookieSocket {
    #buffer = new Uint8Array(0);
    constructor(readonly connection: Deno.TcpConn) {}
    async #take(length: number): Promise<Uint8Array> {
        while (this.#buffer.length < length) {
            const bytes = new Uint8Array(8192);
            const count = await this.connection.read(bytes);
            if (count === null) {
                throw new Error("socket closed before response");
            }
            const combined = new Uint8Array(this.#buffer.length + count);
            combined.set(this.#buffer);
            combined.set(bytes.subarray(0, count), this.#buffer.length);
            this.#buffer = combined;
        }
        const value = this.#buffer.slice(0, length);
        this.#buffer = this.#buffer.slice(length);
        return value;
    }
    async handshake(port: number, cookie: string): Promise<string> {
        await this.#write(new TextEncoder().encode([
            "GET /admin/chat/api/socket HTTP/1.1",
            `Host: 127.0.0.1:${port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Protocol: heimdall-chat",
            `Origin: http://127.0.0.1:${port}`,
            `Cookie: ${cookie}`,
            "",
            "",
        ].join("\r\n")));
        let headers = "";
        while (!headers.endsWith("\r\n\r\n")) {
            headers += String.fromCharCode((await this.#take(1))[0]!);
            if (headers.length > 16_384) throw new Error("oversized handshake");
        }
        return headers;
    }
    async send(value: unknown): Promise<void> {
        const data = new TextEncoder().encode(JSON.stringify(value));
        assert(data.length < 65_536);
        const prefix = data.length < 126 ? 2 : 4;
        const frame = new Uint8Array(prefix + 4 + data.length);
        frame[0] = 0x81;
        frame[1] = 0x80 | (data.length < 126 ? data.length : 126);
        if (prefix === 4) {
            frame[2] = data.length >> 8;
            frame[3] = data.length & 255;
        }
        const mask = [1, 2, 3, 4];
        frame.set(mask, prefix);
        for (let index = 0; index < data.length; index++) {
            frame[prefix + 4 + index] = data[index]! ^ mask[index % 4]!;
        }
        await this.#write(frame);
    }
    async receive(): Promise<Record<string, unknown>> {
        const [opcode, lengthByte] = await this.#take(2);
        assertEquals(opcode, 0x81);
        let length = lengthByte! & 127;
        if (length === 126) {
            const wide = await this.#take(2);
            length = wide[0]! * 256 + wide[1]!;
        }
        assert(length < 65_536);
        return JSON.parse(new TextDecoder().decode(await this.#take(length)));
    }
    async #write(bytes: Uint8Array): Promise<void> {
        let offset = 0;
        while (offset < bytes.length) {
            offset += await this.connection.write(bytes.subarray(offset));
        }
    }
}

Deno.test("real chat WebSocket upgrades and streams with only the HttpOnly session cookie", async () => {
    const store = openSqliteChatStore(":memory:");
    const app = createServer({
        adminAuthToken: token,
        sources: [source()],
        chat: { store },
    });
    const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        app.fetch,
    );
    const base = `http://127.0.0.1:${server.addr.port}`;
    let connection: Deno.TcpConn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const login = await fetch(`${base}/admin/session`, {
            method: "POST",
            headers: { origin: base },
            body: new URLSearchParams({ token }),
            redirect: "manual",
        });
        const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
        await login.body?.cancel();
        assertFalse(cookie.includes(token));
        connection = await Deno.connect({
            hostname: "127.0.0.1",
            port: server.addr.port,
        });
        const socket = new CookieSocket(connection);
        const conversation = store.createConversation(
            "Web 会话",
            new Date().toISOString(),
        );
        const run = async () => {
            const handshake = await socket.handshake(server.addr.port, cookie);
            assert(handshake.startsWith("HTTP/1.1 101"));
            assert(
                handshake.toLowerCase().includes(
                    "sec-websocket-protocol: heimdall-chat",
                ),
            );
            assertFalse(handshake.includes(token));
            await socket.send({
                type: "send",
                conversationId: conversation.id,
                model: "web-chat-model",
                text: "invalid images",
                attachments: Array.from(
                    { length: 5 },
                    () => ({ mediaType: "image/png", dataBase64: "YQ==" }),
                ),
            });
            assertEquals((await socket.receive()).type, "error");
            assertEquals(store.listMessages(conversation.id), []);
            await socket.send({
                type: "send",
                conversationId: conversation.id,
                model: "web-chat-model",
                text: "你好",
                attachments: [{ mediaType: "image/png", dataBase64: "YQ==" }],
            });
            const events: Record<string, unknown>[] = [];
            do {
                events.push(await socket.receive());
            } while (events.at(-1)?.type !== "done");
            assert(
                events.some((event) =>
                    event.type === "delta" && event.text === "会话已连接"
                ),
            );
            assert(
                store.listMessages(conversation.id).some((message) =>
                    message.text === "会话已连接"
                ),
            );
            assertEquals(
                store.listMessages(conversation.id).find((message) =>
                    message.role === "user"
                )?.attachments,
                [{ mediaType: "image/png", dataBase64: "YQ==" }],
            );
        };
        await Promise.race([
            run(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error("chat cookie WebSocket timed out")),
                    5000,
                );
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        connection?.close();
        await server.shutdown();
        store.close();
    }
});
