import { assert, assertEquals, assertRejects } from "@std/assert";
import { Hono } from "hono";
import type { AdminDispatch } from "@heimdall/core/web/server/bridge.ts";
import { createJournalDownload } from "@heimdall/core/web/server/journal-download.ts";
import { createWebSession } from "@heimdall/core/web/server/session.ts";

const origin = "https://console.example.test";
const token = "journal-server-secret";
const downloadPath = "/admin/ui/requests/export";

function harness(dispatch: AdminDispatch) {
    const session = createWebSession({ adminAuthToken: token });
    const app = new Hono();
    app.post("/admin/session", session.login);
    // Register all methods to exercise the handler's own read-only guard.
    app.all(
        downloadPath,
        createJournalDownload({
            session,
            dispatch,
            adminAuthToken: token,
        }),
    );
    return app;
}

async function loginCookie(app: Hono): Promise<string> {
    const response = await app.request(`${origin}/admin/session`, {
        method: "POST",
        headers: { origin },
        body: new URLSearchParams({ token }),
    });
    assertEquals(response.status, 303);
    const cookie = response.headers.get("set-cookie");
    assert(cookie !== null);
    return cookie.split(";")[0]!;
}

function assertPrivate(response: Response): void {
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals(response.headers.get("x-content-type-options"), "nosniff");
    assertEquals(
        response.headers.get("content-type"),
        "application/json; charset=utf-8",
    );
    assertEquals(response.headers.get("set-cookie"), null);
    assertEquals(response.headers.get("authorization"), null);
    assertEquals(response.headers.get("location"), null);
    assertEquals(JSON.stringify([...response.headers]).includes(token), false);
}

Deno.test("journal download streams more than the JSON bridge limit without buffering or truncation", async () => {
    const encoder = new TextEncoder();
    const payload = "a".repeat(1_048_576);
    const chunks = [
        '{"request":{"requestId":"large"},"frames":["',
        ...Array.from({ length: 5 }, () => payload),
        '"]}',
    ];
    let pulled = 0;
    const app = harness(() =>
        new Response(
            new ReadableStream<Uint8Array>({
                pull(controller) {
                    const chunk = chunks[pulled++];
                    if (chunk === undefined) controller.close();
                    else controller.enqueue(encoder.encode(chunk));
                },
            }, { highWaterMark: 0 }),
            {
                headers: {
                    "content-type": "application/json",
                    "content-length": String(chunks.join("").length),
                    "set-cookie": `secret=${token}`,
                    authorization: `Bearer ${token}`,
                    "content-disposition":
                        'attachment; filename="untrusted.html"',
                    "x-heimdall-request-id": "nested-trace",
                },
            },
        )
    );
    const cookie = await loginCookie(app);
    const response = await app.request(`${origin}${downloadPath}?id=large`, {
        headers: { cookie, "x-request-id": "outer-trace" },
    });
    assertEquals(response.status, 200);
    assertEquals(pulled, 0);
    assertPrivate(response);
    assertEquals(
        response.headers.get("content-disposition"),
        'attachment; filename="heimdall-request.json"',
    );
    assertEquals(response.headers.get("x-heimdall-request-id"), "outer-trace");
    const text = await response.text();
    assertEquals(text, chunks.join(""));
    assertEquals(JSON.parse(text).frames[0].length, 5_242_880);
});

