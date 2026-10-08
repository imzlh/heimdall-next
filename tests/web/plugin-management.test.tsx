/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import {
    assert,
    assertEquals,
    assertFalse,
    assertRejects,
    assertStringIncludes,
} from "@std/assert";
import { render, useState } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import type { ListedPlugin } from "@heimdall/admin-contracts/console.ts";
import { configureAdminTransport } from "@heimdall/core/web/client/api/admin.ts";
import { PluginsPanel } from "@heimdall/core/web/client/plugins.tsx";
import { PluginCards } from "@heimdall/core/web/components/catalog-cards.tsx";
import { readPluginPackage } from "@heimdall/core/web/client/plugin-package-file.ts";
import { PLUGIN_CATALOG_CHANGED } from "@heimdall/core/web/client/plugin-events.ts";
import { installTestDom, type TestElement } from "./helpers/jsx-dom.ts";

const managed: ListedPlugin = {
    id: "example.dynamic",
    name: "动态工具",
    version: "1.0.0",
    kind: "tool",
    trust: "isolated",
    managed: true,
    canToggle: true,
    enabled: true,
    revision: "revision-current",
};
const packageData = {
    format: "heimdall-plugin/v1",
    entrypoint: "plugin.js",
    code: "globalThis.__pluginShouldNeverExecuteInBrowser = true;",
    digest: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    manifest: {
        id: "example.package",
        name: "本地插件",
        version: "1.2.0",
        apiVersion: "1",
        kind: "tool",
        trust: "isolated",
        description: "显示 <原始> 文本",
        capabilities: ["web_search"],
        dependencies: ["missing.tool"],
    },
};
const upgradeData = {
    ...packageData,
    manifest: {
        ...packageData.manifest,
        id: managed.id,
        name: managed.name!,
        dependencies: [],
    },
};

function find(root: TestElement, selector: string): TestElement {
    const found = root.querySelector(selector);
    assert(found, `Missing ${selector}: ${root.textContent}`);
    return found;
}
function button(root: TestElement, label: string): TestElement {
    const found = root.querySelectorAll("button").find((element) =>
        element.textContent === label
    );
    assert(found, `Missing button ${label}: ${root.textContent}`);
    return found;
}
function file(input = packageData): File {
    return new File([JSON.stringify(input)], "plugin.json", {
        type: "application/json",
    });
}
function choose(input: TestElement, selected: File) {
    Object.defineProperty(input, "files", {
        configurable: true,
        value: [selected],
    });
    input.dispatchEvent(new Event("input"));
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => resolve = yes);
    return { promise, resolve };
}
async function settle(dom: ReturnType<typeof installTestDom>) {
    for (let pass = 0; pass < 5; pass++) await dom.act();
}
async function setup(options: {
    plugins?: ListedPlugin[];
    response?: (path: string, init?: RequestInit) => Promise<Response>;
    refresh?: () => void | Promise<void>;
    refreshedPlugins?: ListedPlugin[];
} = {}) {
    const dom = installTestDom();
    const calls: { path: string; method: string; body: unknown }[] = [];
    let refreshes = 0;
    let catalogEvents = 0;
    const catalogChanged = () => catalogEvents++;
    globalThis.addEventListener(PLUGIN_CATALOG_CHANGED, catalogChanged);
    let replace = (_plugins: ListedPlugin[]) => {};
    configureAdminTransport((input, init) => {
        calls.push({
            path: String(input),
            method: init?.method ?? "GET",
            body: JSON.parse(String(init?.body)),
        });
        return options.response?.(String(input), init) ??
            Promise.resolve(Response.json({ plugin: {} }));
    });
    function App() {
        const [plugins, setPlugins] = useState(options.plugins ?? [managed]);
        replace = setPlugins;
        return (
            <PluginsPanel
                plugins={plugins}
                loadError=""
                onRefresh={async () => {
                    refreshes++;
                    await options.refresh?.();
                    if (options.refreshedPlugins) {
                        setPlugins(options.refreshedPlugins);
                    }
                }}
            />
        );
    }
    await dom.act(() => render(<App />, dom.root as unknown as HTMLElement));
    return {
        dom,
        calls,
        replace,
        refreshes: () => refreshes,
        catalogEvents: () => catalogEvents,
        async cleanup() {
            await dom.act(() =>
                render(null, dom.root as unknown as HTMLElement)
            );
            configureAdminTransport();
            globalThis.removeEventListener(
                PLUGIN_CATALOG_CHANGED,
                catalogChanged,
            );
            dom.restore();
        },
    };
}

