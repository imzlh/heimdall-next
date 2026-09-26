import { assert, assertEquals } from "@std/assert";
import type {
    CreateSourceInput,
    ProxyPoolInput,
    SourceProxySelection,
    UpdateSourceInput,
} from "@heimdall/admin-contracts";
import { loadBuiltinComposition } from "@heimdall/core/composition/builtins.ts";
import { createServerApp, type ServerApp } from "@heimdall/core/http/app.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";

const origin = "https://console.example.test";
const adminToken = "proxy-pool-admin-token";
const prefixes = ["/admin", "/api/admin"] as const;
const privateUsername = "private-proxy-username";
const privatePassword = "private-proxy-password";
const entry = {
    id: "office",
    name: "办公室",
    url: "http://127.0.0.1:8080",
    enabled: true,
};
const pool: ProxyPoolInput = {
    defaultProxyId: entry.id,
    entries: [{
        ...entry,
        basicAuth: { username: privateUsername, password: privatePassword },
    }],
};
const sourceInput: CreateSourceInput = {
    id: "94ba4930-3f05-4f8d-b6c9-9a4ce4973195",
    name: "主渠道",
    priority: 1,
    sourcePluginId: "heimdall.source.openai-compatible",
    config: {
        baseUrl: "https://provider.example.test/v1",
        apiKey: "private-source-key",
    },
};

