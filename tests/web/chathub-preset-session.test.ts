import { assert, assertEquals, assertExists } from "@std/assert";
import { loadBuiltinComposition } from "@heimdall/core/composition/builtins.ts";
import { createServerApp } from "@heimdall/core/http/app.ts";
import { apiPluginTarget } from "@heimdall/core/http/manifest-routes.ts";
import { Hono } from "hono";
import { createUiBridge } from "@heimdall/core/web/server/bridge.ts";
import { createWebSession } from "@heimdall/core/web/server/session.ts";

const origin = "https://operator.example.test";
const adminAuthToken = "fixture-private-admin-token";
const authPath = "/api/admin/plugins/chathub/auth";

Deno.test("ChatHub preset authorizes through the session bridge and creates a redacted channel", async () => {
    await using resources = new AsyncDisposableStack();
    const builtins = await loadBuiltinComposition({ env: () => undefined });
    resources.defer(() => builtins.close());
    const app = createServerApp({
        adminAuthToken,
        adminCatalog: builtins.catalog,
        adminManagement: builtins.management,
        adminManifestTargets: builtins.apis.map(apiPluginTarget),
    });
    const login = await app.request(`${origin}/admin/session`, {
        method: "POST",
        headers: { origin },
        body: new URLSearchParams({ token: adminAuthToken }),
    });
    assertEquals(login.status, 303);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    async function bridge(
        path: string,
        body?: unknown,
        includeCookie = true,
        requestOrigin = origin,
    ) {
        return await app.request(`${origin}/admin/ui/request`, {
            method: "POST",
            headers: {
                origin: requestOrigin,
                "content-type": "application/json",
                ...(includeCookie ? { cookie } : {}),
            },
            body: JSON.stringify({ path, method: "POST", body }),
        });
    }
    const denied = await bridge(authPath, { action: "start" }, false);
    assertEquals(denied.status, 401);
    await denied.body?.cancel();
    const crossOrigin = await bridge(
        authPath,
        { action: "start" },
        true,
        "https://other.example.test",
    );
    assertEquals(crossOrigin.status, 403);
    await crossOrigin.body?.cancel();
    const direct = await app.request(`${origin}${authPath}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ action: "start" }),
    });
    assertEquals(direct.status, 401);
    await direct.body?.cancel();
    const start = await bridge(authPath, { action: "start" });
    assertEquals(start.status, 200);
    assertEquals(start.headers.get("cache-control"), "no-store");
    const started = await start.json();
    const authorization = new URL(started.authUrl);
    assertEquals(authorization.origin, "https://login.microsoftonline.com");
    assertEquals(authorization.searchParams.get("state"), started.state);
    assertEquals(
        authorization.searchParams.get("code_challenge_method"),
        "S256",
    );
    assertEquals(started.verifier, undefined);
    const accessToken = `fixture.${
        btoa(JSON.stringify({
            oid: "fixture-account",
            tid: "fixture-tenant",
            upn: "operator@example.test",
            exp: Math.floor(Date.now() / 1000) + 3600,
        }))
    }.signature`;
    const fetcher = globalThis.fetch;
    let tokenRequests = 0;
    globalThis.fetch = async (input, init) => {
        tokenRequests++;
        assertEquals(
            String(input),
            "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        );
        assertEquals(new Headers(init?.headers).get("origin"), null);
        const form = new URLSearchParams(String(init?.body));
        assertEquals(form.get("code"), "fixture-authorization-code");
        const verifier = form.get("code_verifier");
        assertExists(verifier);
        const digest = new Uint8Array(
            await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(verifier),
            ),
        );
        const challenge = btoa(String.fromCharCode(...digest)).replaceAll(
            "+",
            "-",
        ).replaceAll("/", "_").replace(/=+$/, "");
        assertEquals(
            challenge,
            authorization.searchParams.get("code_challenge"),
        );
        return Response.json({
            access_token: accessToken,
            refresh_token: "fixture-refresh-token",
            expires_in: 3600,
        });
    };
    resources.defer(() => {
        globalThis.fetch = fetcher;
    });
    const exchangeInput = {
        action: "exchange",
        state: started.state,
        callback:
            `https://login.microsoftonline.com/common/oauth2/nativeclient?code=fixture-authorization-code&state=${started.state}`,
    };
    const exchange = await bridge(authPath, exchangeInput);
    assertEquals(exchange.status, 200);
    const account = await exchange.json();
    assertEquals(account.oid, "fixture-account");
    assertEquals(account.email, "operator@example.test");
    const repeated = await bridge(authPath, exchangeInput);
    assertEquals(repeated.status, 400);
    await repeated.body?.cancel();
    assertEquals(tokenRequests, 1);
    const id = "865e01d6-284f-40a3-8b1d-1ded3732a6d0";
    const config = {
        id,
        oid: account.oid,
        tid: account.tid,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        accountEmail: account.email,
        expiresAt: account.expiresAt,
    };
    const preview = await bridge("/api/admin/preset-preview", {
        presetId: "heimdall.preset.chathub",
        config,
    });
    assertEquals(preview.status, 200);
    const previewBody = await preview.text();
    assert(!previewBody.includes(accessToken));
    assert(!previewBody.includes("fixture-refresh-token"));
    const created = await bridge("/api/admin/sources", {
        id,
        name: "工作账号",
        priority: 8,
        sourcePluginId: "heimdall.source.chathub",
        presetId: "heimdall.preset.chathub",
        config,
    });
    assertEquals(created.status, 201);
    assertExists(created.headers.get("etag"));
    const createdBody = await created.text();
    assert(!createdBody.includes(accessToken));
    assert(!createdBody.includes("fixture-refresh-token"));
    assert(!createdBody.includes(adminAuthToken));
    assertEquals(JSON.parse(createdBody).source.name, "工作账号");
    assertEquals(JSON.parse(createdBody).source.priority, 8);
    assertExists(builtins.sources.get(id));
});

Deno.test("management bridge forwards cancellation to an in-flight provider action", async () => {
    const app = new Hono();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    let providerSignal: AbortSignal | undefined;
    app.post(
        "/admin/ui/request",
        createUiBridge({
            session: createWebSession({}),
            dispatch: async (request) => {
                providerSignal = request.signal;
                entered.resolve();
                await new Promise<void>((resolve) =>
                    request.signal.addEventListener("abort", () => resolve(), {
                        once: true,
                    })
                );
                return Response.json({ ok: false });
            },
        }),
    );
    const response = app.request(`${origin}/admin/ui/request`, {
        method: "POST",
        signal: controller.signal,
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
            path: authPath,
            method: "POST",
            body: { action: "start" },
        }),
    });
    await entered.promise;
    assertEquals(providerSignal?.aborted, false);
    controller.abort();
    await (await response).body?.cancel();
    assertEquals(providerSignal?.aborted, true);
});
