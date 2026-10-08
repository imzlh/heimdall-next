import { assert, assertEquals, assertFalse } from "@std/assert";
import { UI_LIMITS } from "@heimdall/admin-contracts/ui.ts";
import { loadConsoleSnapshot } from "@heimdall/core/web/server/snapshot.ts";

Deno.test("SSR preserves health policy overrides, effective defaults and repair identity without forwarding malformed policy", async () => {
    const snapshot = await loadConsoleSnapshot({
        authorized: true,
        dispatch(request) {
            return Response.json(
                new URL(request.url).pathname === "/api/admin/status"
                    ? {
                        sources: [
                            {
                                id: "custom",
                                healthPolicy: { cooldownMs: 0 },
                                effectiveHealthPolicy: {
                                    cooldownMs: 0,
                                    authCooldownMs: 65000,
                                },
                            },
                            {
                                id: "inherit",
                                healthPolicy: null,
                                effectiveHealthPolicy: {
                                    cooldownMs: 2500,
                                    authCooldownMs: 30000,
                                },
                            },
                            {
                                id: "broken",
                                healthPolicy: {
                                    cooldownMs: -1,
                                    credential: "policy-secret",
                                },
                                effectiveHealthPolicy: {
                                    cooldownMs: "oops",
                                    authCooldownMs: 0,
                                },
                                configurationError: "健康策略损坏",
                                configurationErrorField: "healthPolicy",
                            },
                        ],
                    }
                    : {},
            );
        },
    });
    const [custom, inherited, broken] = snapshot.dashboard.status.sources;
    assertEquals(custom?.healthPolicy, { cooldownMs: 0 });
    assertEquals(custom?.effectiveHealthPolicy, {
        cooldownMs: 0,
        authCooldownMs: 65000,
    });
    assertEquals(inherited?.healthPolicy, null);
    assertEquals(inherited?.effectiveHealthPolicy, {
        cooldownMs: 2500,
        authCooldownMs: 30000,
    });
    assertEquals(broken?.healthPolicy, undefined);
    assertEquals(broken?.effectiveHealthPolicy, undefined);
    assertEquals(broken?.configurationErrorField, "healthPolicy");
    assertFalse(JSON.stringify(snapshot).includes("policy-secret"));
});

Deno.test("unauthenticated SSR only reads public health and supplies a tokenless empty dashboard", async () => {
    const requested: string[] = [];
    const snapshot = await loadConsoleSnapshot({
        adminAuthToken: "private-admin-token",
        authorized: false,
        dispatch(request) {
            requested.push(new URL(request.url).pathname);
            assertEquals(request.headers.get("authorization"), null);
            return Response.json({ status: "ok" });
        },
    });
    assertEquals(requested, ["/health"]);
    assertEquals(snapshot.dashboard.health.status, "ok");
    assertEquals(snapshot.dashboard.authRequired, true);
    assertEquals(snapshot.dashboard.models, []);
    assertEquals(snapshot.dashboard.status, {
        sources: [],
        plugins: [],
        managed: [],
        presets: [],
    });
    assertEquals(snapshot.settings, null);
    assertFalse(JSON.stringify(snapshot).includes("private-admin-token"));
});

