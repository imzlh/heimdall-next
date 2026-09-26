import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { SourceProxySelection } from "@heimdall/admin-contracts/proxies.ts";
import {
    AuthorizationError,
    exchangeAuthorization,
    startAuthorization,
    validateAuthorizationCallback,
} from "../../plugins/chathub-preset/browser-auth.ts";

const state = "test-session-state";
const authUrl =
    `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=${state}`;
const callback =
    `https://login.microsoftonline.com/common/oauth2/nativeclient?code=private-code&state=${state}`;
const tokens = {
    ok: true,
    oid: "account-id",
    tid: "tenant-id",
    accessToken: "private-access-token",
    refreshToken: "private-refresh-token",
    email: "operator@example.test",
    expiresAt: "2026-09-25T18:00:00Z",
};

Deno.test("ChatHub authorization uses only the cookie management bridge and exact plugin route", async () => {
    const requests: Array<{ input: unknown; init: RequestInit }> = [];
    const transport: typeof fetch = (input, init) => {
        requests.push({ input, init: init! });
        return Promise.resolve(
            Response.json(
                requests.length === 1 ? { ok: true, authUrl, state } : tokens,
            ),
        );
    };
    const signal = new AbortController().signal;
    const session = await startAuthorization(signal, transport);
    const account = await exchangeAuthorization(
        session,
        callback,
        signal,
        transport,
    );
    assertEquals(account.accessToken, tokens.accessToken);
    assertEquals(requests.map((request) => request.input), [
        "/admin/ui/request",
        "/admin/ui/request",
    ]);
    for (const request of requests) {
        assertEquals(request.init.method, "POST");
        assertEquals(request.init.credentials, "same-origin");
        assertEquals(request.init.cache, "no-store");
        assertEquals(request.init.redirect, "error");
        assertEquals(request.init.signal, signal);
        assertEquals(
            new Headers(request.init.headers).has("authorization"),
            false,
        );
    }
    assertEquals(JSON.parse(String(requests[0]!.init.body)), {
        path: "/api/admin/plugins/chathub/auth",
        method: "POST",
        body: { action: "start" },
    });
    assertEquals(JSON.parse(String(requests[1]!.init.body)), {
        path: "/api/admin/plugins/chathub/auth",
        method: "POST",
        body: { action: "exchange", state, callback },
    });
});

Deno.test("ChatHub authorization forwards the selected proxy for both PKCE requests without credentials", async (test) => {
    for (
        const selection of [
            { mode: "inherit" },
            { mode: "direct" },
            { mode: "proxy", proxyId: "office-proxy" },
        ] satisfies SourceProxySelection[]
    ) {
        await test.step(selection.mode, async () => {
            const requests: unknown[] = [];
            const transport: typeof fetch = (_input, init) => {
                requests.push(JSON.parse(String(init!.body)));
                return Promise.resolve(
                    Response.json(
                        requests.length === 1
                            ? { ok: true, authUrl, state }
                            : tokens,
                    ),
                );
            };
            const signal = new AbortController().signal;
            // Only the host selection is projected, even if an internal caller
            // accidentally carries transport configuration alongside it.
            const input = {
                ...selection,
                url: "https://private-proxy.example",
                basicAuth: {
                    username: "private-user",
                    password: "private-pass",
                },
            };
            const session = await startAuthorization(signal, transport, input);
            await exchangeAuthorization(
                session,
                callback,
                signal,
                transport,
                input,
            );
            assertEquals(requests, [
                {
                    path: "/api/admin/plugins/chathub/auth",
                    method: "POST",
                    body: { action: "start", proxy: selection },
                },
                {
                    path: "/api/admin/plugins/chathub/auth",
                    method: "POST",
                    body: {
                        action: "exchange",
                        state,
                        callback,
                        proxy: selection,
                    },
                },
            ]);
            assertEquals(input.basicAuth.password, "private-pass");
        });
    }
});

Deno.test("ChatHub validates callback origin, path and state without consuming an exchange", async () => {
    let calls = 0;
    const transport: typeof fetch = () => {
        calls++;
        return Promise.resolve(Response.json(tokens));
    };
    assertEquals(
        validateAuthorizationCallback(` ${callback} `, state),
        callback,
    );
    for (
        const value of [
            "",
            "private-code",
            callback.replace("login.microsoftonline.com", "evil.example"),
            callback.replace("nativeclient", "other"),
            callback.replace(state, "stale-state"),
            callback.replace("?code=private-code&", "?"),
            callback + "#fragment",
        ]
    ) {
        assertThrows(
            () => validateAuthorizationCallback(value, state),
            AuthorizationError,
        );
        await assertRejects(
            () =>
                exchangeAuthorization(
                    { authUrl, state },
                    value,
                    new AbortController().signal,
                    transport,
                ),
            AuthorizationError,
        );
    }
    assertEquals(calls, 0);
});

Deno.test("ChatHub rejects an unexpected login link and malformed credentials", async () => {
    for (
        const url of [
            "javascript:alert(1)",
            authUrl.replace("login.microsoftonline.com", "evil.example"),
            authUrl.replace("authorize", "token"),
            authUrl.replace(state, "another-session"),
            authUrl + "#fragment",
        ]
    ) {
        await assertRejects(
            () =>
                startAuthorization(
                    new AbortController().signal,
                    () =>
                        Promise.resolve(
                            Response.json({ ok: true, authUrl: url, state }),
                        ),
                ),
            AuthorizationError,
        );
    }
    for (
        const result of [
            { ...tokens, accessToken: "" },
            { ...tokens, expiresAt: "yesterday" },
            { ...tokens, oid: {} },
            { ...tokens, refreshToken: null },
        ]
    ) {
        await assertRejects(
            () =>
                exchangeAuthorization(
                    { authUrl, state },
                    callback,
                    new AbortController().signal,
                    () => Promise.resolve(Response.json(result)),
                ),
            AuthorizationError,
        );
    }
});

Deno.test("ChatHub authorization errors never display response secrets or callback values", async () => {
    for (const status of [400, 401, 403, 404, 500]) {
        const error = await assertRejects(
            () =>
                startAuthorization(
                    new AbortController().signal,
                    () =>
                        Promise.resolve(
                            Response.json({
                                error: "private-access-token",
                                callback,
                            }, { status }),
                        ),
                ),
            AuthorizationError,
        );
        assert(!error.message.includes("private-"));
    }
    const error = await assertRejects(
        () =>
            startAuthorization(
                new AbortController().signal,
                () => Promise.reject(new Error("private-fetch-detail")),
            ),
        AuthorizationError,
    );
    assert(!error.message.includes("private-"));
});