Deno.test("SSR cards expose install and managed removal while keeping built-ins protected", () => {
    const html = PluginCards({
        plugins: [managed, {
            ...managed,
            id: "builtin",
            name: "内置工具",
            managed: false,
        }],
    }).toString();
    assertStringIncludes(html, "安装插件");
    assertStringIncludes(html, 'aria-label="卸载 动态工具"');
    assertFalse(html.includes('aria-label="卸载 内置工具"'));
    assertStringIncludes(html, "交互加载后可用");
});

Deno.test("package file metadata is read without evaluation and rejects unsupported or oversized payloads", async () => {
    const preview = await readPluginPackage(file());
    assertEquals(preview.input, packageData);
    assertEquals(preview.plugin.name, "本地插件");
    assertFalse(
        Object.hasOwn(globalThis, "__pluginShouldNeverExecuteInBrowser"),
    );
    await assertRejects(
        () => readPluginPackage(new File(["{"], "broken.json")),
        Error,
        "UTF-8 JSON",
    );
    await assertRejects(
        () =>
            readPluginPackage(
                new File([new Uint8Array([0xff])], "invalid.json"),
            ),
        Error,
        "UTF-8 JSON",
    );
    await assertRejects(
        () =>
            readPluginPackage(
                file({
                    ...packageData,
                    manifest: { ...packageData.manifest, trust: "trusted" },
                }),
            ),
        Error,
        "隔离运行",
    );
    await assertRejects(
        () =>
            readPluginPackage(
                file({ ...packageData, code: "界".repeat(350_000) }),
            ),
        Error,
        "1 MiB",
    );
    await assertRejects(
        () =>
            readPluginPackage(
                new File([" ".repeat(2 * 1024 * 1024 + 1)], "huge.json"),
            ),
        Error,
        "2 MiB",
    );
});

Deno.test("installation previews a local package, sends one real management operation, and refreshes", async () => {
    const response = deferred<Response>();
    const harness = await setup({ response: () => response.promise });
    const { dom, calls } = harness;
    try {
        const trigger = button(dom.root, "安装插件");
        trigger.focus();
        await dom.act(() => trigger.click());
        const dialog = find(dom.root, "dialog");
        assert(dialog.open);
        assertEquals(dialog.showModalCalls, 1);
        assert(button(dom.root, "安装插件包").disabled);
        await dom.act(() =>
            choose(find(dom.root, 'input[type="file"]'), file())
        );
        await settle(dom);
        assertStringIncludes(dialog.textContent, "本地插件");
        assertStringIncludes(dialog.textContent, "网页搜索");
        assertStringIncludes(dialog.textContent, "未注册");
        assertFalse(dialog.textContent.includes(packageData.code));
        await dom.act(() => {
            button(dom.root, "安装插件包").click();
            button(dom.root, "安装插件包").click();
        });
        assertEquals(calls, [{
            path: "/api/admin/plugin-package",
            method: "POST",
            body: packageData,
        }]);
        assertEquals(dialog.getAttribute("aria-busy"), "true");
        const cancel = new Event("cancel", { cancelable: true });
        await dom.act(() => dialog.dispatchEvent(cancel));
        assert(cancel.defaultPrevented);
        assert(dialog.open);
        response.resolve(
            Response.json({
                plugin: { manifest: packageData.manifest, enabled: false },
            }, { status: 201 }),
        );
        await settle(dom);
        assertEquals(harness.refreshes(), 1);
        assertEquals(dom.root.querySelector("dialog"), null);
        assertStringIncludes(
            find(dom.root, '[role="status"]').textContent,
            "已安装 本地插件",
        );
        assertStringIncludes(
            find(dom.root, '[role="status"]').textContent,
            "卡片中启用",
        );
        assertEquals(dom.navigation, []);
        assertEquals(dom.storageWrites.length, 1);
        assertStringIncludes(
            dom.storageWrites[0]!,
            "heimdall.plugins.revision=",
        );
        assertFalse(dom.storageWrites[0]!.includes(packageData.code));
    } finally {
        await harness.cleanup();
    }
});

