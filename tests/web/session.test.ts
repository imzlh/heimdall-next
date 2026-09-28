import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { createServerApp } from "@heimdall/core/http/app.ts";
import {
    type AdminDispatch,
    createUiBridge,
} from "@heimdall/core/web/server/bridge.ts";
import {
    createWebSession,
    type WebSessionOptions,
} from "@heimdall/core/web/server/session.ts";

const origin = "https://console.example.test";
const adminToken = "operator-only-secret";
const blockedOriginHeaders: readonly Record<string, string>[] = [
    { origin: "https://attacker.example.test" },
    { origin: "null" },
    { origin, "sec-fetch-site": "cross-site" },
    { origin, "sec-fetch-site": "same-site" },
];

function createHarness(
    options: WebSessionOptions = { adminAuthToken: adminToken },
    dispatch: AdminDispatch = () => Response.json({ ok: true }),
) {
    const session = createWebSession(options);
    const app = new Hono();
    app.post("/admin/session", (context) => session.login(context));
    app.post("/admin/logout", (context) => session.logout(context));
    app.get(
        "/admin",
        async (context) =>
            context.json({ authorized: await session.authorized(context) }),
    );
    app.post(
        "/admin/ui/request",
        createUiBridge({
            session,
            dispatch,
            adminAuthToken: options.adminAuthToken,
        }),
    );
    return app;
}

function login(app: Hono, token = adminToken, base = origin) {
    return app.request(`${base}/admin/session`, {
        method: "POST",
        headers: { origin: base },
        body: new URLSearchParams({ token }),
    });
}

async function loginCookie(app: Hono): Promise<string> {
    const response = await login(app);
    assertEquals(response.status, 303);
    const header = response.headers.get("set-cookie");
    assert(header !== null);
    return header.split(";")[0]!;
}

async function authorized(app: Hono, headers?: HeadersInit): Promise<boolean> {
    const response = await app.request(`${origin}/admin`, { headers });
    return (await response.json()).authorized;
}

function bridgeRequest(
    app: Pick<Hono, "request">,
    envelope: unknown,
    cookie?: string,
    extraHeaders?: HeadersInit,
) {
    const headers = new Headers(extraHeaders);
    headers.set("content-type", "application/json");
    if (!headers.has("origin")) headers.set("origin", origin);
    if (cookie !== undefined) headers.set("cookie", cookie);
    return app.request(`${origin}/admin/ui/request`, {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
    });
}

Deno.test("web session login issues a scoped private cookie without the bearer token", async () => {
    const app = createHarness();
    assertEquals(await authorized(app), false);
    const response = await login(app);
    assertEquals(response.status, 303);
    assertEquals(response.headers.get("location"), "/admin");
    assertEquals(response.headers.get("cache-control"), "no-store");
    const cookie = response.headers.get("set-cookie");
    assert(cookie !== null);
    for (
        const attribute of [
            "HttpOnly",
            "SameSite=Strict",
            "Path=/admin",
            "Max-Age=28800",
            "Secure",
        ]
    ) {
        assertStringIncludes(cookie, attribute);
    }
    assertEquals(decodeURIComponent(cookie).includes(adminToken), false);
    assertEquals(
        await authorized(app, { cookie: cookie.split(";")[0]! }),
        true,
    );

    const local = await login(app, adminToken, "http://localhost");
    assertEquals(local.status, 303);
    assertEquals(local.headers.get("set-cookie")?.includes("Secure"), false);
});

Deno.test("web session rejects invalid and duplicate credentials without echoing them", async () => {
    const app = createHarness();
    const invalidToken = "<script>bad-token</script>";
    const response = await login(app, invalidToken);
    assertEquals(response.status, 401);
    assertEquals(response.headers.get("set-cookie"), null);
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals((await response.text()).includes(invalidToken), false);
    assertEquals(await authorized(app), false);
    const duplicate = await app.request(`${origin}/admin/session`, {
        method: "POST",
        headers: { origin },
        body: new URLSearchParams([
            ["token", adminToken],
            ["token", "second-token"],
        ]),
    });
    assertEquals(duplicate.status, 400);
    assertEquals(duplicate.headers.get("set-cookie"), null);
});

