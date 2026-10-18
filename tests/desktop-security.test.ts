import {
    assert,
    assertEquals,
    assertStringIncludes,
    assertThrows,
} from "@std/assert";
import { Hono } from "hono";
import { createServerApp } from "@heimdall/core/http/app.ts";
import { createWebSession } from "@heimdall/core/web/server/session.ts";

const origin = "http://127.0.0.1:19483";
const adminAuthToken = "desktop-private-admin-credential-123456789";
const bootstrapToken = "desktop-private-bootstrap-credential-987654321";
const bootstrapPath = "/admin/desktop/bootstrap";

function desktopApp() {
    return createServerApp({
        adminAuthToken,
        desktopSession: { origin, bootstrapToken },
    });
}

function exchange(
    app: Pick<Hono, "request">,
    token = bootstrapToken,
    headers: Record<string, string> = {},
) {
    return app.request(`${origin}${bootstrapPath}`, {
        method: "POST",
        headers: { origin, ...headers },
        body: new URLSearchParams({ token }),
    });
}

async function desktopCookie(app: Pick<Hono, "request">): Promise<string> {
    const response = await exchange(app);
    assertEquals(response.status, 204);
    const cookie = response.headers.get("set-cookie");
    assert(cookie);
    assertStringIncludes(cookie, "HttpOnly");
    assertStringIncludes(cookie, "SameSite=Strict");
    assertStringIncludes(cookie, "Path=/admin");
    assertEquals(cookie.includes("Max-Age="), false);
    assertEquals(cookie.includes(adminAuthToken), false);
    assertEquals(cookie.includes(bootstrapToken), false);
    return cookie.split(";")[0]!;
}

Deno.test("desktop sessions require explicit private credentials and a pinned loopback origin", () => {
    for (const token of [undefined, "", "   "]) {
        assertThrows(() =>
            createServerApp({
                adminAuthToken: token,
                desktopSession: { origin, bootstrapToken },
            })
        );
    }
    for (const token of ["", "short", adminAuthToken, " ".repeat(40)]) {
        assertThrows(() =>
            createServerApp({
                adminAuthToken,
                desktopSession: { origin, bootstrapToken: token },
            })
        );
    }
    for (
        const url of [
            "http://0.0.0.0:19483",
            "http://localhost:19483",
            "http://evil.example:19483",
            "https://127.0.0.1:19483",
            `${origin}/`,
            `${origin}/admin`,
            `${origin}?query=1`,
            `${origin}#fragment`,
            "http://user:password@127.0.0.1:19483",
        ]
    ) {
        assertThrows(() =>
            createServerApp({
                adminAuthToken,
                desktopSession: { origin: url, bootstrapToken },
            })
        );
    }
});

Deno.test("desktop bootstrap is absent from ordinary servers and never exposes credentials in HTML", async () => {
    const ordinary = createServerApp({ adminAuthToken });
    for (const method of ["GET", "POST"]) {
        const response = await ordinary.request(`${origin}${bootstrapPath}`, {
            method,
        });
        assertEquals(response.status, 404);
        await response.body?.cancel();
    }
    const app = desktopApp();
    const response = await app.request(`${origin}${bootstrapPath}`);
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals(response.headers.get("referrer-policy"), "no-referrer");
    assertEquals(response.headers.get("set-cookie"), null);
    const html = await response.text();
    assertEquals(html.includes(bootstrapToken), false);
    assertEquals(html.includes(adminAuthToken), false);
    assertStringIncludes(html, 'data-desktop="true"');
    assertStringIncludes(
        html,
        'history.replaceState(null, "", "/admin/desktop/bootstrap")',
    );
    assertStringIncludes(html, 'location.replace("/admin/chat")');
    const nonce = /<script nonce="([a-z0-9]+)">/.exec(html)?.[1];
    assert(nonce);
    assertStringIncludes(
        response.headers.get("content-security-policy")!,
        `script-src 'nonce-${nonce}'`,
    );
    // Reading the startup page alone never authenticates a window.
    const denied = await app.request(`${origin}/admin/ui/catalog`);
    assertEquals(denied.status, 401);
    await denied.body?.cancel();
});