Deno.test("installation preserves server verification errors in the modal and can retry", async () => {
    let attempt = 0;
    const harness = await setup({
        response: () =>
            Promise.resolve(
                ++attempt === 1
                    ? Response.json(
                        { error: { message: "SHA-256 校验失败" } },
                        { status: 400 },
                    )
                    : Response.json({ plugin: {} }, { status: 201 }),
            ),
    });
    const { dom } = harness;
    try {
        await dom.act(() => button(dom.root, "安装插件").click());
        await dom.act(() =>
            choose(find(dom.root, 'input[type="file"]'), file())
        );
        await settle(dom);
        await dom.act(() => button(dom.root, "安装插件包").click());
        await settle(dom);
        assert(find(dom.root, "dialog").open);
        assertStringIncludes(
            find(dom.root, '[role="alert"]').textContent,
            "SHA-256 校验失败",
        );
        assertFalse(button(dom.root, "安装插件包").disabled);
        assertEquals(harness.refreshes(), 0);
        await dom.act(() => button(dom.root, "安装插件包").click());
        await settle(dom);
        assertEquals(attempt, 2);
        assertEquals(harness.refreshes(), 1);
        assertEquals(dom.root.querySelector("dialog"), null);
    } finally {
        await harness.cleanup();
    }
});

Deno.test("replacing an upload invalidates the old preview synchronously and discards late reads", async () => {
    const harness = await setup();
    const { dom } = harness;
    const bytes = deferred<ArrayBuffer>();
    try {
        await dom.act(() => button(dom.root, "安装插件").click());
        const picker = find(dom.root, 'input[type="file"]');
        await dom.act(() => choose(picker, file()));
        await settle(dom);
        const slow = file();
        Object.defineProperty(slow, "arrayBuffer", {
            value: () => bytes.promise,
        });
        await dom.act(() => {
            choose(picker, slow);
            button(dom.root, "安装插件包").click();
        });
        assertEquals(harness.calls.length, 0);
        await dom.act(() => choose(picker, new File(["{"], "broken.json")));
        await settle(dom);
        bytes.resolve(await file().arrayBuffer());
        await settle(dom);
        assertStringIncludes(
            find(dom.root, '[role="alert"]').textContent,
            "UTF-8 JSON",
        );
        assert(button(dom.root, "安装插件包").disabled);
        assertEquals(dom.root.querySelector('[aria-label="插件包预览"]'), null);
    } finally {
        await harness.cleanup();
    }
});

Deno.test("an uploaded package cannot overwrite a built-in plugin", async () => {
    const harness = await setup({
        plugins: [{ ...managed, id: packageData.manifest.id, managed: false }],
    });
    try {
        await harness.dom.act(() =>
            button(harness.dom.root, "安装插件").click()
        );
        await harness.dom.act(() =>
            choose(find(harness.dom.root, 'input[type="file"]'), file())
        );
        await settle(harness.dom);
        assertStringIncludes(
            find(harness.dom.root, '[role="alert"]').textContent,
            "内置插件不能覆盖",
        );
        assert(button(harness.dom.root, "安装插件包").disabled);
        assertEquals(harness.calls, []);
    } finally {
        await harness.cleanup();
    }
});

