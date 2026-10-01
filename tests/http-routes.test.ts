import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { Hono } from "hono";
import type { PluginManifest } from "@heimdall/contracts";
import { createServer, readPort } from "../main.ts";
import { createServerApp, type ServerEnv } from "@heimdall/core/http/app.ts";
import {
    createManifestRoutes,
    ManifestRouteConflictError,
} from "@heimdall/core/http/manifest-routes.ts";
import { createAdminRoutes } from "@heimdall/core/http/admin-routes.ts";
import { createPublicRoutes } from "@heimdall/core/http/public-routes.ts";

const manifest: PluginManifest = {
    id: "fixture.api",
    version: "1.0.0",
    apiVersion: "1",
    name: "Fixture API",
    kind: "api",
    trust: "trusted",
    routes: [{
        method: "GET",
        path: "/items/abc",
        operation: "fixture.item.get",
    }],
};

Deno.test("manifest route adapter uses explicit paths and request context", async () => {
    const app = createManifestRoutes([{
        manifest,
        handle: ({ route, requestId }) =>
            Response.json({
                path: route.path,
                operation: route.operation,
                request_id: requestId,
            }),
    }]);

    const response = await app.request("http://localhost/items/abc", {
        headers: { "x-request-id": "request-1" },
    });
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("x-heimdall-request-id"), "request-1");
    assertEquals(await response.json(), {
        path: "/items/abc",
        operation: "fixture.item.get",
        request_id: "request-1",
    });
});

Deno.test("manifest route adapter strips a mount prefix and rejects conflicts", async () => {
    const mountedManifest: PluginManifest = {
        ...manifest,
        routes: [{
            ...manifest.routes![0]!,
            path: "/v1/items/1",
        }],
    };
    const app = createManifestRoutes([{
        manifest: mountedManifest,
        handle: () => Response.json({ ok: true }),
    }], { stripPrefix: "/v1" });
    assertEquals((await app.request("http://localhost/items/1")).status, 200);

    await assertRejects(
        () =>
            Promise.resolve().then(() =>
                createManifestRoutes([
                    { manifest, handle: () => Response.json({}) },
                    { manifest, handle: () => Response.json({}) },
                ])
            ),
        ManifestRouteConflictError,
    );
});

Deno.test("public and admin route groups expose mountable DTO routes", async () => {
    const publicRoutes = createPublicRoutes();
    const models = await publicRoutes.request("http://localhost/models");
    assertEquals(models.status, 200);
    assertEquals(await models.json(), { object: "list", data: [] });

    const adminRoutes = createAdminRoutes();
    const plugin = await adminRoutes.request("http://localhost/plugin/demo");
    assertEquals(plugin.status, 404);
    assertEquals((await plugin.json()).error.code, "not_found");
    const plugins = await adminRoutes.request("http://localhost/plugins");
    assertEquals(plugins.status, 200);
    assertEquals(await plugins.json(), { plugins: [] });
    const installed = await adminRoutes.request(
        "http://localhost/plugins/installed",
    );
    assertEquals(installed.status, 200);
    assertEquals(await installed.json(), { plugins: [] });
});

Deno.test("admin routes expose injected plugin, source, and preset DTOs", async () => {
    const routes = createAdminRoutes({
        plugins: ({ requestId }) => [{
            id: "fixture.protocol",
            name: "Fixture protocol",
            version: "1.0.0",
            kind: "protocol",
            enabled: true,
            trust: "trusted",
            lastError: requestId === "admin-dto" ? undefined : "unexpected",
        }],
        sources: [{
            id: "fixture.source",
            enabled: true,
            models: ["fixture-model"],
            capabilities: ["generation.create"],
        }],
        presets: [{
            id: "fixture.preset",
            name: "Fixture preset",
            version: "1.0.0",
            sourcePluginId: "fixture.source",
            description: "test",
        }],
    });

    const list = await routes.request("http://localhost/plugins", {
        headers: { "x-request-id": "admin-dto" },
    });
    assertEquals(list.status, 200);
    assertEquals(list.headers.get("x-heimdall-request-id"), "admin-dto");
    assertEquals((await list.json()).plugins[0].id, "fixture.protocol");

    const detail = await routes.request(
        "http://localhost/plugin/fixture.protocol",
        { headers: { "x-request-id": "admin-detail" } },
    );
    assertEquals(detail.status, 200);
    assertEquals((await detail.json()).plugin.name, "Fixture protocol");

    const source = await routes.request(
        "http://localhost/sources?id=fixture.source",
    );
    assertEquals(source.status, 200);
    assertEquals((await source.json()).source.models, ["fixture-model"]);

    const preset = await routes.request("http://localhost/presets");
    assertEquals(preset.status, 200);
    assertEquals((await preset.json()).presets[0].id, "fixture.preset");

    const status = await routes.request("http://localhost/status");
    assertEquals(status.status, 200);
    assertEquals((await status.json()).status, "ok");
});

