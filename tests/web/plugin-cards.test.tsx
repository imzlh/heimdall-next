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
                            revision: "revision-3",
                            rollbackVersion: "0.9.0",
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
    assertEquals(dto.revision, "revision-3");
    assertEquals(dto.rollbackVersion, "0.9.0");
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
        revision: "revision-3",
        rollbackVersion: "0.9.0",
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
        assertEquals(dashboard.status.plugins[0]?.revision, "revision-3");
        assertEquals(dashboard.status.plugins[0]?.rollbackVersion, "0.9.0");
        assertFalse(canTogglePlugin(dashboard.status.plugins[0]!));
        assertFalse(
            JSON.stringify(dashboard.status.plugins).includes("SECRET"),
        );
    } finally {
        configureAdminTransport();
    }
});

Deno.test("plugin projections discard malformed revision and rollback metadata in SSR and browser refresh", async () => {
    const input = [{
        ...plugin,
        managed: true,
        revision: { secret: "PRIVATE" },
        rollbackVersion: ["0.9.0"],
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
        assertEquals(dashboard.status.plugins[0]?.revision, undefined);
        assertEquals(dashboard.status.plugins[0]?.rollbackVersion, undefined);
        assertFalse(
            JSON.stringify(dashboard.status.plugins).includes("PRIVATE"),
        );
    } finally {
        configureAdminTransport();
    }
});

Deno.test("SSR cards expose disabled rollback only for managed plugins with a retained version", () => {
    const managed = {
        ...plugin,
        managed: true,
        revision: "revision-3",
        rollbackVersion: "0.9.0",
    };
    const html = PluginCards({
        plugins: [
            { ...managed, name: "可回滚工具" },
            {
                ...managed,
                id: "missing-revision",
                name: "未同步工具",
                revision: undefined,
            },
            { ...managed, id: "builtin", name: "内置工具", managed: false },
            {
                ...managed,
                id: "no-target",
                name: "新装工具",
                rollbackVersion: undefined,
            },
        ],
    }).toString();
    for (const name of ["可回滚工具", "未同步工具"]) {
        const tag = html.match(
            new RegExp(
                `<button\\b[^>]*aria-label="回滚 ${name} 至 v0.9.0"[^>]*>`,
            ),
        )?.[0];
        assert(tag, `Missing SSR rollback button for ${name}`);
        assertStringIncludes(tag, "disabled");
    }
    assertFalse(html.includes('aria-label="回滚 内置工具'));
    assertFalse(html.includes('aria-label="回滚 新装工具'));
    assertStringIncludes(html, "交互加载后可用");
});

Deno.test("browser rollback stays disabled until the host supplies a revision", async () => {
    const dom = installTestDom();
    let requests = 0;
    configureAdminTransport(() => {
        requests++;
        return Promise.resolve(Response.json({}));
    });
    const managed = {
        ...plugin,
        managed: true,
        rollbackVersion: "0.9.0",
    };
    try {
        await dom.act(() =>
            render(
                <PluginsPanel
                    plugins={[
                        managed,
                        {
                            ...managed,
                            id: "available",
                            name: "可回滚工具",
                            revision: "revision-3",
                        },
                    ]}
                    loadError=""
                    onRefresh={() => Promise.resolve()}
                />,
                dom.root as unknown as HTMLElement,
            )
        );
        const blocked = find(
            dom.root,
            'button[aria-label="回滚 测试工具 至 v0.9.0"]',
        );
        assert(blocked.disabled);
        assertStringIncludes(blocked.getAttribute("title") ?? "", "刷新");
        assertFalse(
            find(dom.root, 'button[aria-label="回滚 可回滚工具 至 v0.9.0"]')
                .disabled,
        );
        await dom.act(() => blocked.click());
        assertEquals(requests, 0);
        assertEquals(dom.root.querySelector("dialog"), null);
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        configureAdminTransport();
        dom.restore();
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
        assertEquals(dom.storageWrites.length, 1);
        assertStringIncludes(
            dom.storageWrites[0]!,
            "heimdall.plugins.revision=",
        );
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
            await dom.act(() =>
                find(dom.root, 'button[aria-label="停用 测试工具"]').click()
            );
            for (let pass = 0; pass < 3; pass++) await dom.act();
            assertEquals(refreshes, 1);
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
            assertFalse(
                find(dom.root, 'button[aria-label="停用 测试工具"]').disabled,
            );
        } finally {
            await dom.act(() =>
                render(null, dom.root as unknown as HTMLElement)
            );
            configureAdminTransport();
            dom.restore();
        }
    }
});
