/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import {
    assert,
    assertEquals,
    assertFalse,
    assertStringIncludes,
} from "@std/assert";
import { render, useState } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import type { ListedPlugin } from "@heimdall/admin-contracts/console.ts";
import { PluginCards } from "@heimdall/core/web/components/catalog-cards.tsx";
import { PluginsPanel } from "@heimdall/core/web/client/plugins.tsx";
import {
    configureAdminTransport,
    loadDashboard,
} from "@heimdall/core/web/client/api/admin.ts";
import {
    canTogglePlugin,
    pluginCapabilityLabel,
    pluginKindLabel,
    pluginState,
} from "@heimdall/core/web/shared/catalog-presentation.ts";
import { loadConsoleSnapshot } from "@heimdall/core/web/server/snapshot.ts";
import { installTestDom, TestElement } from "./helpers/jsx-dom.ts";

const plugin: ListedPlugin = {
    id: "test.tools",
    name: "测试工具",
    description: "提供 <自定义> 能力",
    kind: "tool",
    version: "1.0.0",
    enabled: true,
    canToggle: true,
    managed: false,
    trust: "trusted",
    capabilities: ["current_time", "custom.test"],
    dependencies: ["test.missing", "test.stopped"],
};

Deno.test("plugin cards render declared metadata, dependency states and host operation grants before JS", () => {
    const html = PluginCards({
        plugins: [plugin, {
            id: "test.stopped",
            enabled: false,
            canToggle: false,
            description: "暂时停用",
            lastError: "<failed>",
            managed: true,
        }],
    }).toString();
    assertStringIncludes(html, "提供 &lt;自定义&gt; 能力");
    assertStringIncludes(html, "当前时间");
    assertStringIncludes(html, "custom.test");
    assertStringIncludes(html, "声明依赖");
    assertStringIncludes(html, "未注册");
    assertStringIncludes(html, "加载失败");
    assertStringIncludes(html, "最近错误：&lt;failed&gt;");
    assertStringIncludes(html, "此插件不支持在线启停");
    assertStringIncludes(html, "内置");
    assertStringIncludes(html, "托管");
    assertStringIncludes(html, 'aria-label="停用 测试工具"');
    assertFalse(html.includes('aria-label="启用 test.stopped"'));
    assertFalse(
        canTogglePlugin({ id: "source", kind: "source", enabled: true }),
    );
    assertFalse(
        canTogglePlugin({ id: "isolated", trust: "isolated", enabled: false }),
    );
    assertFalse(canTogglePlugin({ ...plugin, canToggle: false }));
    assertFalse(canTogglePlugin({ ...plugin, enabled: undefined }));
    assertEquals(pluginState({ id: "unknown" }).label, "状态未知");
    for (const key of ["__proto__", "constructor", "toString"]) {
        assertEquals(pluginCapabilityLabel(key), key);
        assertEquals(pluginKindLabel(key), key);
        assertStringIncludes(
            PluginCards({
                plugins: [{ ...plugin, kind: key, capabilities: [key] }],
            }).toString(),
            key,
        );
    }
});

Deno.test("SSR plugin projection keeps only valid declared metadata and host booleans", async () => {
    const result = await loadConsoleSnapshot({
        authorized: true,
        adminAuthToken: "TOKEN",
        dispatch(request) {
            return Response.json(
                new URL(request.url).pathname === "/api/admin/status"
                    ? {
                        plugins: [{
                            ...plugin,
                            description: "description TOKEN",
                            capabilities: ["safe", "TOKEN", {
                                secret: "PRIVATE",
                            }],
                            dependencies: ["plugin-a", 42],
                            canToggle: "yes",
                            managed: true,
                            config: { token: "PRIVATE" },
                        }],
                    }
                    : {},
            );
        },
    });
    const dto = result.dashboard.status.plugins[0]!;
    assertEquals(dto.description, "description [已隐藏]");
    assertEquals(dto.capabilities, ["safe", "[已隐藏]"]);
    assertEquals(dto.dependencies, ["plugin-a"]);
    assertEquals(dto.canToggle, undefined);
    assertEquals(dto.managed, true);
    assertFalse(JSON.stringify(dto).includes("PRIVATE"));
});

function find(root: TestElement, selector: string): TestElement {
    const found = root.querySelector(selector);
    assert(found, `Missing ${selector}: ${root.textContent}`);
    return found;
}