Deno.test("a newer managed package upgrades once, preserves its state, and invalidates the catalog", async () => {
    for (
        const [enabled, currentVersion, targetVersion] of [
            [true, "1.9.0", "1.10.0"],
            [false, "2.0.0-rc.9", "2.0.0-rc.10"],
        ] as const
    ) {
        const current = { ...managed, enabled, version: currentVersion };
        const input = {
            ...upgradeData,
            manifest: { ...upgradeData.manifest, version: targetVersion },
        };
        const updated = {
            ...current,
            version: targetVersion,
            revision: "revision-upgraded",
            rollbackVersion: currentVersion,
        };
        const response = deferred<Response>();
        const harness = await setup({
            plugins: [current],
            response: () => response.promise,
            refreshedPlugins: [updated],
        });
        const { dom } = harness;
        try {
            await dom.act(() => button(dom.root, "安装插件").click());
            await dom.act(() =>
                choose(find(dom.root, 'input[type="file"]'), file(input))
            );
            await settle(dom);
            const dialog = find(dom.root, "dialog");
            assertStringIncludes(
                dialog.textContent,
                `当前版本：v${currentVersion}`,
            );
            assertStringIncludes(
                dialog.textContent,
                `目标版本：v${targetVersion}`,
            );
            const confirm = button(dialog, "升级插件包");
            assertFalse(confirm.disabled);
            await dom.act(() => {
                confirm.click();
                confirm.click();
            });
            assertEquals(harness.calls, [{
                path: "/api/admin/plugin-package",
                method: "PATCH",
                body: {
                    pluginId: managed.id,
                    revision: managed.revision,
                    package: input,
                },
            }]);
            assert(confirm.disabled);
            assertEquals(harness.catalogEvents(), 0);
            response.resolve(Response.json({
                plugin: { ...updated, manifest: input.manifest },
            }));
            await settle(dom);
            assertEquals(harness.refreshes(), 1);
            assertEquals(harness.catalogEvents(), 1);
            assertEquals(dom.root.querySelector("dialog"), null);
            const status = find(dom.root, '[role="status"]').textContent;
            assertStringIncludes(
                status,
                `已升级 动态工具 至 v${targetVersion}`,
            );
            assertStringIncludes(status, "保留原有启停状态");
            assertFalse(status.includes("卡片中启用"));
            const card = find(dom.root, "article");
            assertStringIncludes(card.textContent, `v${targetVersion}`);
            assertStringIncludes(
                card.textContent,
                enabled ? "运行中" : "已停用",
            );
            assertFalse(
                find(
                    card,
                    `button[aria-label="回滚 动态工具 至 v${currentVersion}"]`,
                ).disabled,
            );
            assertEquals(dom.navigation, []);
            assertEquals(dom.storageWrites.length, 1);
            assertStringIncludes(
                dom.storageWrites[0]!,
                "heimdall.plugins.revision=",
            );
            assertFalse(dom.storageWrites[0]!.includes(input.code));
        } finally {
            await harness.cleanup();
        }
    }
});

Deno.test("upgrade previews block old, equal, invalid and incompatible packages without a request", async () => {
    const cases: {
        current: Partial<ListedPlugin>;
        version: string;
        error: string;
    }[] = [
        { current: {}, version: "1.0.0", error: "目标版本必须高于当前版本" },
        { current: {}, version: "0.9.9", error: "目标版本必须高于当前版本" },
        {
            current: {},
            version: "1.0.0-rc.1",
            error: "目标版本必须高于当前版本",
        },
        {
            current: { version: "1.0.0+build.1" },
            version: "1.0.0+build.2",
            error: "目标版本必须高于当前版本",
        },
        { current: {}, version: "next", error: "SemVer" },
        { current: {}, version: "2.0.0\n", error: "SemVer" },
        { current: {}, version: "2.0.0-01", error: "SemVer" },
        { current: { version: "latest" }, version: "2.0.0", error: "SemVer" },
        {
            current: { revision: undefined },
            version: "2.0.0",
            error: "版本记录",
        },
        { current: { revision: " " }, version: "2.0.0", error: "版本记录" },
        {
            current: { kind: "source" },
            version: "2.0.0",
            error: "类型和运行方式",
        },
        {
            current: { trust: "trusted" },
            version: "2.0.0",
            error: "类型和运行方式",
        },
    ];
    for (const { current, version, error } of cases) {
        const harness = await setup({ plugins: [{ ...managed, ...current }] });
        const { dom } = harness;
        try {
            await dom.act(() => button(dom.root, "安装插件").click());
            await dom.act(() =>
                choose(
                    find(dom.root, 'input[type="file"]'),
                    file({
                        ...upgradeData,
                        manifest: { ...upgradeData.manifest, version },
                    }),
                )
            );
            await settle(dom);
            assertStringIncludes(
                find(dom.root, '[role="alert"]').textContent,
                error,
            );
            assert(button(dom.root, "升级插件包").disabled);
            await dom.act(() =>
                find(dom.root, "form").dispatchEvent(
                    new CustomEvent("submit", {
                        cancelable: true,
                        detail: {},
                    }),
                )
            );
            await settle(dom);
            assertEquals(harness.calls, []);
            assertEquals(harness.refreshes(), 0);
            assertEquals(harness.catalogEvents(), 0);
            assertEquals(dom.storageWrites, []);
        } finally {
            await harness.cleanup();
        }
    }
});