function request(
    method = "GET",
    body?: unknown,
    version?: string,
): RequestInit {
    const headers = new Headers({
        authorization: `Bearer ${adminToken}`,
        "x-request-id": "proxy-api-request",
    });
    if (version !== undefined) headers.set("if-match", `"${version}"`);
    if (body !== undefined) headers.set("content-type", "application/json");
    return {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
}

async function redactedJson(response: Response) {
    const text = await response.text();
    for (
        const secret of [privateUsername, privatePassword, "private-source-key"]
    ) {
        assertEquals(text.includes(secret), false);
    }
    return JSON.parse(text);
}

async function withComposition(run: (app: ServerApp) => Promise<void>) {
    await using resources = new AsyncDisposableStack();
    const kv = await Deno.openKv(":memory:");
    resources.defer(() => kv.close());
    const composition = await loadBuiltinComposition({
        configStore: new DenoKvConfigStore(kv),
        pluginRoot: new URL("../plugins/", import.meta.url),
        env: () => undefined,
    });
    resources.defer(() => composition.close());
    await run(createServerApp({
        adminAuthToken: adminToken,
        adminCatalog: composition.catalog,
        adminManagement: composition.management,
    }));
}

Deno.test("proxy pool HTTP aliases expose redacted snapshots and reject stale or unversioned writes", async () => {
    await withComposition(async (app) => {
        for (const prefix of prefixes) {
            const initial = await app.request(`${prefix}/proxies`, request());
            assertEquals(initial.status, 200);
            assertEquals(await initial.json(), {
                pool: { defaultProxyId: null, entries: [] },
            });
        }
        const created = await app.request(
            "/admin/proxies",
            request("PUT", pool),
        );
        assertEquals(created.status, 200);
        const firstVersion = created.headers.get("etag");
        assert(firstVersion);
        assertEquals(
            created.headers.get("x-heimdall-request-id"),
            "proxy-api-request",
        );
        const expected = {
            pool: {
                defaultProxyId: entry.id,
                entries: [{
                    ...entry,
                    url: `${entry.url}/`,
                    authConfigured: true,
                }],
            },
        };
        assertEquals(await redactedJson(created), expected);
        for (const prefix of prefixes) {
            const loaded = await app.request(`${prefix}/proxies`, request());
            assertEquals(loaded.headers.get("etag"), firstVersion);
            assertEquals(await redactedJson(loaded), expected);
        }

        const updated = await app.request(
            "/api/admin/proxies",
            request("PUT", {
                defaultProxyId: entry.id,
                entries: [{ ...entry, name: "工作代理" }],
            }, firstVersion),
        );
        assertEquals(updated.status, 200);
        const nextVersion = updated.headers.get("etag");
        assert(nextVersion && nextVersion !== firstVersion);
        const next = await redactedJson(updated);
        assertEquals(next.pool.entries[0].name, "工作代理");
        assertEquals(next.pool.entries[0].authConfigured, true);
        for (const version of [firstVersion, undefined, "*"]) {
            const stale = await app.request(
                "/api/admin/proxies",
                request("PUT", pool, version),
            );
            assertEquals(stale.status, 409);
            assertEquals((await redactedJson(stale)).error.code, "conflict");
        }
        const unchanged = await app.request("/admin/proxies", request());
        assertEquals(unchanged.headers.get("etag"), nextVersion);
        assertEquals(await redactedJson(unchanged), next);
    });
});

Deno.test("proxy pool HTTP validation never echoes credentials or mutates the active pool", async () => {
    await withComposition(async (app) => {
        const invalid = [
            {},
            { ...pool, defaultProxyId: "missing" },
            { ...pool, entries: [{ ...entry, enabled: false }] },
            {
                ...pool,
                entries: [{
                    ...entry,
                    url: `http://${privateUsername}:${privatePassword}@localhost:8080`,
                }],
            },
            {
                ...pool,
                entries: [{
                    ...entry,
                    url: `http://localhost/?password=${privatePassword}`,
                }],
            },
            {
                ...pool,
                entries: [{
                    ...entry,
                    basicAuth: { username: privateUsername, password: 1 },
                }],
            },
            { ...pool, entries: [entry, entry] },
            { ...pool, unknown: privatePassword },
        ];
        for (const body of invalid) {
            const response = await app.request(
                "/api/admin/proxies",
                request("PUT", body),
            );
            assertEquals(response.status, 400);
            assertEquals(
                (await redactedJson(response)).error.code,
                "invalid_config",
            );
        }
        for (const body of [null, [], privatePassword]) {
            const response = await app.request(
                "/admin/proxies",
                request("PUT", body),
            );
            assertEquals(response.status, 400);
            assertEquals(
                (await redactedJson(response)).error.code,
                "invalid_request",
            );
        }
        const malformed = await app.request("/admin/proxies", {
            ...request("PUT"),
            body: `{${privatePassword}`,
        });
        assertEquals(malformed.status, 400);
        assertEquals(
            (await redactedJson(malformed)).error.code,
            "invalid_json",
        );
        const oversized = await app.request(
            "/admin/proxies",
            request("PUT", {
                ...pool,
                excessive: "x".repeat(1_048_576),
            }),
        );
        assertEquals(oversized.status, 413);
        assertEquals(
            (await redactedJson(oversized)).error.code,
            "payload_too_large",
        );
        const untouched = await app.request("/admin/proxies", request());
        assertEquals(await untouched.json(), {
            pool: { defaultProxyId: null, entries: [] },
        });
    });
});

Deno.test("proxy pool management authenticates first, reports unavailable capabilities and sanitizes internal errors", async () => {
    let calls = 0;
    const protectedApp = createServerApp({
        adminAuthToken: adminToken,
        adminManagement: {
            getProxies: () => {
                calls++;
                return { data: {} };
            },
            saveProxies: () => {
                calls++;
                return { data: {} };
            },
        },
    });
    const unavailable = createServerApp({ adminAuthToken: adminToken });
    const broken = createServerApp({
        adminAuthToken: adminToken,
        adminManagement: {
            getProxies: () => {
                throw new Error(privatePassword);
            },
            saveProxies: () => {
                throw new Error(privatePassword);
            },
        },
    });
    for (const prefix of prefixes) {
        for (const method of ["GET", "PUT"]) {
            for (const authorization of [undefined, "Bearer invalid"]) {
                const denied = await protectedApp.request(`${prefix}/proxies`, {
                    method,
                    headers: authorization ? { authorization } : {},
                    ...(method === "PUT"
                        ? { body: `{${privatePassword}` }
                        : {}),
                });
                assertEquals(denied.status, 401);
                assertEquals(
                    (await redactedJson(denied)).error.code,
                    "unauthorized",
                );
            }
            const init = request(method, method === "PUT" ? pool : undefined);
            const absent = await unavailable.request(`${prefix}/proxies`, init);
            assertEquals(absent.status, 501);
            assertEquals(
                (await redactedJson(absent)).error.code,
                "management_unavailable",
            );
            const failed = await broken.request(`${prefix}/proxies`, init);
            assertEquals(failed.status, 500);
            assertEquals(
                (await redactedJson(failed)).error.message,
                "internal server error",
            );
        }
    }
    assertEquals(calls, 0);
});

Deno.test("source proxy POST and PATCH accept the same JSON choices and reject malformed metadata before dispatch", async () => {
    const received: {
        input: CreateSourceInput | UpdateSourceInput;
        version?: string;
    }[] = [];
    const app = createServerApp({
        adminAuthToken: adminToken,
        adminManagement: {
            createSource: (_context, input) => {
                received.push({ input });
                return {
                    data: { source: { id: input.id, proxy: input.proxy } },
                };
            },
            updateSource: (_context, id, input, version) => {
                assertEquals(id, sourceInput.id);
                received.push({ input, version });
                return { data: { source: { id, proxy: input.proxy } } };
            },
        },
    });
    for (
        const proxy of [
            { mode: "inherit" },
            { mode: "direct" },
            { mode: "proxy", proxyId: entry.id },
        ] satisfies SourceProxySelection[]
    ) {
        for (const prefix of prefixes) {
            const created = await app.request(
                `${prefix}/sources`,
                request("POST", { ...sourceInput, proxy }),
            );
            assertEquals(created.status, 201);
            assertEquals(received.at(-1)?.input, { ...sourceInput, proxy });
            assertEquals((await redactedJson(created)).source.proxy, proxy);
            const updated = await app.request(
                `${prefix}/sources?id=${sourceInput.id}`,
                request("PATCH", { proxy }, "source-version"),
            );
            assertEquals(updated.status, 200);
            assertEquals(received.at(-1), {
                input: { proxy },
                version: "source-version",
            });
            assertEquals((await redactedJson(updated)).source.proxy, proxy);
        }
    }
    received.length = 0;
    for (
        const proxy of [
            null,
            [],
            {},
            "direct",
            { mode: "global" },
            { mode: "inherit", proxyId: entry.id },
            { mode: "direct", url: entry.url },
            { mode: "proxy" },
            { mode: "proxy", proxyId: "" },
            { mode: "proxy", proxyId: "../escape" },
            { mode: "proxy", proxyId: "x".repeat(65) },
            { mode: "proxy", proxyId: entry.id, password: privatePassword },
        ]
    ) {
        for (const method of ["POST", "PATCH"]) {
            const path = method === "POST"
                ? "/admin/sources"
                : `/api/admin/sources?id=${sourceInput.id}`;
            const body = method === "POST"
                ? { ...sourceInput, proxy }
                : { proxy };
            const response = await app.request(path, request(method, body));
            assertEquals(response.status, 400);
            assertEquals(
                (await redactedJson(response)).error.code,
                "invalid_request",
            );
        }
    }
    assertEquals(received, []);
});

Deno.test("source proxy HTTP writes persist selections while stale and unavailable choices leave the channel intact", async () => {
    await withComposition(async (app) => {
        const saved = await app.request("/admin/proxies", request("PUT", pool));
        assertEquals(saved.status, 200);
        await saved.body?.cancel();
        const created = await app.request(
            "/api/admin/sources",
            request("POST", sourceInput),
        );
        assertEquals(created.status, 201);
        let version = created.headers.get("etag");
        assert(version);
        const initial = (await redactedJson(created)).source;
        assertEquals(initial.proxy, { mode: "inherit" });
        assertEquals(initial.proxySummary, {
            mode: "proxy",
            selectedBy: "global",
            proxyId: entry.id,
            name: entry.name,
        });
        const path = `/admin/sources?id=${sourceInput.id}`;
        for (
            const proxy of [
                { mode: "direct" },
                { mode: "proxy", proxyId: entry.id },
                { mode: "inherit" },
            ] satisfies SourceProxySelection[]
        ) {
            const staleVersion = version;
            const changed = await app.request(
                path,
                request("PATCH", { proxy }, version),
            );
            assertEquals(changed.status, 200);
            version = changed.headers.get("etag");
            assert(version);
            assertEquals((await redactedJson(changed)).source.proxy, proxy);
            const stale = await app.request(
                path,
                request("PATCH", { proxy: { mode: "direct" } }, staleVersion),
            );
            assertEquals(stale.status, 409);
            assertEquals((await redactedJson(stale)).error.code, "conflict");
            const current = await app.request(path, request());
            assertEquals((await redactedJson(current)).source.proxy, proxy);
        }
        const unavailable = await app.request(
            path,
            request(
                "PATCH",
                { proxy: { mode: "proxy", proxyId: "missing" } },
                version,
            ),
        );
        assertEquals(unavailable.status, 400);
        assertEquals(
            (await redactedJson(unavailable)).error.code,
            "invalid_config",
        );
        const unchanged = await app.request(path, request());
        assertEquals((await redactedJson(unchanged)).source.proxy, {
            mode: "inherit",
        });
    });
});

async function loginCookie(app: ServerApp): Promise<string> {
    const login = await app.request(`${origin}/admin/session`, {
        method: "POST",
        headers: { origin },
        body: new URLSearchParams({ token: adminToken }),
    });
    assertEquals(login.status, 303);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert(cookie);
    await login.body?.cancel();
    return cookie;
}

function bridge(app: ServerApp, cookie: string, envelope: unknown) {
    return app.request(`${origin}/admin/ui/request`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify(envelope),
    });
}