Deno.test("SSR reads independent resources with server bearer and preserves partial failures", async () => {
    const paths: string[] = [];
    const snapshot = await loadConsoleSnapshot({
        authorized: true,
        adminAuthToken: "server-only-token",
        origin: "https://console.example",
        dispatch(request) {
            const url = new URL(request.url);
            paths.push(url.pathname);
            assertEquals(url.origin, "https://console.example");
            assertEquals(request.method, "GET");
            assertEquals(
                request.headers.get("authorization"),
                url.pathname === "/health" ? null : "Bearer server-only-token",
            );
            switch (url.pathname) {
                case "/health":
                    return Response.json({ status: "ok" });
                case "/api/admin/models":
                    return Response.json({
                        data: [{ id: "claude", owned_by: "anthropic" }],
                    });
                case "/api/admin/status":
                    return Response.json({
                        sources: [{
                            id: "source-a",
                            name: "Production source",
                            priority: 10,
                            sourcePluginId: "source.openai",
                            enabled: true,
                            health: "ready",
                        }],
                        plugins: [{
                            id: "source-a",
                            kind: "source",
                            name: "测试渠道",
                        }],
                        presets: [{
                            id: "preset-a",
                            sourcePluginId: "source-a",
                        }],
                    });
                case "/api/admin/requests":
                    assertEquals(url.searchParams.get("limit"), "20");
                    return Response.json({
                        error: { message: "internal secret failure" },
                    }, {
                        status: 503,
                        headers: { "x-heimdall-request-id": "request-123" },
                    });
                case "/api/admin/usage":
                    return Response.json({
                        usage: { totalTokens: 1234 },
                        days: [{
                            day: "2026-09-24",
                            requestCount: 3,
                            totalTokens: 1234,
                        }],
                    });
                case "/api/admin/settings":
                    return Response.json({
                        settings: {
                            proxyKeyConfigured: true,
                            limitPerMinute: 25,
                            probeIntervalMs: 60000,
                        },
                    }, { headers: { etag: "version-1" } });
                default:
                    throw new Error("unexpected path");
            }
        },
    });
    assertEquals(paths.length, 9);
    assertEquals(snapshot.dashboard.models[0]?.id, "claude");
    assertEquals(
        snapshot.dashboard.status.sources[0]?.name,
        "Production source",
    );
    assertEquals(snapshot.dashboard.status.sources[0]?.priority, 10);
    assertEquals(
        snapshot.dashboard.status.sources[0]?.sourcePluginId,
        "source.openai",
    );
    assertEquals(snapshot.dashboard.status.sources[0]?.health, "ready");
    assertEquals(snapshot.dashboard.status.presets[0]?.id, "preset-a");
    assertFalse(snapshot.dashboard.authRequired);
    assertEquals(snapshot.requests, []);
    assert(snapshot.errors.requests.includes("503"));
    assert(snapshot.errors.requests.includes("request-123"));
    assertFalse(snapshot.errors.requests.includes("internal secret"));
    assertEquals(snapshot.usage.usage?.totalTokens, 1234);
    assertEquals(snapshot.settings?.etag, "version-1");
    assertEquals(snapshot.settings?.settings.limitPerMinute, 25);
});

Deno.test("SSR projection drops payloads and credentials and redacts the configured token from diagnostics", async () => {
    const snapshot = await loadConsoleSnapshot({
        authorized: true,
        adminAuthToken: "ADMIN-SECRET",
        dispatch(request) {
            const path = new URL(request.url).pathname;
            const payloads: Record<string, unknown> = {
                "/health": { status: "ok", token: "ADMIN-SECRET" },
                "/api/admin/models": {
                    data: [{ id: "model-a", apiKey: "RAW-KEY" }],
                },
                "/api/admin/status": {
                    sources: [{
                        id: "source-a",
                        name: "Source ADMIN-SECRET",
                        priority: 10,
                        sourcePluginId: "plugin-ADMIN-SECRET",
                        config: { apiKey: "RAW-KEY" },
                        apiKey: "RAW-KEY",
                        models: ["model-a", { apiKey: "RAW-KEY" }],
                    }],
                    plugins: [{
                        id: "plugin-a",
                        lastError: "bad ADMIN-SECRET",
                        secrets: "RAW-KEY",
                    }],
                    presets: [{ id: "preset-a", config: { key: "RAW-KEY" } }],
                    managed: [{ apiKey: "RAW-KEY" }],
                },
                "/api/admin/requests": {
                    requests: [{
                        requestId: "request-a",
                        model: "model-a",
                        request: { apiKey: "RAW-KEY" },
                        response: "private response",
                    }],
                },
                "/api/admin/usage": {
                    usage: { totalTokens: 50, apiKey: "RAW-KEY" },
                    days: [{
                        day: "2026-09-24",
                        requestCount: 1,
                        totalTokens: 50,
                        raw: "RAW-KEY",
                    }],
                },
                "/api/admin/settings": {
                    settings: {
                        proxyKeyConfigured: true,
                        proxyKey: "RAW-KEY",
                        limitPerMinute: 10,
                        probeIntervalMs: 10000,
                        adminToken: "ADMIN-SECRET",
                    },
                },
            };
            return Response.json(payloads[path]);
        },
    });
    const boot = JSON.stringify(snapshot);
    assertFalse(boot.includes("ADMIN-SECRET"));
    assertFalse(boot.includes("RAW-KEY"));
    assertFalse(boot.includes("private response"));
    assertEquals(
        snapshot.dashboard.status.plugins[0]?.lastError,
        "bad [已隐藏]",
    );
    assertEquals(snapshot.dashboard.status.sources[0]?.models, ["model-a"]);
    const source = snapshot.dashboard.status.sources[0]!;
    assertEquals(source.name, "Source [已隐藏]");
    assertEquals(source.priority, 10);
    assertEquals(source.sourcePluginId, "plugin-[已隐藏]");
    assertFalse(Object.hasOwn(source, "config"));
    assertFalse(Object.hasOwn(source, "apiKey"));
    assertEquals(snapshot.requests[0]?.model, "model-a");
});