Deno.test("desktop exchange authorizes the cookie bridge and catalog without relaxing API bearer authentication", async () => {
    const app = desktopApp();
    const cookie = await desktopCookie(app);
    const response = await app.request(`${origin}/admin`, {
        headers: { cookie },
    });
    assertEquals(response.status, 200);
    const html = await response.text();
    assertStringIncludes(html, 'data-desktop="true"');
    assertStringIncludes(html, '"authenticated":true');
    assertStringIncludes(html, '"desktop":true');
    assertEquals(html.includes('action="/admin/logout"'), false);
    assertEquals(html.includes(adminAuthToken), false);
    assertEquals(html.includes(bootstrapToken), false);
    const catalog = await app.request(`${origin}/admin/ui/catalog`, {
        headers: { cookie },
    });
    assertEquals(catalog.status, 200);
    await catalog.body?.cancel();
    const bridge = await app.request(`${origin}/admin/ui/request`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ path: "/api/admin/status", method: "GET" }),
    });
    assertEquals(bridge.status, 200);
    assertEquals((await bridge.json()).plugins, []);
    for (const path of ["/admin/status", "/api/admin/status"]) {
        const denied = await app.request(`${origin}${path}`, {
            headers: { cookie },
        });
        assertEquals(denied.status, 401);
        await denied.body?.cancel();
        const allowed = await app.request(`${origin}${path}`, {
            headers: { authorization: `Bearer ${adminAuthToken}` },
        });
        assertEquals(allowed.status, 200);
        await allowed.body?.cancel();
    }
    const replay = await exchange(app);
    assertEquals(replay.status, 401);
    assertEquals(replay.headers.get("set-cookie"), null);
    await replay.body?.cancel();
});

Deno.test("desktop internal management dispatch preserves JSON edits and concurrency headers", async () => {
    const management = new Hono();
    let received: unknown;
    management.put("/settings", async (context) => {
        received = {
            body: await context.req.json(),
            authorization: context.req.header("authorization"),
            version: context.req.header("if-match"),
            host: context.req.header("host"),
        };
        return context.json({ saved: true });
    });
    const app = createServerApp({
        adminAuthToken,
        desktopSession: { origin, bootstrapToken },
        adminRoutes: management,
    });
    const cookie = await desktopCookie(app);
    const response = await app.request(`${origin}/admin/ui/request`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({
            path: "/api/admin/settings",
            method: "PUT",
            headers: { "if-match": '"version-1"' },
            body: { limitPerMinute: 42 },
        }),
    });
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { saved: true });
    assertEquals(received, {
        body: { limitPerMinute: 42 },
        authorization: `Bearer ${adminAuthToken}`,
        version: '"version-1"',
        host: "127.0.0.1:19483",
    });
});

Deno.test("desktop bootstrap rejects malformed and cross-origin exchanges without consuming the valid secret", async () => {
    const app = desktopApp();
    const requests: RequestInit[] = [
        { headers: { origin }, body: new URLSearchParams() },
        { headers: { origin }, body: new URLSearchParams({ token: "wrong" }) },
        {
            headers: { origin },
            body: new URLSearchParams([
                ["token", bootstrapToken],
                ["token", bootstrapToken],
            ]),
        },
        { body: new URLSearchParams({ token: bootstrapToken }) },
        {
            headers: { origin: "https://evil.example" },
            body: new URLSearchParams({ token: bootstrapToken }),
        },
        {
            headers: { origin, "content-type": "text/plain" },
            body: bootstrapToken,
        },
        {
            headers: { origin },
            body: new URLSearchParams({ token: "x".repeat(2048) }),
        },
    ];
    const statuses = [401, 401, 401, 403, 403, 415, 413];
    for (const [index, input] of requests.entries()) {
        const response = await app.request(`${origin}${bootstrapPath}`, {
            ...input,
            method: "POST",
        });
        assertEquals(response.status, statuses[index]);
        assertEquals(response.headers.get("set-cookie"), null);
        assertEquals((await response.text()).includes(bootstrapToken), false);
    }
    await desktopCookie(app);
});