Deno.test("journal download authenticates the cookie and scopes dispatch to the exact export target", async () => {
    const received: Request[] = [];
    const app = harness((request) => {
        received.push(request);
        return Response.json({ request: {}, frames: [] });
    });
    const unauthenticated = await app.request(
        `${origin}${downloadPath}?id=one`,
    );
    assertEquals(unauthenticated.status, 401);
    assertEquals((await unauthenticated.json()).error.code, "unauthorized");
    assertPrivate(unauthenticated);
    assertEquals(received.length, 0);
    const cookie = await loginCookie(app);
    const id = 'opaque": id?#=&%';
    const query = new URLSearchParams({ id });
    // Normal <a> navigation has no Origin header and needs no JavaScript.
    const response = await app.request(`${origin}${downloadPath}?${query}`, {
        headers: {
            cookie,
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "navigate",
            "x-request-id": "download-trace",
            authorization: "Bearer ignored-client-token",
            "x-untrusted": "never forwarded",
        },
    });
    assertEquals(response.status, 200);
    assertEquals(received.length, 1);
    const inner = received[0]!;
    const target = new URL(inner.url);
    assertEquals(target.origin, origin);
    assertEquals(target.pathname, "/api/admin/requests/export");
    assertEquals([...target.searchParams], [["id", id]]);
    assertEquals(inner.method, "GET");
    assertEquals(inner.redirect, "manual");
    assertEquals([...inner.headers], [
        ["accept", "application/json"],
        ["authorization", `Bearer ${token}`],
        ["x-request-id", "download-trace"],
    ]);
    assertEquals(inner.body, null);
    assertPrivate(response);
    assertEquals(
        response.headers.get("content-disposition"),
        'attachment; filename="heimdall-request.json"',
    );
    assertEquals((await response.text()).includes(token), false);
});

Deno.test("journal download retains explicit bearer access without forwarding arbitrary caller headers", async () => {
    const calls: Request[] = [];
    const app = harness((request) => {
        calls.push(request);
        return Response.json({ request: {}, frames: [] });
    });
    const denied = await app.request(`${origin}${downloadPath}?id=one`, {
        headers: { authorization: "Bearer wrong-token" },
    });
    assertEquals(denied.status, 401);
    await denied.body?.cancel();
    assertEquals(calls.length, 0);
    const response = await app.request(`${origin}${downloadPath}?id=one`, {
        headers: {
            authorization: `Bearer ${token}`,
            "sec-fetch-dest": "empty",
        },
    });
    assertEquals(response.status, 200);
    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.headers.get("authorization"), `Bearer ${token}`);
    assertEquals(calls[0]!.headers.get("cookie"), null);
    assertPrivate(response);
    await response.body?.cancel();
});

Deno.test("journal download rejects cross-origin access, ambiguous queries and caller-selected targets", async () => {
    let invoked = 0;
    const app = harness(() => {
        invoked++;
        return Response.json({});
    });
    const cookie = await loginCookie(app);
    const blocked: Record<string, string>[] = [
        { origin: "https://attacker.example.test" },
        { origin: "null" },
        { origin, "sec-fetch-site": "cross-site" },
        { origin, "sec-fetch-site": "same-site" },
    ];
    for (const headers of blocked) {
        const response = await app.request(`${origin}${downloadPath}?id=one`, {
            headers: { cookie, ...headers },
        });
        assertEquals(response.status, 403);
        assertEquals((await response.json()).error.code, "cross_origin");
        assertPrivate(response);
    }
    for (
        const query of [
            "",
            "?id=",
            "?id=one&id=two",
            "?id=one&url=https://attacker.example.test",
            "?id=one&path=/api/admin/settings",
            "?id=one&method=DELETE",
            "?ID=one",
            "?id=%20one",
            "?id=one%0D%0Ainjected",
            "?id=one%00",
            "?id=one%7f",
            "?id=..%2Fsettings",
            "?id=..%5csettings",
            `?id=${"a".repeat(201)}`,
        ]
    ) {
        const response = await app.request(`${origin}${downloadPath}${query}`, {
            headers: { cookie },
        });
        assertEquals(response.status, 400, query);
        assertPrivate(response);
        await response.body?.cancel();
    }
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
        const response = await app.request(`${origin}${downloadPath}?id=one`, {
            method,
            headers: { cookie },
        });
        assertEquals(response.status, 405);
        assertEquals(response.headers.get("allow"), "GET");
        await response.body?.cancel();
    }
    assertEquals(invoked, 0);
});

Deno.test("journal download rejects embedded requests even with a same-origin cookie", async () => {
    let reads = 0;
    const app = harness(() => {
        reads++;
        return Response.json({ request: {}, frames: [] });
    });
    const cookie = await loginCookie(app);
    for (
        const destination of ["iframe", "frame", "image", "script", "object"]
    ) {
        const response = await app.request(`${origin}${downloadPath}?id=one`, {
            headers: {
                cookie,
                "sec-fetch-site": "same-origin",
                "sec-fetch-dest": destination,
            },
        });
        assertEquals(response.status, 403);
        assertEquals((await response.json()).error.code, "invalid_destination");
    }
    assertEquals(reads, 0);
});