Deno.test("session proxy pool bridge preserves ETag and CAS and returns only redacted no-store responses", async () => {
    await withComposition(async (app) => {
        const cookie = await loginCookie(app);
        const path = "/api/admin/proxies";
        const initial = await bridge(app, cookie, { path, method: "GET" });
        assertEquals(initial.status, 200);
        assertEquals(await initial.json(), {
            pool: { defaultProxyId: null, entries: [] },
        });
        const first = await bridge(app, cookie, {
            path,
            method: "PUT",
            body: pool,
        });
        assertEquals(first.status, 200);
        assertEquals(first.headers.get("cache-control"), "no-store");
        const version = first.headers.get("etag");
        assert(version);
        assertEquals(
            (await redactedJson(first)).pool.entries[0].authConfigured,
            true,
        );
        const cleared = await bridge(app, cookie, {
            path,
            method: "PUT",
            headers: {
                "If-Match": `"${version}"`,
                "x-request-id": "proxy-bridge-write",
            },
            body: { ...pool, entries: [{ ...entry, basicAuth: null }] },
        });
        assertEquals(cleared.status, 200);
        assert(cleared.headers.get("x-heimdall-request-id"));
        assertEquals(
            (await redactedJson(cleared)).pool.entries[0].authConfigured,
            false,
        );
        const stale = await bridge(app, cookie, {
            path,
            method: "PUT",
            headers: { "If-Match": `"${version}"` },
            body: pool,
        });
        assertEquals(stale.status, 409);
        assertEquals((await redactedJson(stale)).error.code, "conflict");
    });
});

