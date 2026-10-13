import {
    assert,
    assertEquals,
    assertFalse,
    assertStringIncludes,
} from "@std/assert";
import type { ConsoleSnapshot } from "@heimdall/admin-contracts/console.ts";
import { createAdminWebRoutes } from "@heimdall/core/http/admin-web.tsx";
import { loadConsoleSnapshot } from "@heimdall/core/web/server/snapshot.ts";

const safePool = {
    defaultProxyId: "office",
    entries: [{
        id: "office",
        name: "办公室出口",
        url: "http://127.0.0.1:7890/",
        enabled: true,
        authConfigured: true,
    }, {
        id: "backup",
        name: "备用出口",
        url: "socks5://127.0.0.1:1080",
        enabled: false,
        authConfigured: false,
    }],
};

const privateValues = [
    "PRIVATE-PROXY-USERNAME",
    "PRIVATE-PROXY-PASSWORD",
    "PRIVATE-PROXY-HIDDEN-FIELD",
];
const extraFields = {
    basicAuth: {
        username: privateValues[0],
        password: privateValues[1],
    },
    credentials: privateValues[2],
};

const sources = [{
    id: "inherited",
    name: "继承渠道",
    enabled: true,
    proxy: { mode: "inherit", ...extraFields },
    proxySummary: {
        mode: "proxy",
        selectedBy: "global",
        proxyId: "office",
        name: "办公室出口",
        ...extraFields,
    },
}, {
    id: "direct",
    name: "直连渠道",
    enabled: true,
    proxy: { mode: "direct", ...extraFields },
}, {
    id: "explicit",
    name: "指定渠道",
    enabled: true,
    proxy: { mode: "proxy", proxyId: "backup", ...extraFields },
    proxySummary: {
        mode: "unavailable",
        selectedBy: "source",
        proxyId: "backup",
        name: "备用出口",
        reason: "disabled",
        ...extraFields,
    },
}];

function dispatchWithProxy(
    proxies: () => Response = () =>
        Response.json({
            pool: {
                ...safePool,
                ...extraFields,
                entries: safePool.entries.map((entry) => ({
                    ...entry,
                    ...extraFields,
                })),
            },
            ...extraFields,
        }, { headers: { etag: '"proxy-version-7"' } }),
): (request: Request) => Response {
    return (request) => {
        switch (new URL(request.url).pathname) {
            case "/health":
                return Response.json({ status: "ok" });
            case "/api/admin/proxies":
                return proxies();
            case "/api/admin/status":
                return Response.json({ sources, plugins: [], presets: [] });
            case "/api/admin/models":
                return Response.json({ data: [{ id: "model-readable" }] });
            case "/api/admin/requests":
                return Response.json({ requests: [] });
            case "/api/admin/usage":
                return Response.json({ usage: { totalTokens: 8 }, days: [] });
            case "/api/admin/settings":
                return Response.json({
                    settings: {
                        proxyKeyConfigured: true,
                        limitPerMinute: 120,
                        probeIntervalMs: 300_000,
                    },
                });
            default:
                throw new Error(`unexpected path: ${request.url}`);
        }
    };
}

function bootFrom(html: string): {
    initial: ConsoleSnapshot["dashboard"];
    initialPanels: Omit<ConsoleSnapshot, "dashboard">;
} {
    const content = html.match(
        /<script[^>]*id="heimdall-boot"[^>]*>([\s\S]*?)<\/script>/,
    )?.[1];
    assert(content, "SSR must carry initial island data");
    return JSON.parse(content);
}

function assertNoPrivateData(content: string): void {
    for (const value of privateValues) assertFalse(content.includes(value));
    assertFalse(content.includes("basicAuth"));
    assertFalse(content.includes("credentials"));
}

Deno.test("proxy SSR snapshot projects only public pool and source metadata", async () => {
    const dispatch = dispatchWithProxy();
    const snapshot = await loadConsoleSnapshot({
        authorized: true,
        adminAuthToken: "SERVER-ONLY-ADMIN-TOKEN",
        dispatch(request) {
            assertEquals(
                request.headers.get("authorization"),
                new URL(request.url).pathname === "/health"
                    ? null
                    : "Bearer SERVER-ONLY-ADMIN-TOKEN",
            );
            return dispatch(request);
        },
    });
    assertEquals(snapshot.proxies, {
        pool: safePool,
        etag: '"proxy-version-7"',
    });
    assertEquals(snapshot.errors.proxies, "");
    assertEquals(
        snapshot.dashboard.status.sources.map((source) => source.proxy),
        [{ mode: "inherit" }, { mode: "direct" }, {
            mode: "proxy",
            proxyId: "backup",
        }],
    );
    assertEquals(snapshot.dashboard.status.sources[0]?.proxySummary, {
        mode: "proxy",
        selectedBy: "global",
        proxyId: "office",
        name: "办公室出口",
    });
    assertEquals(snapshot.dashboard.status.sources[2]?.proxySummary, {
        mode: "unavailable",
        selectedBy: "source",
        proxyId: "backup",
        name: "备用出口",
        reason: "disabled",
    });
    const serialized = JSON.stringify(snapshot);
    assertNoPrivateData(serialized);
    assertFalse(serialized.includes("SERVER-ONLY-ADMIN-TOKEN"));
});