Deno.test("web session rejects tampered, expired, and differently signed cookies", async () => {
    let now = 1_700_000_000_000;
    const options = {
        adminAuthToken: adminToken,
        signingSecret: "fixture-session-signing-secret",
        now: () => now,
    };
    const app = createHarness(options);
    const cookie = await loginCookie(app);
    const separator = cookie.indexOf("=");
    const tampered = cookie.slice(0, separator + 1) + "tampered" +
        cookie.slice(separator + 1);
    assertEquals(await authorized(app, { cookie: tampered }), false);
    const signatureStart = cookie.lastIndexOf(".") + 1;
    const changedSignature = cookie.slice(0, signatureStart) +
        (cookie[signatureStart] === "A" ? "B" : "A") +
        cookie.slice(signatureStart + 1);
    assertEquals(await authorized(app, { cookie: changedSignature }), false);
    assertEquals(
        await authorized(app, { cookie: `${cookie}; ${cookie}` }),
        false,
    );
    assertEquals(
        await authorized(
            createHarness({ ...options, signingSecret: "a-different-secret" }),
            { cookie },
        ),
        false,
    );
    now += 8 * 60 * 60 * 1000 - 1;
    assertEquals(await authorized(app, { cookie }), true);
    now += 1;
    assertEquals(await authorized(app, { cookie }), false);
});

Deno.test("web session supports bearer access and explicit disabled authentication", async () => {
    const protectedApp = createHarness();
    assertEquals(
        await authorized(protectedApp, {
            authorization: `Bearer ${adminToken}`,
        }),
        true,
    );
    assertEquals(
        await authorized(protectedApp, { authorization: "Bearer wrong" }),
        false,
    );
    assertEquals(await authorized(createHarness({})), true);
    assertEquals(
        await authorized(createHarness({ adminAuthToken: "   " })),
        false,
    );
});

Deno.test("web session accepts non-browser form login and empty tokens when authentication is disabled", async () => {
    const app = createHarness();
    const response = await app.request(`${origin}/admin/session`, {
        method: "POST",
        body: new URLSearchParams({ token: adminToken }),
    });
    assertEquals(response.status, 303);
    const header = response.headers.get("set-cookie");
    assert(header !== null);
    assertEquals(
        await authorized(app, { cookie: header.split(";")[0]! }),
        true,
    );

    const openApp = createHarness({});
    const disabled = await login(openApp, "");
    assertEquals(disabled.status, 303);
    assertEquals(await authorized(openApp), true);
});

Deno.test("web session origin checks cover login and logout", async () => {
    const app = createHarness();
    const cookie = await loginCookie(app);
    for (const path of ["/admin/session", "/admin/logout"]) {
        for (const headers of blockedOriginHeaders) {
            const response = await app.request(`${origin}${path}`, {
                method: "POST",
                headers: { ...headers, cookie },
                body: new URLSearchParams({ token: adminToken }),
            });
            assertEquals(response.status, 403);
            assertEquals(response.headers.get("set-cookie"), null);
        }
    }
    const logout = await app.request(`${origin}/admin/logout`, {
        method: "POST",
        headers: { origin, cookie },
    });
    assertEquals(logout.status, 303);
    assertEquals(logout.headers.get("location"), "/admin");
    const deleted = logout.headers.get("set-cookie");
    assert(deleted !== null);
    assertStringIncludes(deleted, "Max-Age=0");
    assertStringIncludes(deleted, "Path=/admin");
    assertStringIncludes(deleted, "HttpOnly");
    assertEquals(
        await authorized(app, { cookie: deleted.split(";")[0]! }),
        false,
    );
});

Deno.test("UI bridge requires authorization and same-origin browser requests", async () => {
    let dispatched = 0;
    const app = createHarness({ adminAuthToken: adminToken }, () => {
        dispatched++;
        return Response.json({ ok: true });
    });
    const envelope = { path: "/api/admin/settings", method: "GET" };
    const unauthorized = await bridgeRequest(app, envelope);
    assertEquals(unauthorized.status, 401);
    assertEquals((await unauthorized.json()).error.code, "unauthorized");
    const cookie = await loginCookie(app);
    for (const headers of blockedOriginHeaders) {
        const response = await bridgeRequest(app, envelope, cookie, headers);
        assertEquals(response.status, 403);
    }
    assertEquals(dispatched, 0);
    assertEquals((await bridgeRequest(app, envelope, cookie)).status, 200);
    assertEquals(dispatched, 1);
});

