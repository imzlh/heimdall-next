import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createServerApp } from "@heimdall/core/http/app.ts";
import {
    createAdminWebRoutes,
    serializeBoot,
} from "@heimdall/core/http/admin-web.tsx";
import { PluginCards } from "@heimdall/core/web/components/catalog-cards.tsx";
import { canTogglePlugin } from "@heimdall/core/web/shared/catalog-presentation.ts";

Deno.test("SSR console renders data before JS and preserves existing JSON routes", async () => {
    const app = createServerApp({
        models: () => ({ object: "list", data: [{ id: "模型 <alpha>" }] }),
        adminCatalog: {
            sources: [{ id: "source-a", enabled: true, models: ["alpha"] }],
        },
    });
    const redirect = await app.request("/");
    assertEquals(redirect.status, 303);
    assertEquals(redirect.headers.get("location"), "/admin");
    const response = await app.request("/admin");
    const html = await response.text();
    assertEquals(response.status, 200);
    assertStringIncludes(response.headers.get("content-type")!, "text/html");
    assertStringIncludes(html, "<!doctype html>");
    assertStringIncludes(html, "模型 &lt;alpha&gt;");
    assertStringIncludes(html, "<noscript>");
    assertStringIncludes(html, "/admin/assets/console.js");
    assertEquals(response.headers.get("cache-control"), "no-store");
    const channels = await app.request("/admin?view=channels");
    assertStringIncludes(await channels.text(), "source-a");
    const api = await app.request("/admin/models");
    assertEquals((await api.json()).data[0].id, "模型 <alpha>");
});

Deno.test("HTML login works without JS and does not grant cookie access to bearer APIs", async () => {
    const app = createServerApp({
        adminAuthToken: "operator-secret",
        models: () => ({ object: "list", data: [{ id: "private-model" }] }),
    });
    const publicHtml = await (await app.request("/admin")).text();
    assertStringIncludes(publicHtml, 'action="/admin/session"');
    assert(!publicHtml.includes("private-model"));
    const login = await app.request("/admin/session", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "token=operator-secret",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const page = await app.request("/admin", { headers: { cookie } });
    const html = await page.text();
    assertStringIncludes(html, "private-model");
    assert(!html.includes("operator-secret"));
    assertEquals(
        (await app.request("/admin/models", { headers: { cookie } })).status,
        401,
    );
});

Deno.test("SSR plugin tab stays schema-only unless host grants execution", async () => {
    const app = createServerApp({
        adminCatalog: {
            plugins: [{
                id: "sample",
                name: "Sample",
                kind: "ui",
                version: "1",
                enabled: true,
                trust: "trusted",
            }],
        },
        adminUiContributions: [{
            id: "quota",
            pluginId: "sample",
            slot: "nav.tab",
            title: "额度",
            schema: {
                blocks: [{
                    kind: "text",
                    text: "</script><script>bad()</script>",
                }],
            },
            render: {
                kind: "trusted",
                modulePath: "/admin/assets/plugins/sample/quota.js",
            },
        }],
    });
    const response = await app.request("/admin?view=plugin&tab=sample:quota");
    assertEquals(response.status, 200);
    const html = await response.text();
    assertStringIncludes(html, 'data-ui-mode="schema"');
    assert(!html.includes("<script>bad()</script>"));
    assertStringIncludes(html, "\\u003c/script\\u003e");
    assertEquals(
        (await app.request("/admin?view=plugin&tab=missing")).status,
        404,
    );
    assertEquals(
        JSON.parse(serializeBoot({ text: "</script>&\u2028" })).text,
        "</script>&\u2028",
    );
});

Deno.test("island boot retains SSR requests usage settings and the settings ETag", async () => {
    const app = createAdminWebRoutes({
        dispatch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/api/admin/requests") {
                return Response.json({
                    requests: [{
                        requestId: "request-ssr",
                        model: "model-ssr",
                    }],
                });
            }
            if (path === "/api/admin/usage") {
                return Response.json({
                    usage: { totalTokens: 125 },
                    days: [{
                        day: "2026-09-24",
                        totalTokens: 125,
                        requestCount: 2,
                    }],
                });
            }
            if (path === "/api/admin/settings") {
                return Response.json({
                    settings: {
                        limitPerMinute: 42,
                        probeIntervalMs: 60000,
                        proxyKeyConfigured: true,
                        proxyKey: "NEVER-IN-BOOT",
                    },
                }, { headers: { etag: "settings-version" } });
            }
            if (path === "/api/admin/proxies") {
                return Response.json({
                    pool: { defaultProxyId: null, entries: [] },
                }, { headers: { etag: "proxies-version" } });
            }
            return Response.json({ status: "ok" });
        },
    });
    const response = await app.request("/admin");
    const html = await response.text();
    const content = html.match(
        /<script[^>]*id="heimdall-boot"[^>]*>([\s\S]*?)<\/script>/,
    )?.[1];
    assert(content);
    const boot = JSON.parse(content);
    assertEquals(boot.initialPanels, {
        requests: [{ requestId: "request-ssr", model: "model-ssr" }],
        usage: {
            usage: { totalTokens: 125 },
            days: [{ day: "2026-09-24", totalTokens: 125, requestCount: 2 }],
        },
        settings: {
            settings: {
                limitPerMinute: 42,
                probeIntervalMs: 60000,
                proxyKeyConfigured: true,
                titleModel: "",
            },
            etag: "settings-version",
        },
        proxies: {
            pool: { defaultProxyId: null, entries: [] },
            etag: "proxies-version",
        },
        // The boot always ships a stats panel; the stub dispatcher above does
        // not serve the stats endpoints, so SSR carries the fallback errors.
        stats: {
            overview: null,
            series: null,
            errors: {
                overview: "暂时无法读取统计总览。",
                series: "暂时无法读取统计趋势。",
            },
        },
        errors: { requests: "", usage: "", settings: "", proxies: "" },
    });
    assert(!html.includes("NEVER-IN-BOOT"));
});

Deno.test("registered tool plugins expose Chinese labels and both enable and disable actions", () => {
    const plugins = [{
        id: "clock-tool",
        name: "时钟工具",
        kind: "tool",
        trust: "trusted",
        enabled: true,
        canToggle: true,
    }, {
        id: "lookup-tool",
        name: "查询工具",
        kind: "tool",
        trust: "trusted",
        enabled: false,
        canToggle: true,
    }];
    const html = PluginCards({ plugins }).toString();
    assertStringIncludes(html, "聊天工具");
    assertStringIncludes(html, 'aria-label="停用 时钟工具"');
    assertStringIncludes(html, 'aria-label="启用 查询工具"');
    assert(plugins.every(canTogglePlugin));
    assert(canTogglePlugin({ id: "source", enabled: true, canToggle: true }));
    assert(
        canTogglePlugin({ id: "isolated", enabled: false, canToggle: true }),
    );
    assertEquals(
        canTogglePlugin({ id: "protocol", kind: "protocol", trust: "trusted" }),
        false,
    );
});