Deno.test("journal download carries request abort and consumer cancellation to the exporter", async () => {
    let dispatched: Request | undefined;
    let cancelReason: unknown;
    const app = harness((request) => {
        dispatched = request;
        return new Response(
            new ReadableStream<Uint8Array>({
                cancel(reason) {
                    cancelReason = reason;
                },
            }, { highWaterMark: 0 }),
            {
                headers: { "content-type": "application/json" },
            },
        );
    });
    const cookie = await loginCookie(app);
    const controller = new AbortController();
    const response = await app.request(`${origin}${downloadPath}?id=one`, {
        headers: { cookie },
        signal: controller.signal,
    });
    assertEquals(dispatched?.signal.aborted, false);
    controller.abort("download aborted");
    assertEquals(dispatched?.signal.aborted, true);
    assertEquals(dispatched?.signal.reason, "download aborted");
    await response.body?.cancel("download closed");
    assertEquals(cancelReason, "download closed");
});

Deno.test("journal download keeps structured service errors and owns the outer request ID", async () => {
    const app = harness(() =>
        Response.json({
            error: {
                code: "not_found",
                message: "request not found",
                request_id: "nested-request-id",
            },
            debug: token,
        }, {
            status: 404,
            headers: {
                "set-cookie": `credential=${token}`,
                location: "https://attacker.example.test",
            },
        })
    );
    const cookie = await loginCookie(app);
    const response = await app.request(`${origin}${downloadPath}?id=missing`, {
        headers: { cookie, "x-request-id": "outer-request-id" },
    });
    assertEquals(response.status, 404);
    assertPrivate(response);
    assertEquals(response.headers.get("content-disposition"), null);
    assertEquals(await response.json(), {
        error: {
            code: "not_found",
            message: "request not found",
            request_id: "outer-request-id",
        },
    });
});

Deno.test("journal download never follows redirects or exposes malformed upstream errors", async () => {
    for (
        const respond of [
            () => Response.redirect("https://attacker.example.test", 302),
            () => new Response("<html>not JSON</html>"),
            () => new Response("", { status: 206 }),
            () => new Response(null, { status: 204 }),
            () => new Response("invalid JSON", { status: 503 }),
            () => Response.json({ error: {} }, { status: 500 }),
            () =>
                Response.json({
                    error: { code: "oversized", message: "x".repeat(65_537) },
                }, { status: 500 }),
            () => {
                throw new Error(token);
            },
        ]
    ) {
        const app = harness(respond);
        const cookie = await loginCookie(app);
        const response = await app.request(`${origin}${downloadPath}?id=one`, {
            headers: { cookie },
        });
        assertEquals(response.status, 502);
        assertPrivate(response);
        assertEquals((await response.text()).includes(token), false);
    }
});

Deno.test("journal download cancels oversized error bodies without starting a read", async () => {
    let cancelled = false;
    let pulled = false;
    const app = harness(() =>
        new Response(
            new ReadableStream<Uint8Array>({
                pull() {
                    pulled = true;
                },
                cancel() {
                    cancelled = true;
                },
            }, { highWaterMark: 0 }),
            {
                status: 500,
                headers: { "content-length": "1000000" },
            },
        )
    );
    const cookie = await loginCookie(app);
    const response = await app.request(`${origin}${downloadPath}?id=one`, {
        headers: { cookie },
    });
    assertEquals(response.status, 502);
    assertEquals(cancelled, true);
    assertEquals(pulled, false);
    await response.body?.cancel();
});

Deno.test("journal download does not turn an interrupted export into a successful partial JSON file", async () => {
    const app = harness(() =>
        new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"frames":['));
                },
                pull(controller) {
                    controller.error(new Error("export interrupted"));
                },
            }, { highWaterMark: 0 }),
            {
                headers: { "content-type": "application/json" },
            },
        )
    );
    const cookie = await loginCookie(app);
    const response = await app.request(`${origin}${downloadPath}?id=one`, {
        headers: { cookie },
    });
    assertEquals(response.status, 200);
    await assertRejects(() => response.text(), Error, "export interrupted");
});
