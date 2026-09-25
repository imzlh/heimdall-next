import {
    AdminApiError,
    clearAdminToken,
    configureAdminTransport,
    createChatConversation,
    createSource,
    getAdminToken,
    loadDashboard,
    loadRuntimeSettings,
    loadUsage,
    probeSource,
    regenerateChat,
    saveRuntimeSettings,
    saveSourceConfig,
    setAdminToken,
    setPluginEnabled,
} from "@heimdall/core/web/client/api/admin.ts";
import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";

Deno.test("admin dashboard loads models with management credentials", async () => {
    const originalFetch = globalThis.fetch;
    const paths: string[] = [];
    setAdminToken("operator-token");
    globalThis.fetch = (input, init) => {
        const path = String(input);
        paths.push(path);
        assertEquals(
            new Headers(init?.headers).get("authorization"),
            "Bearer operator-token",
        );
        return Promise.resolve(Response.json(
            path === "/api/admin/models"
                ? { object: "list", data: [{ id: "chat-model" }] }
                : {},
        ));
    };
    try {
        const dashboard = await loadDashboard();
        assertEquals(dashboard.models, [{ id: "chat-model" }]);
        assertEquals(dashboard.errors.models, "");
        assertEquals(paths.includes("/v1/models"), false);
    } finally {
        globalThis.fetch = originalFetch;
        clearAdminToken();
    }
});

Deno.test("admin client sends bearer and ETag headers for source writes", async () => {
    const originalFetch = globalThis.fetch;
    const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
    globalThis.fetch = (input, init) => {
        calls.push({ input, init });
        return Promise.resolve(
            Response.json(
                { source: "openai-compatible", versionstamp: "v2" },
                { headers: { etag: '"v2"' } },
            ),
        );
    };
    setAdminToken("test-admin-token");
    try {
        const result = await saveSourceConfig(
            "openai-compatible",
            { baseUrl: "https://upstream.example/v1" },
            "v1",
        );
        assertEquals(result.etag, '"v2"');
        assertEquals(getAdminToken(), "test-admin-token");
        assertEquals(calls.length, 1);
        assertEquals(
            calls[0]!.input,
            "/api/admin/source-config?id=openai-compatible",
        );
        const headers = new Headers(calls[0]!.init?.headers);
        assertEquals(headers.get("authorization"), "Bearer test-admin-token");
        assertEquals(headers.get("if-match"), "v1");
        assertEquals(headers.get("content-type"), "application/json");
        assertEquals(
            JSON.parse(String(calls[0]!.init?.body)),
            { config: { baseUrl: "https://upstream.example/v1" } },
        );
    } finally {
        globalThis.fetch = originalFetch;
        clearAdminToken();
    }
});

Deno.test("channel creation posts identity and optional preset through the configured session transport", async () => {
    const calls: { path: string; method?: string; body: unknown }[] = [];
    configureAdminTransport((input, init) => {
        calls.push({
            path: String(input),
            method: init?.method,
            body: JSON.parse(String(init?.body)),
        });
        return Promise.resolve(
            calls.length < 3
                ? Response.json({ source: { sourceId: "new-instance" } }, {
                    status: 201,
                })
                : Response.json({
                    error: { code: "conflict", message: "渠道已存在" },
                }, { status: 409 }),
        );
    });
    const custom = {
        id: "54e8e477-0d39-437a-8854-7ec1a0f31560",
        name: "中文渠道",
        priority: -5,
        sourcePluginId: "heimdall.source.openai-compatible",
        config: {
            baseUrl: "https://upstream.example/v1",
            apiKey: "submitted-secret",
        },
    };
    const preset = {
        ...custom,
        id: "d65a3d50-cbca-466e-a1ab-bd3b96e75341",
        presetId: "heimdall.preset.newapi",
    };
    try {
        await createSource(custom);
        await createSource(preset);
        await assertRejects(
            () => createSource(custom),
            AdminApiError,
            "渠道已存在",
        );
        assertEquals(
            calls,
            [custom, preset, custom].map((body) => ({
                path: "/api/admin/sources",
                method: "POST",
                body,
            })),
        );
    } finally {
        configureAdminTransport();
    }
});