Deno.test("an open upgrade preview rechecks the refreshed host version before submitting", async () => {
    const harness = await setup();
    const { dom } = harness;
    try {
        await dom.act(() => button(dom.root, "安装插件").click());
        await dom.act(() =>
            choose(find(dom.root, 'input[type="file"]'), file(upgradeData))
        );
        await settle(dom);
        assertFalse(button(dom.root, "升级插件包").disabled);
        await dom.act(() =>
            harness.replace([{
                ...managed,
                version: upgradeData.manifest.version,
                revision: "revision-from-another-tab",
            }])
        );
        assertStringIncludes(
            find(dom.root, '[role="alert"]').textContent,
            "目标版本必须高于当前版本",
        );
        assert(button(dom.root, "升级插件包").disabled);
        await dom.act(() =>
            find(dom.root, "form").dispatchEvent(
                new CustomEvent("submit", {
                    cancelable: true,
                    detail: {},
                }),
            )
        );
        assertEquals(harness.calls, []);
    } finally {
        await harness.cleanup();
    }
});

Deno.test("upgrade conflicts remain actionable and completed upgrades are not repeated after refresh failure", async () => {
    for (const conflict of [true, false]) {
        const harness = await setup({
            response: () =>
                Promise.resolve(
                    conflict
                        ? Response.json({
                            error: { message: "插件 revision 已变更" },
                        }, { status: 409 })
                        : Response.json({ plugin: {} }),
                ),
            refresh: () => Promise.reject(new Error("网络中断")),
        });
        const { dom } = harness;
        try {
            await dom.act(() => button(dom.root, "安装插件").click());
            await dom.act(() =>
                choose(find(dom.root, 'input[type="file"]'), file(upgradeData))
            );
            await settle(dom);
            await dom.act(() => button(dom.root, "升级插件包").click());
            await settle(dom);
            assertStringIncludes(
                find(dom.root, '[role="alert"]').textContent,
                conflict ? "插件 revision 已变更" : "插件已升级，列表刷新失败",
            );
            assertEquals(dom.root.querySelector("dialog") !== null, conflict);
            assertEquals(harness.catalogEvents(), conflict ? 0 : 1);
            if (conflict) {
                assertFalse(button(dom.root, "升级插件包").disabled);
                assertEquals(dom.root.querySelector('[role="status"]'), null);
            } else {
                await dom.act(() =>
                    button(dom.root, "重新读取插件列表").click()
                );
                await settle(dom);
                assertEquals(harness.refreshes(), 2);
                assertEquals(harness.catalogEvents(), 1);
            }
            assertEquals(harness.calls.length, 1);
        } finally {
            await harness.cleanup();
        }
    }
});