Deno.test("server composition mounts public, manifest, and admin route groups", async () => {
    const publicRoutes = new Hono<ServerEnv>();
    publicRoutes.get("/custom", (context) => context.json({ scope: "public" }));

    const adminRoutes = new Hono<ServerEnv>();
    adminRoutes.get("/custom", (context) => context.json({ scope: "admin" }));

    const app = createServer({
        publicRoutes,
        adminRoutes,
    });
    const [publicResponse, adminResponse] = await Promise.all([
        app.request("http://localhost/v1/custom", {
            headers: { "x-request-id": "public-request" },
        }),
        app.request("http://localhost/admin/custom", {
            headers: { "x-request-id": "admin-request" },
        }),
    ]);

    assertEquals(publicResponse.status, 200);
    assertEquals(
        publicResponse.headers.get("x-heimdall-request-id"),
        "public-request",
    );
    assertEquals(await publicResponse.json(), { scope: "public" });
    assertEquals(adminResponse.status, 200);
    assertEquals(
        adminResponse.headers.get("x-heimdall-request-id"),
        "admin-request",
    );
    assertEquals(await adminResponse.json(), { scope: "admin" });

    const legacyAdminResponse = await app.request(
        "http://localhost/api/admin/custom",
        { headers: { "x-request-id": "legacy-admin-request" } },
    );
    assertEquals(legacyAdminResponse.status, 200);
    assertEquals(
        legacyAdminResponse.headers.get("x-heimdall-request-id"),
        "legacy-admin-request",
    );
    assertEquals(await legacyAdminResponse.json(), { scope: "admin" });
});

Deno.test("server composition derives a stable model list from injected sources", async () => {
    const app = createServer({
        sources: [{
            id: "fixture-source",
            capabilities: [{
                operation: "generation.create",
                models: ["zeta", "alpha", "alpha"],
                streaming: true,
            }],
            execute: async function* () {},
        }],
    });
    const response = await app.request("http://localhost/v1/models");
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
        object: "list",
        data: [
            { id: "alpha", object: "model", created: 0, owned_by: "heimdall" },
            { id: "zeta", object: "model", created: 0, owned_by: "heimdall" },
        ],
    });
});

Deno.test("server starts as an empty microkernel without plugin imports", async () => {
    const app = createServer();
    const health = await app.request("http://localhost/health", {
        headers: { "x-request-id": "microkernel-health" },
    });
    assertEquals(health.status, 200);
    assertEquals(
        health.headers.get("x-heimdall-request-id"),
        "microkernel-health",
    );
    assertEquals(await health.json(), { status: "ok" });

    const models = await app.request("http://localhost/v1/models");
    assertEquals(models.status, 200);
    assertEquals(await models.json(), { object: "list", data: [] });

    const nonStaticPaths = [
        ...new Set(
            app.routes
                .map((route) => route.path)
                .filter((path) => path.includes(":") || path.includes("*")),
        ),
    ];
    assertEquals(nonStaticPaths, [
        "/admin/plugin/:id",
        "/api/admin/plugin/:id",
    ]);

    const protocol = await app.request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
    });
    assertEquals(protocol.status, 404);
});

Deno.test("server composition adapts and mounts manifest targets on public and admin roots", async () => {
    const publicManifest: PluginManifest = {
        id: "fixture.public",
        version: "1.0.0",
        apiVersion: "1",
        name: "Fixture public",
        kind: "api",
        trust: "trusted",
        routes: [{
            method: "GET",
            path: "/v1/items/blue",
            operation: "fixture.public.item",
        }],
    };
    const adminManifest: PluginManifest = {
        id: "fixture.admin",
        version: "1.0.0",
        apiVersion: "1",
        name: "Fixture admin",
        kind: "api",
        trust: "trusted",
        routes: [{
            method: "GET",
            path: "/admin/audit/42",
            operation: "fixture.admin.audit",
        }],
    };

    const app = createServer({
        manifestTargets: [{
            manifest: publicManifest,
            handle: ({ route }) =>
                Response.json({ path: route.path, operation: route.operation }),
        }],
        adminManifestTargets: [{
            manifest: adminManifest,
            handle: ({ route }) =>
                Response.json({ path: route.path, operation: route.operation }),
        }],
    });

    const publicResponse = await app.request("http://localhost/v1/items/blue", {
        headers: { "x-request-id": "manifest-public" },
    });
    const adminResponse = await app.request("http://localhost/admin/audit/42", {
        headers: { "x-request-id": "manifest-admin" },
    });
    assertEquals(publicResponse.status, 200);
    assertEquals(
        publicResponse.headers.get("x-heimdall-request-id"),
        "manifest-public",
    );
    assertEquals(await publicResponse.json(), {
        path: "/v1/items/blue",
        operation: "fixture.public.item",
    });
    assertEquals(adminResponse.status, 200);
    assertEquals(
        adminResponse.headers.get("x-heimdall-request-id"),
        "manifest-admin",
    );
    assertEquals(await adminResponse.json(), {
        path: "/admin/audit/42",
        operation: "fixture.admin.audit",
    });
});