Deno.test("UI bridge forwards only configured credentials and safe concurrency headers", async () => {
    let forwarded: Request | undefined;
    const app = createHarness({ adminAuthToken: adminToken }, (request) => {
        forwarded = request;
        return Response.json({ saved: true }, {
            headers: {
                etag: '"version-2"',
                "x-request-id": "request-2",
                "x-heimdall-request-id": "heimdall-2",
                "set-cookie": "backend_secret=private",
                "access-control-allow-origin": "*",
            },
        });
    });
    const cookie = await loginCookie(app);
    const response = await bridgeRequest(
        app,
        {
            path: "/api/admin/settings",
            method: "PUT",
            headers: {
                authorization: "Bearer caller-controlled-token",
                cookie: "caller_controlled=value",
                "If-Match": '"version-1"',
                "X-Request-Id": "envelope-cannot-replace-trace",
                "x-extra": "untrusted",
            },
            body: { limitPerMinute: 15 },
        },
        cookie,
        { "x-request-id": "request-1" },
    );
    assertEquals(response.status, 200);
    assert(forwarded !== undefined);
    assertEquals(forwarded.url, `${origin}/api/admin/settings`);
    assertEquals(forwarded.method, "PUT");
    assertEquals(
        forwarded.headers.get("authorization"),
        `Bearer ${adminToken}`,
    );
    assertEquals(forwarded.headers.get("if-match"), '"version-1"');
    assertEquals(forwarded.headers.get("x-request-id"), "request-1");
    assertEquals(forwarded.headers.get("cookie"), null);
    assertEquals(forwarded.headers.get("x-extra"), null);
    assertEquals(await forwarded.json(), { limitPerMinute: 15 });
    assertEquals(await response.json(), { saved: true });
    assertEquals(response.headers.get("etag"), '"version-2"');
    assertEquals(response.headers.get("x-request-id"), null);
    assertEquals(response.headers.get("x-heimdall-request-id"), "request-1");
    assertEquals(response.headers.get("set-cookie"), null);
    assertEquals(response.headers.get("access-control-allow-origin"), null);
    assertEquals(response.headers.get("cache-control"), "no-store");
});

Deno.test("UI bridge supports core management operations without authentication when disabled", async () => {
    const forwarded: Request[] = [];
    const app = createHarness({}, (request) => {
        forwarded.push(request);
        return Response.json({ ok: true });
    });
    for (
        const envelope of [
            { path: "/api/admin/settings", method: "GET" },
            { path: "/api/admin/sources?id=source.openai", method: "GET" },
            { path: "/api/admin/sources", method: "POST", body: {} },
            {
                path: "/api/admin/sources?id=source.openai",
                method: "PATCH",
                body: { enabled: false },
            },
            { path: "/api/admin/sources?id=source.openai", method: "DELETE" },
            { path: "/api/admin/source-config?sourceId=openai", method: "GET" },
            { path: "/api/admin/source-config", method: "PUT", body: {} },
            {
                path: "/api/admin/source-config/validate",
                method: "POST",
                body: {},
            },
            { path: "/api/admin/source-probe", method: "POST", body: {} },
            { path: "/api/admin/preset-preview", method: "POST", body: {} },
            { path: "/api/admin/preset-apply", method: "POST", body: {} },
            { path: "/api/admin/plugin-state", method: "POST", body: {} },
            { path: "/api/admin/plugin", method: "DELETE", body: {} },
        ]
    ) {
        assertEquals((await bridgeRequest(app, envelope)).status, 200);
        const request = forwarded.at(-1)!;
        assertEquals(request.url, `${origin}${envelope.path}`);
        assertEquals(request.method, envelope.method);
        assertEquals(request.headers.get("authorization"), null);
    }
});

Deno.test("UI bridge forwards authenticated source creation with its JSON body", async () => {
    const forwarded: Request[] = [];
    const app = createHarness({ adminAuthToken: adminToken }, (request) => {
        forwarded.push(request);
        return Response.json({ id: "source-created" }, { status: 201 });
    });
    const body = {
        name: "Production source",
        priority: 10,
        sourcePluginId: "source.openai",
        config: { apiKey: "source-credential" },
    };
    const envelope = { path: "/api/admin/sources", method: "POST", body };
    assertEquals((await bridgeRequest(app, envelope)).status, 401);
    const cookie = await loginCookie(app);
    for (const headers of blockedOriginHeaders) {
        assertEquals(
            (await bridgeRequest(app, envelope, cookie, headers)).status,
            403,
        );
    }
    assertEquals(forwarded.length, 0);

    const response = await bridgeRequest(app, envelope, cookie);
    assertEquals(response.status, 201);
    assertEquals(await response.json(), { id: "source-created" });
    assertEquals(forwarded.length, 1);
    const request = forwarded[0]!;
    assertEquals(request.url, `${origin}/api/admin/sources`);
    assertEquals(request.method, "POST");
    assertEquals(request.headers.get("content-type"), "application/json");
    assertEquals(request.headers.get("authorization"), `Bearer ${adminToken}`);
    assertEquals(await request.json(), body);
});