Deno.test("browser catalog refresh and initial SSR use the same public plugin projection", async () => {
    const input = [null, [], {}, { id: "" }, {
        ...plugin,
        capabilities: ["tools", 3, { private: "SECRET" }],
        dependencies: "not-an-array",
        canToggle: "true",
        secret: "SECRET",
    }];
    const snapshot = await loadConsoleSnapshot({
        authorized: true,
        dispatch: () => Response.json({ plugins: input }),
    });
    configureAdminTransport(() =>
        Promise.resolve(Response.json({ plugins: input }))
    );
    try {
        const dashboard = await loadDashboard();
        assertEquals(
            dashboard.status.plugins,
            snapshot.dashboard.status.plugins,
        );
        assertEquals(dashboard.status.plugins.length, 1);
        assertEquals(dashboard.status.plugins[0]?.dependencies, []);
        assertFalse(canTogglePlugin(dashboard.status.plugins[0]!));
        assertFalse(
            JSON.stringify(dashboard.status.plugins).includes("SECRET"),
        );
    } finally {
        configureAdminTransport();
    }
});

function deferred() {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((yes) => resolve = yes);
    return { promise, resolve };
}

Deno.test("plugin toggle calls the real management API once and refreshes status after success", async () => {
    const dom = installTestDom();
    const response = deferred();
    const calls: unknown[] = [];
    let refreshes = 0;
    configureAdminTransport((_url, init) => {
        assertEquals(_url, "/api/admin/plugin-state");
        assertEquals(init?.method, "POST");
        calls.push(JSON.parse(String(init?.body)));
        return response.promise;
    });
    function App() {
        const [plugins, setPlugins] = useState([plugin]);
        return (
            <PluginsPanel
                plugins={plugins}
                loadError=""
                onRefresh={() => {
                    refreshes++;
                    setPlugins([{ ...plugin, enabled: false }]);
                    return Promise.resolve();
                }}
            />
        );
    }
    try {
        await dom.act(() =>
            render(<App />, dom.root as unknown as HTMLElement)
        );
        const toggle = find(dom.root, 'button[aria-label="停用 测试工具"]');
        await dom.act(() => {
            toggle.click();
            toggle.click();
        });
        assertEquals(calls, [{ pluginId: "test.tools", enabled: false }]);
        assert(toggle.disabled);
        assertEquals(
            find(dom.root, "article").getAttribute("aria-busy"),
            "true",
        );
        response.resolve(Response.json({ plugin: { enabled: false } }));
        await response.promise;
        for (let pass = 0; pass < 3; pass++) await dom.act();
        assertEquals(refreshes, 1);
        assertStringIncludes(
            find(dom.root, '[role="status"]').textContent,
            "已停用 测试工具",
        );
        assertFalse(
            find(dom.root, 'button[aria-label="启用 测试工具"]').disabled,
        );
        assertEquals(dom.navigation, []);
        assertEquals(dom.storageWrites, []);
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        configureAdminTransport();
        dom.restore();
    }
});

Deno.test("plugin toggle distinguishes API failure from refresh failure and permits retry", async () => {
    for (const apiFailure of [true, false]) {
        const dom = installTestDom();
        let refreshes = 0;
        configureAdminTransport(() =>
            Promise.resolve(
                apiFailure
                    ? Response.json({ error: { message: "加载失败" } }, {
                        status: 409,
                    })
                    : Response.json({ plugin: {} }),
            )
        );
        try {
            await dom.act(() =>
                render(
                    <PluginsPanel
                        plugins={[plugin]}
                        loadError=""
                        onRefresh={() => {
                            refreshes++;
                            return Promise.reject(new Error("网络中断"));
                        }}
                    />,
                    dom.root as unknown as HTMLElement,
                )
            );
            await dom.act(() => find(dom.root, "button").click());
            for (let pass = 0; pass < 3; pass++) await dom.act();
            assertEquals(refreshes, apiFailure ? 0 : 1);
            assertStringIncludes(
                find(dom.root, '[role="alert"]').textContent,
                apiFailure
                    ? "更新插件状态失败"
                    : "插件状态已更新，列表刷新失败",
            );
            assertEquals(
                dom.root.querySelector('[role="status"]') !== null,
                !apiFailure,
            );
            assertFalse(find(dom.root, "button").disabled);
        } finally {
            await dom.act(() =>
                render(null, dom.root as unknown as HTMLElement)
            );
            configureAdminTransport();
            dom.restore();
        }
    }
});
