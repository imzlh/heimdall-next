import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/deno";
import type { ServerEnv } from "@heimdall/core/http/app.ts";
import {
    chatSocketProtocol,
    createChatAuthMiddleware,
} from "@heimdall/core/http/chat-auth.ts";

function guardedApp(token?: string): Hono<ServerEnv> {
    const app = new Hono<ServerEnv>();
    app.use("*", async (context, next) => {
        context.set("requestId", "chat-auth-test");
        await next();
    });
    app.use("*", createChatAuthMiddleware(token));
    app.all("*", (context) => context.json({ ok: true }));
    return app;
}

function protocols(token: string): string[] {
    const bytes = new TextEncoder().encode(token);
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
        "",
    );
    const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
        .replace(/=+$/, "");
    return ["heimdall-chat", `heimdall-auth.${encoded}`];
}

Deno.test("chat HTTP requires the management Bearer token before its handler", async () => {
    const app = guardedApp("  chat-secret  ");
    for (
        const headers of [
            {},
            { authorization: "Bearer wrong" },
            { authorization: "bearer chat-secret" },
            { "sec-websocket-protocol": protocols("chat-secret").join(", ") },
        ] as Record<string, string>[]
    ) {
        const denied = await app.request(
            "http://localhost/api/chat/message?token=chat-secret",
            { method: "POST", headers },
        );
        assertEquals(denied.status, 401);
        assertEquals(
            denied.headers.get("x-heimdall-request-id"),
            "chat-auth-test",
        );
        assertEquals(await denied.json(), {
            error: {
                code: "unauthorized",
                message: "admin bearer token required",
                request_id: "chat-auth-test",
            },
        });
    }
    const allowed = await app.request("http://localhost/api/chat/message", {
        method: "POST",
        headers: { authorization: "Bearer   chat-secret  " },
    });
    assertEquals(allowed.status, 200);
    assertEquals(await allowed.json(), { ok: true });
});

Deno.test("chat remains anonymous without a token but rejects an empty configured token", async () => {
    const anonymous = await guardedApp().request(
        "http://localhost/api/chat/conversations",
    );
    assertEquals(anonymous.status, 200);
    await anonymous.body?.cancel();
    for (const token of ["", "  "]) {
        const denied = await guardedApp(token).request(
            "http://localhost/api/chat/conversations",
        );
        assertEquals(denied.status, 401);
        await denied.body?.cancel();
    }
});

Deno.test("chat WebSockets accept UTF-8 token protocols and tool-client Bearer headers", async () => {
    const unicode = "聊天 🔐 token";
    const browser = await guardedApp(unicode).request(
        "http://localhost/api/chat/socket",
        {
            headers: {
                upgrade: "websocket",
                origin: "http://localhost",
                "sec-websocket-protocol": protocols(unicode).join(", "),
            },
        },
    );
    assertEquals(browser.status, 200);
    await browser.body?.cancel();

    const tool = await guardedApp("chat-secret").request(
        "http://localhost/api/chat/socket",
        {
            headers: {
                upgrade: "websocket",
                authorization: "Bearer chat-secret",
            },
        },
    );
    assertEquals(tool.status, 200);
    await tool.body?.cancel();
});

Deno.test("chat WebSockets reject missing, malformed, ambiguous, and URL credentials", async () => {
    const app = guardedApp("chat-secret");
    const encoded = protocols("chat-secret")[1]!;
    for (
        const credential of [
            "",
            "heimdall-chat",
            encoded,
            "heimdall-chat, heimdall-auth.",
            "heimdall-chat, heimdall-auth.%%%",
            "heimdall-chat, heimdall-auth.a",
            "heimdall-chat, heimdall-auth._w",
            `heimdall-chat, ${encoded}, ${encoded}`,
            protocols("wrong").join(", "),
        ]
    ) {
        const response = await app.request(
            "http://localhost/api/chat/socket?token=chat-secret",
            {
                headers: {
                    upgrade: "websocket",
                    "sec-websocket-protocol": credential,
                },
            },
        );
        assertEquals(response.status, 401, credential);
        const body = await response.text();
        assertEquals(body.includes("chat-secret"), false);
    }
    const conflicting = await app.request("http://localhost/api/chat/socket", {
        headers: {
            upgrade: "websocket",
            authorization: "Bearer wrong",
            "sec-websocket-protocol": protocols("chat-secret").join(", "),
        },
    });
    assertEquals(conflicting.status, 401);
    await conflicting.body?.cancel();
});