Deno.test("session bridge permits only exact proxy pool GET and PUT paths", async () => {
    let reads = 0;
    let writes = 0;
    const app = createServerApp({
        adminAuthToken: adminToken,
        adminManagement: {
            getProxies: () => {
                reads++;
                return { data: { pool: {} } };
            },
            saveProxies: () => {
                writes++;
                return { data: { pool: {} } };
            },
        },
    });
    const cookie = await loginCookie(app);
    for (const method of ["GET", "PUT"]) {
        const allowed = await bridge(app, cookie, {
            path: "/api/admin/proxies",
            method,
            ...(method === "PUT" ? { body: pool } : {}),
        });
        assertEquals(allowed.status, 200);
        await allowed.body?.cancel();
    }
    for (
        const path of [
            "/api/admin/proxies/",
            "/api/admin/proxies/child",
            "/api/admin/proxies/../proxies",
            "/api/admin/proxie%73",
            "/api/admin/%70roxies",
            "/api/admin/proxies%2f",
            "/api/admin/proxies-extra",
        ]
    ) {
        for (const method of ["GET", "PUT"]) {
            const denied = await bridge(app, cookie, { path, method });
            assertEquals(denied.status, 403, `${method} ${path}`);
            assertEquals(
                (await denied.json()).error.code,
                "target_not_allowed",
            );
        }
    }
    for (const method of ["POST", "PATCH", "DELETE", "HEAD", "get", "put"]) {
        const denied = await bridge(app, cookie, {
            path: "/api/admin/proxies",
            method,
        });
        assertEquals(denied.status, 403, method);
        await denied.body?.cancel();
    }
    const withBody = await bridge(app, cookie, {
        path: "/api/admin/proxies",
        method: "GET",
        body: pool,
    });
    assertEquals(withBody.status, 400);
    await withBody.body?.cancel();
    assertEquals({ reads, writes }, { reads: 1, writes: 1 });
});