Deno.test("rollback requires confirmation, sends one operation and refreshes the retained version", async () => {
    const current = { ...managed, rollbackVersion: "0.9.0" };
    const response = deferred<Response>();
    const updated = {
        ...current,
        version: current.rollbackVersion,
        revision: "revision-rolled-back",
        rollbackVersion: current.version,
    };
    const harness = await setup({
        plugins: [current],
        response: () => response.promise,
        refreshedPlugins: [updated],
    });
    const { dom } = harness;
    try {
        const trigger = find(
            dom.root,
            'button[aria-label="回滚 动态工具 至 v0.9.0"]',
        );
        trigger.focus();
        await dom.act(() => trigger.click());
        assertEquals(harness.calls, []);
        const dialog = find(dom.root, "dialog");
        assert(dialog.open);
        assertEquals(find(dialog, "h2").textContent, "回滚插件");
        assertStringIncludes(dialog.textContent, "当前版本：v1.0.0");
        assertStringIncludes(dialog.textContent, "目标版本：v0.9.0");
        await dom.act(() => button(dialog, "取消").click());
        assertEquals(dom.root.querySelector("dialog"), null);
        assertEquals(dom.document.activeElement, trigger);
        assertEquals(harness.calls, []);
        await dom.act(() => trigger.click());
        const confirm = button(dom.root, "确认回滚");
        await dom.act(() => {
            confirm.click();
            confirm.click();
        });
        assertEquals(harness.calls, [{
            path: "/api/admin/plugin-rollback",
            method: "POST",
            body: { pluginId: managed.id, revision: managed.revision },
        }]);
        assert(confirm.disabled);
        assertEquals(
            find(dom.root, "dialog").getAttribute("aria-busy"),
            "true",
        );
        const cancel = new Event("cancel", { cancelable: true });
        await dom.act(() => find(dom.root, "dialog").dispatchEvent(cancel));
        assert(cancel.defaultPrevented);
        assert(find(dom.root, "dialog").open);
        assertEquals(harness.catalogEvents(), 0);
        response.resolve(Response.json({ plugin: updated }));
        await settle(dom);
        assertEquals(harness.refreshes(), 1);
        assertEquals(harness.catalogEvents(), 1);
        assertEquals(dom.root.querySelector("dialog"), null);
        const status = find(dom.root, '[role="status"]').textContent;
        assertStringIncludes(status, "已将 动态工具 回滚至 v0.9.0");
        assertStringIncludes(status, "保留原有启停状态");
        const card = find(dom.root, "article");
        assertStringIncludes(card.textContent, "v0.9.0");
        assertStringIncludes(card.textContent, "运行中");
        assertFalse(
            find(card, 'button[aria-label="回滚 动态工具 至 v1.0.0"]').disabled,
        );
        assertEquals(dom.navigation, []);
        assertEquals(dom.storageWrites.length, 1);
        assertStringIncludes(
            dom.storageWrites[0]!,
            "heimdall.plugins.revision=",
        );
    } finally {
        await harness.cleanup();
    }
});

Deno.test("a changed host revision or rollback target invalidates an open rollback confirmation", async () => {
    for (
        const changed of [{ revision: "revision-new" }, {
            rollbackVersion: "0.8.0",
        }]
    ) {
        const current = { ...managed, rollbackVersion: "0.9.0" };
        const harness = await setup({ plugins: [current] });
        const { dom } = harness;
        try {
            await dom.act(() =>
                find(dom.root, 'button[aria-label="回滚 动态工具 至 v0.9.0"]')
                    .click()
            );
            await dom.act(() => harness.replace([{ ...current, ...changed }]));
            assertStringIncludes(
                find(dom.root, '[role="alert"]').textContent,
                "插件版本已发生变化",
            );
            const confirm = button(dom.root, "确认回滚");
            assert(confirm.disabled);
            await dom.act(() => confirm.dispatchEvent(new Event("click")));
            assertEquals(harness.calls, []);
            assertEquals(harness.catalogEvents(), 0);
        } finally {
            await harness.cleanup();
        }
    }
});

Deno.test("rollback errors permit retry and refresh errors do not repeat a completed rollback", async () => {
    for (const conflict of [true, false]) {
        let attempts = 0;
        const harness = await setup({
            plugins: [{ ...managed, rollbackVersion: "0.9.0" }],
            response: () =>
                Promise.resolve(
                    ++attempts === 1 && conflict
                        ? Response.json({
                            error: { message: "保留的插件包已发生变化" },
                        }, { status: 409 })
                        : Response.json({ plugin: {} }),
                ),
            refresh: () =>
                conflict
                    ? Promise.resolve()
                    : Promise.reject(new Error("网络中断")),
        });
        const { dom } = harness;
        try {
            await dom.act(() =>
                find(dom.root, 'button[aria-label="回滚 动态工具 至 v0.9.0"]')
                    .click()
            );
            await dom.act(() => button(dom.root, "确认回滚").click());
            await settle(dom);
            assertStringIncludes(
                find(dom.root, '[role="alert"]').textContent,
                conflict
                    ? "保留的插件包已发生变化"
                    : "插件已回滚，列表刷新失败",
            );
            assertEquals(dom.root.querySelector("dialog") !== null, conflict);
            assertEquals(harness.catalogEvents(), conflict ? 0 : 1);
            if (conflict) {
                assertEquals(dom.root.querySelector('[role="status"]'), null);
                assertFalse(button(dom.root, "确认回滚").disabled);
                await dom.act(() => button(dom.root, "确认回滚").click());
                await settle(dom);
                assertEquals(harness.calls.length, 2);
                assertEquals(dom.root.querySelector("dialog"), null);
                assertStringIncludes(
                    find(dom.root, '[role="status"]').textContent,
                    "回滚至 v0.9.0",
                );
            } else {
                await dom.act(() =>
                    button(dom.root, "重新读取插件列表").click()
                );
                await settle(dom);
                assertEquals(harness.calls.length, 1);
                assertEquals(harness.refreshes(), 2);
            }
            assertEquals(harness.catalogEvents(), 1);
        } finally {
            await harness.cleanup();
        }
    }
});