Deno.test("UI bridge protects channel edits and deletion with same-origin sessions and forwards CAS", async () => {
    const forwarded: Request[] = [];
    const app = createHarness({ adminAuthToken: adminToken }, (request) => {
        forwarded.push(request);
        return Response.json({ saved: true }, { headers: { etag: "v2" } });
    });
    const cookie = await loginCookie(app);
    for (const method of ["PATCH", "DELETE"]) {
        const envelope = {
            path: "/api/admin/sources?id=source.openai",
            method,
            headers: { "If-Match": "v1" },
            ...(method === "PATCH" ? { body: { enabled: false } } : {}),
        };
        assertEquals((await bridgeRequest(app, envelope)).status, 401);
        for (const headers of blockedOriginHeaders) {
            assertEquals(
                (await bridgeRequest(app, envelope, cookie, headers)).status,
                403,
            );
        }
        const response = await bridgeRequest(app, envelope, cookie);
        assertEquals(response.status, 200);
        assertEquals(response.headers.get("etag"), "v2");
        await response.body?.cancel();
        const request = forwarded.at(-1)!;
        assertEquals(
            request.url,
            `${origin}/api/admin/sources?id=source.openai`,
        );
        assertEquals(request.method, method);
        assertEquals(request.headers.get("if-match"), "v1");
        assertEquals(
            request.headers.get("authorization"),
            `Bearer ${adminToken}`,
        );
        if (method === "PATCH") {
            assertEquals(await request.json(), { enabled: false });
        } else assertEquals(request.body, null);
    }
    assertEquals(forwarded.length, 2);
});

Deno.test("UI bridge rejects external, non-core, normalized, and wrong-method targets", async () => {
    let dispatched = 0;
    const app = createHarness({}, () => {
        dispatched++;
        return Response.json({ ok: true });
    });
    for (
        const envelope of [
            {
                path: "https://attacker.example.test/api/admin/settings",
                method: "GET",
            },
            {
                path: "//attacker.example.test/api/admin/settings",
                method: "GET",
            },
            { path: "/api/chat", method: "POST" },
            { path: "/admin/settings", method: "GET" },
            { path: "/admin/sources", method: "POST" },
            { path: "/api/admin/sources/x", method: "POST" },
            { path: "/api/admin/sources/", method: "POST" },
            { path: "/api/admin/sources/../sources", method: "POST" },
            { path: "/api/admin/%73ources", method: "POST" },
            { path: "/api/admin/sources/x", method: "DELETE" },
            { path: "/api/admin/sources/../sources", method: "PATCH" },
            { path: "/api/admin/sources", method: "PUT" },
            { path: "/api/admin/sources", method: "post" },
            { path: "/api/admin/fixture-plugin/dangerous", method: "POST" },
            { path: "/api/admin/plugin/fixture", method: "GET" },
            { path: "/api/admin/../chat", method: "GET" },
            { path: "/api/admin/%2e%2e/chat", method: "GET" },
            { path: "/api/admin/settings#fragment", method: "GET" },
            { path: "/api/admin/settings\\anything", method: "GET" },
            { path: "/api/admin/settings", method: "DELETE" },
            { path: "/api/admin/settings", method: "PATCH" },
            { path: "/api/admin/settings", method: "get" },
            { path: "/api/admin/settings", method: "GET", body: {} },
        ]
    ) {
        const response = await bridgeRequest(app, envelope);
        assert(response.status >= 400 && response.status < 500);
    }
    assertEquals(dispatched, 0);
});