Deno.test("admin dashboard keeps partial resources and model authentication errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
        const path = String(input);
        if (path === "/api/admin/models") {
            return Promise.resolve(Response.json(
                { error: { code: "unauthorized", message: "管理令牌已过期" } },
                {
                    status: 401,
                    headers: { "x-heimdall-request-id": "models-401" },
                },
            ));
        }
        if (path === "/api/admin/status") {
            return Promise.resolve(Response.json({
                sources: [{ id: "openai-compatible", enabled: true }],
            }));
        }
        return Promise.resolve(Response.json(null));
    };
    try {
        const data = await loadDashboard();
        assertEquals(data.authRequired, true);
        assertEquals(data.errors.models, "管理令牌已过期 (models-401)");
        assertEquals(data.status.sources, [{
            id: "openai-compatible",
            enabled: true,
        }]);
        assertEquals(data.health.status, "unavailable");
        assertEquals(data.models, []);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

Deno.test("admin transport can use the web session bridge without changing API requests", async () => {
    const calls: string[] = [];
    configureAdminTransport((input, init) => {
        calls.push(String(input));
        assertEquals(
            new Headers(init?.headers).get("accept"),
            "application/json",
        );
        return Promise.resolve(Response.json({ usage: { totalTokens: 42 } }));
    });
    try {
        assertEquals((await loadUsage()).usage?.totalTokens, 42);
        assertEquals(calls, ["/api/admin/usage"]);
    } finally {
        configureAdminTransport();
    }
});

Deno.test("admin client preserves safe API error fields", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
        Promise.resolve(
            Response.json(
                { error: { code: "conflict", message: "resource changed" } },
                {
                    status: 409,
                    headers: { "x-heimdall-request-id": "request-7" },
                },
            ),
        );
    try {
        let caught: unknown;
        try {
            await saveSourceConfig(
                "openai-compatible",
                { baseUrl: "https://upstream.example/v1" },
                "v1",
            );
        } catch (error) {
            caught = error;
        }
        assertInstanceOf(caught, AdminApiError);
        assertEquals(caught.status, 409);
        assertEquals(caught.code, "conflict");
        assertEquals(caught.requestId, "request-7");
        assertEquals(caught.message, "resource changed");
    } finally {
        globalThis.fetch = originalFetch;
        clearAdminToken();
    }
});

Deno.test("admin client sends explicit plugin lifecycle writes", async () => {
    const originalFetch = globalThis.fetch;
    const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
    globalThis.fetch = (input, init) => {
        calls.push({ input, init });
        return Promise.resolve(Response.json({ plugin: { enabled: false } }));
    };
    try {
        await setPluginEnabled("heimdall.source.openai-compatible", false);
        assertEquals(calls.length, 1);
        assertEquals(calls[0]!.input, "/api/admin/plugin-state");
        assertEquals(
            JSON.parse(String(calls[0]!.init?.body)),
            { pluginId: "heimdall.source.openai-compatible", enabled: false },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

Deno.test("admin client posts source probes to the fixed route", async () => {
    const originalFetch = globalThis.fetch;
    const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
    globalThis.fetch = (input, init) => {
        calls.push({ input, init });
        return Promise.resolve(Response.json({
            probe: {
                sourceId: "openai-compatible",
                ok: false,
                message: "models probe failed with status 503",
                health: "cooldown",
            },
        }));
    };
    try {
        const result = await probeSource("openai-compatible");
        assertEquals(calls.length, 1);
        assertEquals(calls[0]!.input, "/api/admin/source-probe");
        assertEquals(JSON.parse(String(calls[0]!.init?.body)), {
            sourceId: "openai-compatible",
        });
        assertEquals(result.probe.ok, false);
        assertEquals(
            result.probe.message,
            "models probe failed with status 503",
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

Deno.test("admin client writes runtime settings and reads chat ids", async () => {
    const originalFetch = globalThis.fetch;
    const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
    globalThis.fetch = (input, init) => {
        calls.push({ input, init });
        const path = String(input);
        if (path.endsWith("/api/admin/settings") && init?.method === "PUT") {
            return Promise.resolve(Response.json(
                {
                    settings: {
                        proxyKeyConfigured: true,
                        limitPerMinute: 10,
                        probeIntervalMs: 0,
                    },
                },
                { headers: { etag: "v9" } },
            ));
        }
        if (path.endsWith("/api/admin/settings")) {
            return Promise.resolve(Response.json(
                {
                    settings: {
                        proxyKeyConfigured: false,
                        limitPerMinute: 120,
                        probeIntervalMs: 300000,
                    },
                },
                { headers: { etag: "v1" } },
            ));
        }
        return Promise.resolve(Response.json({
            conversation: { id: "conversation-1" },
            messages: [{ role: "assistant", text: "again" }],
        }));
    };
    try {
        const loaded = await loadRuntimeSettings();
        assertEquals(loaded.settings.limitPerMinute, 120);
        assertEquals(loaded.etag, "v1");
        const saved = await saveRuntimeSettings(
            { limitPerMinute: 10, probeIntervalMs: 0, proxyKey: "secret" },
            "v1",
        );
        assertEquals(saved.settings.proxyKeyConfigured, true);
        assertEquals(saved.settings.probeIntervalMs, 0);
        assertEquals(saved.etag, "v9");
        assertEquals(calls.length, 2);
        const headers = new Headers(calls[1]!.init?.headers);
        assertEquals(headers.get("if-match"), "v1");
        assertEquals(JSON.parse(String(calls[1]!.init?.body)), {
            limitPerMinute: 10,
            probeIntervalMs: 0,
            proxyKey: "secret",
        });
        assertEquals(await createChatConversation(), "conversation-1");
        assertEquals(await regenerateChat("conversation-1", "chat-model"), [
            { role: "assistant", text: "again" },
        ]);
    } finally {
        globalThis.fetch = originalFetch;
        clearAdminToken();
    }
});