Deno.test("SSR source metadata accepts only strings and safe integer priorities", async () => {
    const priorities: unknown[] = [
        Number.MIN_SAFE_INTEGER,
        0,
        Number.MAX_SAFE_INTEGER,
        1.5,
        Number.MIN_SAFE_INTEGER - 1,
        Number.MAX_SAFE_INTEGER + 1,
        "10",
        null,
        true,
    ];
    const snapshot = await loadConsoleSnapshot({
        authorized: true,
        dispatch(request) {
            return Response.json(
                new URL(request.url).pathname === "/api/admin/status"
                    ? {
                        sources: priorities.map((priority, index) => ({
                            id: `source-${index}`,
                            name: { apiKey: "PRIVATE-CONFIG" },
                            priority,
                            sourcePluginId: 123,
                        })),
                    }
                    : {},
            );
        },
    });
    assertEquals(
        snapshot.dashboard.status.sources.map((source) => source.priority),
        [
            Number.MIN_SAFE_INTEGER,
            0,
            Number.MAX_SAFE_INTEGER,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
        ],
    );
    for (const source of snapshot.dashboard.status.sources) {
        assertEquals(source.name, undefined);
        assertEquals(source.sourcePluginId, undefined);
    }
    assertFalse(JSON.stringify(snapshot).includes("PRIVATE-CONFIG"));
});

Deno.test("SSR preserves ordered middleware overrides, empty chains and global inheritance", async () => {
    const snapshot = await loadConsoleSnapshot({
        authorized: true,
        includeActivity: false,
        dispatch(request) {
            return Response.json(
                new URL(request.url).pathname === "/api/admin/status"
                    ? {
                        sources: [
                            {
                                id: "ordered",
                                middleware: [
                                    "middleware.second",
                                    "middleware.first",
                                ],
                            },
                            { id: "empty", middleware: [] },
                            { id: "inherited", middleware: null },
                            { id: "legacy" },
                        ],
                    }
                    : {},
            );
        },
    });
    assertEquals(
        snapshot.dashboard.status.sources.map((source) => source.middleware),
        [
            ["middleware.second", "middleware.first"],
            [],
            null,
            undefined,
        ],
    );
    assertFalse(
        Object.hasOwn(snapshot.dashboard.status.sources[3]!, "middleware"),
    );
});

Deno.test("SSR marks expired authorization while keeping the public health visible", async () => {
    const snapshot = await loadConsoleSnapshot({
        authorized: true,
        dispatch(request) {
            return new URL(request.url).pathname === "/health"
                ? Response.json({ status: "ok" })
                : Response.json({ error: "unauthorized" }, { status: 401 });
        },
    });
    assertEquals(snapshot.dashboard.health.status, "ok");
    assertEquals(snapshot.dashboard.authRequired, true);
    assert(snapshot.dashboard.errors.models.includes("401"));
    assert(snapshot.errors.settings.includes("401"));
});

Deno.test("SSR transports generic plugin JSON, redacts admin secrets recursively and isolates invalid source UI", async () => {
    const ui = {
        status: { count: 17, text: "prefix ADMIN-SECRET suffix" },
        "ADMIN-SECRET-field": [null, true, { note: "ADMIN-SECRET" }],
        source: { state: "plugin-owned nested value" },
    };
    const invalid = [
        null,
        [],
        "text",
        42,
        JSON.parse('{"constructor":{"unsafe":true}}'),
        { text: "x".repeat(UI_LIMITS.jsonBytes) },
        { entries: Array(129).fill(0) },
    ];
    const snapshot = await loadConsoleSnapshot({
        authorized: true,
        adminAuthToken: "ADMIN-SECRET",
        dispatch(request) {
            return Response.json(
                new URL(request.url).pathname === "/api/admin/status"
                    ? {
                        sources: [
                            { id: "current", enabled: true, ui },
                            { id: "empty", ui: {} },
                            ...invalid.map((value, index) => ({
                                id: `invalid-${index}`,
                                enabled: true,
                                models: ["model-a"],
                                ui: value,
                            })),
                        ],
                    }
                    : {},
            );
        },
    });
    const sources = snapshot.dashboard.status.sources;
    assertEquals(sources[0]?.ui, {
        status: { count: 17, text: "prefix [已隐藏] suffix" },
        "[已隐藏]-field": [null, true, { note: "[已隐藏]" }],
        source: { state: "plugin-owned nested value" },
    });
    assertEquals(sources[1]?.ui, {});
    assertFalse(JSON.stringify(snapshot).includes("ADMIN-SECRET"));
    assertEquals(ui.status.text, "prefix ADMIN-SECRET suffix");
    assertEquals(sources.length, invalid.length + 2);
    for (const source of sources.slice(2)) {
        assertEquals(source.enabled, true);
        assertEquals(source.models, ["model-a"]);
        assertFalse(Object.hasOwn(source, "ui"));
    }
});