Deno.test("UI bridge rejects malformed or oversized input before dispatch", async () => {
    let dispatched = 0;
    const app = createHarness({}, () => {
        dispatched++;
        return Response.json({ ok: true });
    });
    for (const body of ["{", "null", "[]", '"text"', "{}"]) {
        const response = await app.request(`${origin}/admin/ui/request`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body,
        });
        assertEquals(response.status, 400);
    }
    const wrongType = await app.request(`${origin}/admin/ui/request`, {
        method: "POST",
        headers: { origin, "content-type": "text/plain" },
        body: JSON.stringify({ path: "/api/admin/settings", method: "GET" }),
    });
    assertEquals(wrongType.status, 415);
    const oversized = await bridgeRequest(app, {
        path: "/api/admin/settings",
        method: "PUT",
        body: { proxyKey: "x".repeat(1_048_576) },
    });
    assertEquals(oversized.status, 413);
    const badHeader = await bridgeRequest(app, {
        path: "/api/admin/settings",
        method: "GET",
        headers: { "if-match": "unsafe\r\nheader" },
    });
    assertEquals(badHeader.status, 400);
    assertEquals(dispatched, 0);
});

Deno.test("UI bridge preserves management errors and rejects non-JSON responses", async () => {
    const failed = createHarness(
        {},
        () =>
            Response.json({ error: { code: "conflict" } }, {
                status: 409,
                headers: { etag: '"latest"' },
            }),
    );
    const envelope = { path: "/api/admin/settings", method: "PUT", body: {} };
    const conflict = await bridgeRequest(failed, envelope);
    assertEquals(conflict.status, 409);
    assertEquals(conflict.headers.get("etag"), '"latest"');
    assertEquals(await conflict.json(), {
        error: {
            code: "conflict",
            request_id: conflict.headers.get("x-heimdall-request-id"),
        },
    });
    const invalid = createHarness(
        {},
        () =>
            new Response("<script>unexpected HTML</script>", {
                headers: { "content-type": "text/html" },
            }),
    );
    const response = await bridgeRequest(invalid, envelope);
    assertEquals(response.status, 502);
    assertEquals((await response.json()).error.code, "invalid_response");
});

Deno.test("web cookies never authorize existing management API prefixes", async () => {
    const app = createServerApp({ adminAuthToken: adminToken });
    const response = await app.request(`${origin}/admin/session`, {
        method: "POST",
        headers: { origin },
        body: new URLSearchParams({ token: adminToken }),
    });
    assertEquals(response.status, 303);
    const header = response.headers.get("set-cookie");
    assert(header !== null);
    const cookie = header.split(";")[0]!;
    for (const path of ["/admin/status", "/api/admin/status"]) {
        const cookieOnly = await app.request(`${origin}${path}`, {
            headers: { cookie },
        });
        assertEquals(cookieOnly.status, 401);
        const bearer = await app.request(`${origin}${path}`, {
            headers: { cookie, authorization: `Bearer ${adminToken}` },
        });
        assertEquals(bearer.status, 200);
    }
});

Deno.test("server bridge shares one host trace with nested management failures", async () => {
    const received: { context: string; header: string | null }[] = [];
    const app = createServerApp({
        adminManagement: {
            saveProxies: (context) => {
                received.push({
                    context: context.requestId,
                    header: context.request.headers.get("x-request-id"),
                });
                throw new TypeError("invalid proxy pool configuration");
            },
        },
    });
    for (const requestId of ["outer-http-trace", undefined]) {
        const response = await bridgeRequest(
            app,
            {
                path: "/api/admin/proxies",
                method: "PUT",
                headers: { "x-request-id": "different-envelope-trace" },
                body: {},
            },
            undefined,
            requestId ? { "x-request-id": requestId } : {},
        );
        assertEquals(response.status, 400);
        const trace = response.headers.get("x-heimdall-request-id");
        assert(trace);
        if (requestId !== undefined) assertEquals(trace, requestId);
        assert(trace !== "different-envelope-trace");
        assertEquals(received.at(-1), { context: trace, header: trace });
        assertEquals(await response.json(), {
            error: {
                code: "invalid_config",
                message: "invalid proxy pool configuration",
                request_id: trace,
            },
        });
    }
});