Deno.test("desktop rejects DNS rebinding, forged Host, cross-site fetches and different local origins on every route", async () => {
    const app = desktopApp();
    const cookie = await desktopCookie(app);
    const blockedHeaders: Record<string, string>[] = [
        { host: "evil.example:19483" },
        { host: "127.0.0.1:9999" },
        { origin: "https://evil.example" },
        { origin: "http://127.0.0.1:9999" },
        { origin: "null" },
        { "sec-fetch-site": "cross-site" },
        { "sec-fetch-site": "same-site" },
    ];
    for (const headers of blockedHeaders) {
        for (
            const path of [
                "/health",
                "/admin",
                "/api/admin/status",
                bootstrapPath,
            ]
        ) {
            const response = await app.request(`${origin}${path}`, {
                headers: {
                    ...headers,
                    cookie,
                    authorization: `Bearer ${adminAuthToken}`,
                },
            });
            assertEquals(response.status, 403);
            await response.body?.cancel();
        }
    }
    for (const url of ["http://evil.example:19483", "http://127.0.0.1:9999"]) {
        const response = await app.request(`${url}/admin`, {
            headers: { cookie, host: "127.0.0.1:19483" },
        });
        assertEquals(response.status, 403);
        await response.body?.cancel();
    }
    const allowed = await app.request(`${origin}/health`, {
        headers: {
            "sec-fetch-site": "none",
            "x-forwarded-host": "evil.example",
        },
    });
    assertEquals(allowed.status, 200);
    await allowed.body?.cancel();
});

Deno.test("desktop bootstrap permits only one concurrent exchange", async () => {
    const app = desktopApp();
    const responses = await Promise.all([
        exchange(app),
        exchange(app),
        exchange(app),
    ]);
    assertEquals(responses.map((item) => item.status).sort(), [204, 401, 401]);
    for (const response of responses) await response.body?.cancel();
});

Deno.test("desktop bootstrap expires after five minutes even when never exchanged", async () => {
    let now = 1_000_000;
    const session = createWebSession({
        adminAuthToken,
        desktopSession: { origin, bootstrapToken },
        now: () => now,
    });
    assert(session.desktopBootstrap);
    const app = new Hono();
    app.post(bootstrapPath, session.desktopBootstrap);
    now += 5 * 60 * 1000;
    const response = await exchange(app);
    assertEquals(response.status, 401);
    assertEquals(response.headers.get("set-cookie"), null);
    await response.body?.cancel();
});

Deno.test("desktop accepts an assigned ephemeral port and IPv6 loopback", async () => {
    let assignedOrigin = "";
    const app = createServerApp({
        adminAuthToken,
        desktopSession: { origin: () => assignedOrigin, bootstrapToken },
    });
    assignedOrigin = "http://[::1]:14932";
    const response = await app.request(`${assignedOrigin}${bootstrapPath}`, {
        method: "POST",
        headers: { origin: assignedOrigin, host: "[::1]:14932" },
        body: new URLSearchParams({ token: bootstrapToken }),
    });
    assertEquals(response.status, 204);
});

Deno.test("desktop tray sessions survive elapsed days and expire when the host restarts", async () => {
    let now = 1_000_000;
    function harness() {
        const session = createWebSession({
            adminAuthToken,
            desktopSession: { origin, bootstrapToken },
            now: () => now,
        });
        assert(session.desktopBootstrap);
        const app = new Hono();
        app.post(bootstrapPath, session.desktopBootstrap);
        app.get(
            "/admin",
            async (context) =>
                context.json({ authorized: await session.authorized(context) }),
        );
        return app;
    }
    const original = harness();
    const cookie = await desktopCookie(original);
    now += 30 * 24 * 60 * 60 * 1000;
    const restored = await original.request(`${origin}/admin`, {
        headers: { cookie },
    });
    assertEquals(await restored.json(), { authorized: true });
    const restarted = await harness().request(`${origin}/admin`, {
        headers: { cookie },
    });
    assertEquals(await restarted.json(), { authorized: false });
});