Deno.test("chat WebSockets reject cross-origin and malformed Origin even without authentication", async () => {
    for (const token of [undefined, "chat-secret"]) {
        const app = guardedApp(token);
        for (
            const origin of [
                "http://evil.example",
                "https://localhost",
                "http://localhost:8080",
                "null",
                "not-an-origin",
                "http://localhost@evil.example",
                "http://user@localhost",
                "http://localhost/path",
                "http://localhost?query",
                "http://localhost#fragment",
                "http://localhost http://evil.example",
            ]
        ) {
            const response = await app.request(
                "http://localhost/api/chat/socket",
                {
                    headers: {
                        upgrade: "websocket",
                        authorization: "Bearer chat-secret",
                        origin,
                    },
                },
            );
            assertEquals(response.status, 403, origin);
            assertEquals(
                (await response.json()).error.code,
                "forbidden_origin",
            );
        }
    }
});

Deno.test("chat WebSocket origin accepts direct hosts and a reverse proxy's preserved Host", async () => {
    const app = guardedApp();
    for (
        const headers of [
            {},
            { origin: "http://127.0.0.1:8088" },
            { origin: "http://localhost:5174", host: "localhost:5174" },
            { origin: "http://[::1]:5174", host: "[::1]:5174" },
            { origin: "http://localhost", host: "localhost:80" },
        ] as Record<string, string>[]
    ) {
        const response = await app.request(
            "http://127.0.0.1:8088/api/chat/socket",
            {
                headers: { upgrade: "websocket", ...headers },
            },
        );
        assertEquals(response.status, 200);
        await response.body?.cancel();
    }
});

Deno.test("chat WebSocket origin ignores forwarded headers and rejects malformed Host", async () => {
    const app = guardedApp();
    for (
        const host of [
            "localhost:8088",
            "evil.example/path",
            "user@evil.example",
            "evil.example\\path",
            "evil.example?query",
            "evil.example#fragment",
            "evil.example,localhost",
            "evil.example localhost",
        ]
    ) {
        const response = await app.request(
            "http://127.0.0.1:8088/api/chat/socket",
            {
                headers: {
                    upgrade: "websocket",
                    origin: "http://evil.example",
                    host,
                    forwarded: "host=evil.example;proto=http",
                    "x-forwarded-host": "evil.example",
                    "x-forwarded-proto": "http",
                    "x-forwarded-origin": "http://evil.example",
                },
            },
        );
        assertEquals(response.status, 403, host);
        await response.body?.cancel();
    }
});

Deno.test("chat protocol selection never reflects credential protocols", () => {
    for (
        const offered of [
            "",
            protocols("secret")[1]!,
            "another-protocol",
            "heimdall-chat-other",
        ]
    ) {
        assertEquals(
            chatSocketProtocol(
                new Request("http://localhost", {
                    headers: { "sec-websocket-protocol": offered },
                }),
            ),
            undefined,
        );
    }
    assertEquals(
        chatSocketProtocol(
            new Request("http://localhost", {
                headers: {
                    "sec-websocket-protocol": [
                        ...protocols("secret").reverse(),
                        "other",
                    ].join(", "),
                },
            }),
        ),
        "heimdall-chat",
    );
});

Deno.test("chat WebSocket upgrade selects only the application protocol", async () => {
    const token = "聊天 🔐 token";
    const app = new Hono<ServerEnv>();
    app.use("*", createChatAuthMiddleware(token));
    app.get("/socket", (context, next) =>
        upgradeWebSocket(() => ({
            onOpen(_event, socket) {
                socket.send("authenticated");
            },
        }), { protocol: chatSocketProtocol(context.req.raw) })(context, next));
    const server = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        onListen() {},
    }, app.fetch);
    const socket = new WebSocket(
        `ws://127.0.0.1:${server.addr.port}/socket`,
        protocols(token),
    );
    const closed = new Promise<void>((resolve) => {
        socket.addEventListener("close", () => resolve(), { once: true });
    });
    try {
        const message = await new Promise<string>((resolve, reject) => {
            socket.addEventListener(
                "message",
                (event) => resolve(String(event.data)),
                { once: true },
            );
            socket.addEventListener(
                "error",
                () => reject(new Error("WebSocket upgrade failed")),
                { once: true },
            );
        });
        assertEquals(message, "authenticated");
        assertEquals(socket.protocol, "heimdall-chat");
    } finally {
        socket.close();
        await closed;
        await server.shutdown();
    }
});