Deno.test("server bridge keeps its trace when plugin responses supply different trace headers and errors", async () => {
    const plugin = new Hono();
    const pluginRequests: string[] = [];
    plugin.get("/proxies", (context) => {
        pluginRequests.push(context.req.header("x-request-id")!);
        return Response.json({
            error: {
                code: "provider_error",
                message: "插件暂时不可用",
                request_id: "plugin-body-trace",
                detail: { retryable: true },
            },
        }, {
            status: 503,
            headers: {
                "x-heimdall-request-id": "plugin-header-trace",
                "x-request-id": "provider-private-trace",
                etag: '"plugin-version"',
            },
        });
    });
    const app = createServerApp({ adminRoutes: plugin });
    const response = await bridgeRequest(
        app,
        {
            path: "/api/admin/proxies",
            method: "GET",
            headers: { "x-request-id": "envelope-trace" },
        },
        undefined,
        { "x-request-id": "host-trace" },
    );
    assertEquals(response.status, 503);
    assertEquals(pluginRequests, ["host-trace"]);
    assertEquals(response.headers.get("x-heimdall-request-id"), "host-trace");
    assertEquals(response.headers.get("x-request-id"), null);
    assertEquals(response.headers.get("etag"), '"plugin-version"');
    assertEquals(await response.json(), {
        error: {
            code: "provider_error",
            message: "插件暂时不可用",
            request_id: "host-trace",
            detail: { retryable: true },
        },
    });
    const direct = await app.request(`${origin}/api/admin/proxies`, {
        headers: { "x-request-id": "direct-host-trace" },
    });
    assertEquals(
        direct.headers.get("x-heimdall-request-id"),
        "direct-host-trace",
    );
    await direct.body?.cancel();
});

Deno.test("server bridge validation, authentication and upstream failures return the outer error trace", async () => {
    const app = createServerApp();
    const cases = [
        { body: "{", headers: {}, status: 400 },
        {
            body: JSON.stringify({
                path: "/api/admin/proxies/",
                method: "GET",
            }),
            headers: {},
            status: 403,
        },
        {
            body: JSON.stringify({ path: "/api/admin/proxies", method: "GET" }),
            headers: { origin: "https://attacker.example.test" },
            status: 403,
        },
    ];
    for (const test of cases) {
        const response = await app.request(`${origin}/admin/ui/request`, {
            method: "POST",
            headers: {
                origin,
                "content-type": "application/json",
                "x-request-id": "validation-trace",
                ...test.headers,
            },
            body: test.body,
        });
        assertEquals(response.status, test.status);
        assertEquals(
            response.headers.get("x-heimdall-request-id"),
            "validation-trace",
        );
        assertEquals(
            (await response.json()).error.request_id,
            "validation-trace",
        );
    }
    const secured = createServerApp({ adminAuthToken: adminToken });
    const denied = await bridgeRequest(
        secured,
        {
            path: "/api/admin/proxies",
            method: "GET",
        },
        undefined,
        { "x-request-id": "unauthorized-trace" },
    );
    assertEquals(denied.status, 401);
    assertEquals(
        denied.headers.get("x-heimdall-request-id"),
        "unauthorized-trace",
    );
    assertEquals((await denied.json()).error.request_id, "unauthorized-trace");

    const malformed = new Hono();
    malformed.get("/proxies", () => new Response("not JSON"));
    const upstream = createServerApp({ adminRoutes: malformed });
    const invalid = await bridgeRequest(
        upstream,
        {
            path: "/api/admin/proxies",
            method: "GET",
        },
        undefined,
        { "x-request-id": "upstream-trace" },
    );
    assertEquals(invalid.status, 502);
    assertEquals(
        invalid.headers.get("x-heimdall-request-id"),
        "upstream-trace",
    );
    assertEquals((await invalid.json()).error.request_id, "upstream-trace");
});

Deno.test("draft probes use the authenticated same-origin UI bridge and preserve the JSON draft", async () => {
    const forwarded: Request[] = [];
    const app = createHarness({ adminAuthToken: adminToken }, (request) => {
        forwarded.push(request);
        return Response.json({ probe: { ok: true, models: ["a"] } });
    });
    const body = {
        id: "e3ea7f49-9726-41a4-97c2-c6f00f51bb75",
        name: "草稿",
        priority: 0,
        sourcePluginId: "heimdall.source.openai-compatible",
        proxy: { mode: "direct" },
        config: { apiKey: "draft-secret" },
    };
    const envelope = {
        path: "/api/admin/source-draft-probe",
        method: "POST",
        body,
    };
    assertEquals((await bridgeRequest(app, envelope)).status, 401);
    const cookie = await loginCookie(app);
    for (const headers of blockedOriginHeaders) {
        assertEquals(
            (await bridgeRequest(app, envelope, cookie, headers)).status,
            403,
        );
    }
    assertEquals(forwarded.length, 0);
    assertEquals((await bridgeRequest(app, envelope, cookie)).status, 200);
    assertEquals(forwarded.length, 1);
    assertEquals(
        forwarded[0]?.headers.get("authorization"),
        `Bearer ${adminToken}`,
    );
    assertEquals(await forwarded[0]?.json(), body);
});