Deno.test("settings SSR and island boot retain proxy summary and version without credentials", async () => {
    const app = createAdminWebRoutes({ dispatch: dispatchWithProxy() });
    const response = await app.request("/admin?view=settings");
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("cache-control"), "no-store");
    const html = await response.text();
    const markup = html.split('<script id="heimdall-boot"')[0]!;
    assertStringIncludes(markup, "出站代理池");
    assertStringIncludes(markup, "全局默认");
    assertStringIncludes(markup, "办公室出口");
    assertStringIncludes(markup, "http://127.0.0.1:7890/");
    assertStringIncludes(markup, "认证已配置");
    assertStringIncludes(markup, "已停用");
    assertStringIncludes(markup, "正在加载交互功能，当前可浏览数据。");
    assertStringIncludes(
        markup,
        "代理选择由插件读取，是否使用取决于插件实现。",
    );
    const boot = bootFrom(html);
    assertEquals(boot.initialPanels.proxies, {
        pool: safePool,
        etag: '"proxy-version-7"',
    });
    assertEquals(boot.initialPanels.errors.proxies, "");
    assertNoPrivateData(html);
});

Deno.test("channels and overview SSR display inherited, direct and unavailable proxy choices", async () => {
    const app = createAdminWebRoutes({ dispatch: dispatchWithProxy() });
    for (const page of ["channels", "overview"]) {
        const html = await (await app.request(`/admin?view=${page}`)).text();
        const markup = html.split('<script id="heimdall-boot"')[0]!;
        assertStringIncludes(markup, "代理：继承全局 · 办公室出口");
        assertStringIncludes(markup, "代理：直连");
        assertStringIncludes(markup, "代理：指定代理 · 备用出口（已停用）");
        assertNoPrivateData(html);
    }
});

Deno.test("proxy read failure preserves settings and source summaries without reflecting private responses", async () => {
    const app = createAdminWebRoutes({
        dispatch: dispatchWithProxy(() =>
            Response.json({ error: privateValues.join(" ") }, { status: 503 })
        ),
    });
    const html = await (await app.request("/admin?view=settings")).text();
    assertStringIncludes(html, "运行与对话");
    assertStringIncludes(html, "出站代理池");
    assertStringIncludes(html, "HTTP 503");
    assertEquals(bootFrom(html).initialPanels.proxies, null);
    assertEquals(
        bootFrom(html).initialPanels.settings?.settings.limitPerMinute,
        120,
    );
    assertNoPrivateData(html);
    const channels = await (await app.request("/admin?view=channels")).text();
    assertStringIncludes(channels, "代理：全局默认 · 办公室出口");
    assertStringIncludes(channels, "代理：渠道选择 · 备用出口（已停用）");
});

Deno.test("SSR refuses proxy URLs with embedded credentials or hidden URL fields", async () => {
    for (
        const url of [
            `http://${privateValues[0]}:${privateValues[1]}@127.0.0.1:7890/`,
            `http://127.0.0.1:7890/${privateValues[2]}`,
            `http://127.0.0.1:7890/?password=${privateValues[1]}`,
            `http://127.0.0.1:7890/#${privateValues[2]}`,
        ]
    ) {
        const app = createAdminWebRoutes({
            dispatch: dispatchWithProxy(() =>
                Response.json({
                    pool: {
                        defaultProxyId: "office",
                        entries: [{ ...safePool.entries[0], url }],
                    },
                })
            ),
        });
        const html = await (await app.request("/admin?view=settings")).text();
        const boot = bootFrom(html);
        assertEquals(boot.initialPanels.proxies, null);
        assertStringIncludes(
            boot.initialPanels.errors.proxies!,
            "暂时无法读取代理池",
        );
        assertNoPrivateData(html);
        assertEquals(boot.initial.models[0]?.id, "model-readable");
    }
});

Deno.test("unauthenticated SSR never loads or publishes the proxy pool", async () => {
    const requested: string[] = [];
    const dispatch = dispatchWithProxy();
    const app = createAdminWebRoutes({
        adminAuthToken: "SERVER-ONLY-ADMIN-TOKEN",
        dispatch(request) {
            requested.push(new URL(request.url).pathname);
            return dispatch(request);
        },
    });
    const html = await (await app.request("/admin?view=settings")).text();
    assertEquals(requested, ["/health"]);
    assertEquals(bootFrom(html).initialPanels.proxies, null);
    assertFalse(html.includes("办公室出口"));
    assertFalse(html.includes("SERVER-ONLY-ADMIN-TOKEN"));
    assertNoPrivateData(html);
});