Deno.test("server composition maps route failures and unknown paths through one error boundary", async () => {
    const protocolRoutes = new Hono<ServerEnv>();
    protocolRoutes.get("/typed-error", () => {
        throw Object.assign(new Error("bad input"), {
            status: 422,
            code: "fixture_invalid",
        });
    });
    protocolRoutes.get("/internal-error", () => {
        throw new Error("secret implementation detail");
    });

    const app = createServer({ protocolRoutes });
    const typed = await app.request("http://localhost/v1/typed-error", {
        headers: { "x-request-id": "typed-error-request" },
    });
    assertEquals(typed.status, 422);
    assertEquals(
        typed.headers.get("x-heimdall-request-id"),
        "typed-error-request",
    );
    assertEquals(await typed.json(), {
        error: {
            code: "fixture_invalid",
            message: "bad input",
            request_id: "typed-error-request",
        },
    });

    const internal = await app.request("http://localhost/v1/internal-error");
    assertEquals(internal.status, 500);
    const internalBody = await internal.json();
    assertEquals(internalBody.error.code, "internal_error");
    assertEquals(internalBody.error.message, "internal server error");
    assertEquals(
        internalBody.error.request_id,
        internal.headers.get("x-heimdall-request-id"),
    );

    const missing = await app.request("http://localhost/does-not-exist", {
        headers: { "x-request-id": "missing-request" },
    });
    assertEquals(missing.status, 404);
    assertEquals(await missing.json(), {
        error: {
            code: "route_not_found",
            message: "route not found",
            request_id: "missing-request",
        },
    });
});

Deno.test("server composition rejects ambiguous route injection and validates runtime ports", () => {
    const genericHono: Hono = new Hono();
    void genericHono;
    const publicRoutes = new Hono<ServerEnv>();
    const protocolRoutes = new Hono<ServerEnv>();
    assertThrows(
        () => createServerApp({ publicRoutes, protocolRoutes }),
        TypeError,
        "publicRoutes or protocolRoutes",
    );
    assertThrows(
        () =>
            createServerApp({
                manifestRoutes: publicRoutes,
                manifestTargets: [],
            }),
        TypeError,
        "manifestRoutes or manifestTargets",
    );
    assertEquals(readPort(undefined), 8088);
    assertEquals(readPort("65535"), 65535);
    assertThrows(() => readPort("0"), RangeError);
    assertThrows(() => readPort("not-a-port"), RangeError);
});

Deno.test("admin management uses fixed routes and optimistic writes", async () => {
    const calls: string[] = [];
    const app = createServer({
        adminManagement: {
            getSourceConfig: (_context, sourceId) => ({
                sourceId,
                configured: true,
                config: { baseUrl: "https://provider.example/v1" },
                versionstamp: "v1",
            }),
            validateSourceConfig: (_context, sourceId, config) => {
                calls.push(`validate:${sourceId}`);
                return { sourceId, config };
            },
            saveSourceConfig: (_context, sourceId, config, versionstamp) => {
                calls.push(`save:${sourceId}:${versionstamp}`);
                return {
                    data: { source: { sourceId, config } },
                    versionstamp: "v2",
                };
            },
            previewPreset: (_context, presetId, config) => ({
                presetId,
                config,
            }),
            applyPreset: (_context, presetId, config, versionstamp) => ({
                data: { presetId, config },
                versionstamp: versionstamp ?? "v3",
            }),
            setPluginEnabled: (_context, pluginId, enabled) => ({
                pluginId,
                enabled,
            }),
            uninstallPlugin: (_context, pluginId) => pluginId === "gone",
        },
    });

    const source = await app.request(
        "http://localhost/admin/source-config?id=openai-compatible",
    );
    assertEquals(source.status, 200);
    assertEquals((await source.json()).source.sourceId, "openai-compatible");

    const validate = await app.request(
        "http://localhost/admin/source-config/validate",
        {
            method: "POST",
            body: JSON.stringify({
                sourceId: "openai-compatible",
                config: { baseUrl: "https://provider.example/v1" },
            }),
        },
    );
    assertEquals(validate.status, 200);

    const save = await app.request("http://localhost/admin/source-config", {
        method: "PUT",
        headers: { "if-match": '"v1"' },
        body: JSON.stringify({
            sourceId: "openai-compatible",
            config: { baseUrl: "https://provider.example/v1" },
        }),
    });
    assertEquals(save.status, 200);
    assertEquals(save.headers.get("etag"), "v2");

    const preset = await app.request("http://localhost/admin/preset-preview", {
        method: "POST",
        body: JSON.stringify({ presetId: "preset.newapi", config: {} }),
    });
    assertEquals(preset.status, 200);
    const state = await app.request("http://localhost/admin/plugin-state", {
        method: "POST",
        body: JSON.stringify({ pluginId: "source.openai", enabled: false }),
    });
    assertEquals(state.status, 200);
    assertEquals(calls, [
        "validate:openai-compatible",
        "save:openai-compatible:v1",
    ]);
    assertEquals(
        [...app.routes].some((route) =>
            route.path.includes("*") || route.path.includes("/config/")
        ),
        false,
    );
});