Deno.test("managed uninstall confirms in place, prevents duplicate submissions, and reflects the host list", async () => {
    const response = deferred<Response>();
    const harness = await setup({ response: () => response.promise });
    const { dom } = harness;
    try {
        await dom.act(() =>
            find(dom.root, 'button[aria-label="卸载 动态工具"]').click()
        );
        assertStringIncludes(
            find(dom.root, "dialog").textContent,
            "运行中的插件会先停用",
        );
        assertEquals(harness.calls, []);
        await dom.act(() => {
            button(dom.root, "确认卸载").click();
            button(dom.root, "确认卸载").click();
        });
        assertEquals(harness.calls, [{
            path: "/api/admin/plugin",
            method: "DELETE",
            body: { pluginId: managed.id },
        }]);
        response.resolve(Response.json({ removed: true }));
        await settle(dom);
        await dom.act(() => harness.replace([]));
        assertEquals(harness.refreshes(), 1);
        assertEquals(dom.root.querySelector("dialog"), null);
        assertEquals(dom.root.querySelector("article"), null);
        assertStringIncludes(
            find(dom.root, '[role="status"]').textContent,
            "已卸载 动态工具",
        );
    } finally {
        await harness.cleanup();
    }
});

Deno.test("uninstall is blocked by declared dependents including disabled plugins", async () => {
    const harness = await setup({
        plugins: [managed, {
            id: "dependent",
            name: "依赖工具",
            enabled: false,
            dependencies: [managed.id],
        }],
    });
    try {
        await harness.dom.act(() =>
            find(harness.dom.root, 'button[aria-label="卸载 动态工具"]').click()
        );
        assertStringIncludes(
            find(harness.dom.root, '[role="alert"]').textContent,
            "依赖工具",
        );
        assert(button(harness.dom.root, "确认卸载").disabled);
        assertEquals(harness.calls, []);
    } finally {
        await harness.cleanup();
    }
});

Deno.test("uninstall conflicts stay in the dialog and refresh failures do not repeat completed removal", async () => {
    for (const conflict of [true, false]) {
        const harness = await setup({
            response: () =>
                Promise.resolve(
                    conflict
                        ? Response.json({
                            error: { message: "插件被另一插件引用" },
                        }, { status: 409 })
                        : Response.json({ removed: true }),
                ),
            refresh: () => Promise.reject(new Error("网络中断")),
        });
        try {
            await harness.dom.act(() =>
                find(harness.dom.root, 'button[aria-label="卸载 动态工具"]')
                    .click()
            );
            await harness.dom.act(() =>
                button(harness.dom.root, "确认卸载").click()
            );
            await settle(harness.dom);
            assertStringIncludes(
                find(harness.dom.root, '[role="alert"]').textContent,
                conflict ? "插件被另一插件引用" : "插件已卸载，列表刷新失败",
            );
            assertEquals(
                harness.dom.root.querySelector("dialog") !== null,
                conflict,
            );
            if (!conflict) {
                await harness.dom.act(() =>
                    button(harness.dom.root, "重新读取插件列表").click()
                );
                await settle(harness.dom);
                assertEquals(harness.calls.length, 1);
                assertEquals(harness.refreshes(), 2);
            }
        } finally {
            await harness.cleanup();
        }
    }
});