Deno.test("desktop replacement windows rotate one-time secrets without expiring existing window cookies", async () => {
    let now = 1_000_000;
    let currentToken = bootstrapToken;
    const session = createWebSession({
        adminAuthToken,
        desktopSession: { origin, bootstrapToken: () => currentToken },
        now: () => now,
    });
    assert(session.desktopBootstrap);
    assert(session.desktopBootstrapDocument);
    const app = new Hono();
    app.post(bootstrapPath, session.desktopBootstrap);
    app.get(bootstrapPath, session.desktopBootstrapDocument);
    app.get(
        "/admin",
        async (context) =>
            context.json({ authorized: await session.authorized(context) }),
    );
    const originalCookie = await desktopCookie(app);
    now += 24 * 60 * 60 * 1000;
    const replacementToken =
        "replacement-desktop-bootstrap-credential-123456789";
    currentToken = replacementToken;
    const navigation = await app.request(`${origin}${bootstrapPath}`);
    assertEquals(navigation.status, 200);
    await navigation.body?.cancel();
    const old = await exchange(app, bootstrapToken);
    assertEquals(old.status, 401);
    await old.body?.cancel();
    const replacement = await exchange(app, replacementToken);
    assertEquals(replacement.status, 204);
    assert(replacement.headers.get("set-cookie"));
    const existing = await app.request(`${origin}/admin`, {
        headers: { cookie: originalCookie },
    });
    assertEquals(await existing.json(), { authorized: true });
    // A host accidentally rotating back must not revive an old credential.
    currentToken = bootstrapToken;
    const reused = await exchange(app, bootstrapToken);
    assertEquals(reused.status, 401);
    await reused.body?.cancel();
    currentToken = "third-desktop-bootstrap-credential-987654321";
    const nextWindow = await app.request(`${origin}${bootstrapPath}`);
    await nextWindow.body?.cancel();
    now += 5 * 60 * 1000;
    const expired = await exchange(app, currentToken);
    assertEquals(expired.status, 401);
    await expired.body?.cancel();
});

Deno.test("desktop origin middleware preserves native WebSocket upgrades with a session cookie", async () => {
    const chat = new Hono();
    chat.get("/socket", (context) => {
        const { response, socket } = Deno.upgradeWebSocket(context.req.raw);
        socket.onopen = () => socket.close();
        return response;
    });
    let assignedOrigin = "";
    const app = createServerApp({
        adminAuthToken,
        desktopSession: { origin: () => assignedOrigin, bootstrapToken },
        chatRoutes: chat,
    });
    const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        app.fetch,
    );
    assignedOrigin = `http://127.0.0.1:${server.addr.port}`;
    let connection: Deno.TcpConn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const login = await fetch(`${assignedOrigin}${bootstrapPath}`, {
            method: "POST",
            headers: { origin: assignedOrigin },
            body: new URLSearchParams({ token: bootstrapToken }),
        });
        assertEquals(login.status, 204);
        const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
        connection = await Deno.connect({
            hostname: "127.0.0.1",
            port: server.addr.port,
        });
        const handshake = new TextEncoder().encode([
            "GET /admin/chat/api/socket HTTP/1.1",
            `Host: 127.0.0.1:${server.addr.port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            `Origin: ${assignedOrigin}`,
            `Cookie: ${cookie}`,
            "",
            "",
        ].join("\r\n"));
        let offset = 0;
        while (offset < handshake.length) {
            offset += await connection.write(handshake.subarray(offset));
        }
        timer = setTimeout(() => connection?.close(), 5000);
        const buffer = new Uint8Array(4096);
        let received = "";
        while (!received.includes("\r\n\r\n")) {
            const count = await connection.read(buffer);
            assert(
                count !== null,
                "socket closed before the upgrade completed",
            );
            received += new TextDecoder().decode(buffer.subarray(0, count));
        }
        assertStringIncludes(received, "HTTP/1.1 101");
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        try {
            connection?.close();
        } catch { /* Already closed by the deadline. */ }
        await server.shutdown();
    }
});