Deno.test("admin bearer auth protects both management prefixes", async () => {
    const app = createServerApp({ adminAuthToken: "secret-token" });
    const unauthorized = await app.request("http://localhost/admin/status");
    assertEquals(unauthorized.status, 401);
    assertEquals((await unauthorized.json()).error.code, "unauthorized");
    const authorized = await app.request("http://localhost/admin/status", {
        headers: { authorization: "Bearer secret-token" },
    });
    assertEquals(authorized.status, 200);
    const legacy = await app.request("http://localhost/api/admin/status", {
        headers: { authorization: "Bearer secret-token" },
    });
    assertEquals(legacy.status, 200);
});

Deno.test("admin management maps validation failures to client errors", async () => {
    const app = createServer({
        adminManagement: {
            saveSourceConfig: () => {
                throw new TypeError("baseUrl is invalid");
            },
        },
    });
    const response = await app.request("http://localhost/admin/source-config", {
        method: "PUT",
        body: JSON.stringify({ sourceId: "openai-compatible", config: {} }),
    });
    assertEquals(response.status, 400);
    assertEquals((await response.json()).error.code, "invalid_config");
});

Deno.test("admin mutations narrate themselves into the system log", async () => {
    const entries: Array<{ level: string; scope: string; message: string }> =
        [];
    const systemLog = {
        record(input: { level: string; scope: string; message: string }) {
            entries.push({
                level: input.level,
                scope: input.scope,
                message: input.message,
            });
            return {
                seq: entries.length,
                time: "2026-09-28T00:00:00.000Z",
                level: input.level,
                scope: input.scope,
                message: input.message,
            };
        },
    };
    const app = createAdminRoutes({
        systemLog: systemLog as never,
        management: {
            createSource: (_context, input) => ({ data: { source: input } }),
            updateSource: (_context, sourceId, input) => ({
                data: { source: { sourceId, ...input } },
            }),
            deleteSource: (_context, sourceId) => ({ data: { sourceId } }),
            probeSource: (_context, sourceId) => ({
                sourceId,
                ok: false,
                message: "probe timed out",
                health: "cooldown" as const,
            }),
            setPluginEnabled: (_context, pluginId, enabled) => ({
                pluginId,
                enabled,
            }),
        },
    });

    const create = await app.request("http://localhost/sources", {
        method: "POST",
        body: JSON.stringify({
            id: "019834c2-9abc-4def-8abc-000000000001",
            name: "测试渠道",
            priority: 10,
            sourcePluginId: "openai-compatible",
            config: { baseUrl: "https://provider.example/v1" },
        }),
    });
    assertEquals(create.status, 201);

    const update = await app.request(
        "http://localhost/sources?id=019834c2-9abc-4def-8abc-000000000001",
        { method: "PATCH", body: JSON.stringify({ enabled: false }) },
    );
    assertEquals(update.status, 200);

    const toggle = await app.request("http://localhost/plugin-state", {
        method: "POST",
        body: JSON.stringify({ pluginId: "source.openai", enabled: true }),
    });
    assertEquals(toggle.status, 200);

    const remove = await app.request(
        "http://localhost/sources?id=019834c2-9abc-4def-8abc-000000000001",
        { method: "DELETE" },
    );
    assertEquals(remove.status, 200);

    const probe = await app.request("http://localhost/source-probe", {
        method: "POST",
        body: JSON.stringify({
            sourceId: "019834c2-9abc-4def-8abc-000000000001",
        }),
    });
    assertEquals(probe.status, 200);

    assertEquals(
        entries.map((entry) => [entry.scope, entry.level, entry.message]),
        [
            ["渠道", "info", "添加渠道「测试渠道」"],
            ["渠道", "info", "更新渠道 019834c2…"],
            ["插件", "info", "启用插件 source.openai"],
            ["渠道", "info", "删除渠道 019834c2…"],
            ["渠道", "warn", "探测渠道 019834c2…"],
        ],
    );
});
