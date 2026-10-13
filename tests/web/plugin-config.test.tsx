/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import {
    assert,
    assertEquals,
    assertFalse,
    assertStringIncludes,
} from "@std/assert";
import { render } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import type { ListedPlugin } from "@heimdall/admin-contracts/console.ts";
import type { ToolConfigDto } from "@heimdall/admin-contracts";
import { projectListedPlugins } from "@heimdall/admin-contracts/plugin-catalog.ts";
import { configureAdminTransport } from "@heimdall/core/web/client/api/transport.ts";
import { PluginsPanel } from "@heimdall/core/web/client/plugins.tsx";
import { PluginCards } from "@heimdall/core/web/components/catalog-cards.tsx";
import { PLUGIN_CATALOG_CHANGED } from "@heimdall/core/web/client/plugin-events.ts";
import { installTestDom, type TestElement } from "./helpers/jsx-dom.ts";

const plugin: ListedPlugin = {
    id: "example.files",
    name: "文件工具",
    kind: "tool",
    enabled: true,
    canConfigure: true,
};
const dto: ToolConfigDto = {
    pluginId: plugin.id,
    config: { directory: "/projects/initial", preview: false },
    revision: "config-v1",
    configSchema: {
        version: 1,
        id: "example.files.config",
        fields: [
            {
                type: "string",
                name: "directory",
                label: "目录",
                help: "可留空",
            },
            {
                type: "bool",
                name: "preview",
                label: "预览模式",
                default: false,
            },
        ],
    },
};

function find(root: TestElement, selector: string): TestElement {
    const found = root.querySelector(selector);
    assert(found, `Missing ${selector}: ${root.textContent}`);
    return found;
}
function button(root: TestElement, label: string): TestElement {
    const found = root.querySelectorAll("button").find((item) =>
        item.textContent === label
    );
    assert(found, `Missing button ${label}: ${root.textContent}`);
    return found;
}
function input(root: TestElement, name: string, value: string) {
    const field = find(root, `input[name="${name}"]`);
    field.value = value;
    field.dispatchEvent(new Event("input"));
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
    response?: (path: string, init?: RequestInit) => Promise<Response>;
    refresh?: () => Promise<void>;
} = {}) {
    const dom = installTestDom();
    const calls: {
        path: string;
        method: string;
        body: unknown;
        signal: AbortSignal | null | undefined;
    }[] = [];
    let refreshes = 0;
    let events = 0;
    const catalogChanged = () => events++;
    globalThis.addEventListener(PLUGIN_CATALOG_CHANGED, catalogChanged);
    configureAdminTransport((path, init) => {
        calls.push({
            path: String(path),
            method: init?.method ?? "GET",
            body: init?.body ? JSON.parse(String(init.body)) : null,
            signal: init?.signal,
        });
        return options.response?.(String(path), init) ??
            Promise.resolve(Response.json(dto));
    });
    await dom.act(() =>
        render(
            <PluginsPanel
                plugins={[plugin]}
                loadError=""
                onRefresh={async () => {
                    refreshes++;
                    await options.refresh?.();
                }}
            />,
            dom.root as unknown as HTMLElement,
        )
    );
    return {
        dom,
        calls,
        refreshes: () => refreshes,
        events: () => events,
        async open() {
            const trigger = find(
                dom.root,
                'button[aria-label="配置 文件工具"]',
            );
            trigger.focus();
            await dom.act(() => trigger.click());
            await settle(dom);
            return trigger;
        },
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

Deno.test("SSR configuration actions and catalog projection use only the host grant", () => {
    const plugins = projectListedPlugins([
        plugin,
        { ...plugin, id: "false", name: "不支持", canConfigure: false },
        { ...plugin, id: "malformed", name: "错误声明", canConfigure: "true" },
        { id: "heimdall.tool.workspace", name: "无声明工作区", kind: "tool" },
    ]);
    assertEquals(plugins.map((item) => item.canConfigure), [
        true,
        false,
        undefined,
        undefined,
    ]);
    const html = PluginCards({ plugins }).toString();
    const action = html.match(/<button\b[^>]*aria-label="配置 文件工具"[^>]*>/)
        ?.[0];
    assert(action);
    assertStringIncludes(action, "disabled");
    for (const label of ["不支持", "错误声明", "无声明工作区"]) {
        assertFalse(html.includes(`aria-label="配置 ${label}"`));
    }
});

Deno.test("plugin configuration loads its schema, prevents duplicate saves, and refreshes after saving", async () => {
    const saving = deferred<Response>();
    const harness = await setup({
        response: (_path, init) =>
            init?.method === "PUT"
                ? saving.promise
                : Promise.resolve(Response.json(dto)),
    });
    const { dom, calls } = harness;
    try {
        await harness.open();
        const dialog = find(dom.root, "dialog");
        assert(dialog.open);
        assertEquals(
            find(dialog, 'input[name="directory"]').value,
            "/projects/initial",
        );
        assertStringIncludes(dialog.textContent, "可留空");
        await dom.act(() => input(dialog, "directory", "/projects/next"));
        await dom.act(() => find(dialog, 'button[role="switch"]').click());
        const save = button(dialog, "保存配置");
        await dom.act(() => {
            save.click();
            save.click();
        });
        assertEquals(calls.map((call) => call.method), ["GET", "PUT"]);
        assertEquals(calls[1]?.body, {
            pluginId: plugin.id,
            config: { directory: "/projects/next", preview: true },
            revision: "config-v1",
        });
        assertEquals(dialog.getAttribute("aria-busy"), "true");
        assert(button(dialog, "取消").disabled);
        assert(find(dialog, 'input[name="directory"]').disabled);
        const cancel = new Event("cancel", { cancelable: true });
        await dom.act(() => dialog.dispatchEvent(cancel));
        assert(cancel.defaultPrevented);
        assert(dialog.open);
        saving.resolve(Response.json({ ...dto, revision: "config-v2" }));
        await settle(dom);
        assertEquals(dom.root.querySelector("dialog"), null);
        assertEquals(harness.refreshes(), 1);
        assertEquals(harness.events(), 1);
        assertStringIncludes(dom.root.textContent, "已保存 文件工具 的配置");
    } finally {
        await harness.cleanup();
    }
});

Deno.test("closing a loading configuration cancels its read and restores focus without applying late data", async () => {
    const loading = deferred<Response>();
    const harness = await setup({ response: () => loading.promise });
    const { dom, calls } = harness;
    try {
        const trigger = await harness.open();
        const dialog = find(dom.root, "dialog");
        assertStringIncludes(dialog.textContent, "正在加载插件配置");
        assert(button(dialog, "保存配置").disabled);
        assertFalse(button(dialog, "取消").disabled);
        await dom.act(() =>
            dialog.dispatchEvent(new Event("cancel", { cancelable: true }))
        );
        assertEquals(dom.root.querySelector("dialog"), null);
        assertEquals(dom.document.activeElement, trigger);
        assert(calls[0]?.signal?.aborted);
        loading.resolve(Response.json(dto));
        await settle(dom);
        assertEquals(dom.root.querySelector("dialog"), null);
        assertEquals(calls.length, 1);
        assertEquals(harness.events(), 0);
    } finally {
        await harness.cleanup();
    }
});

Deno.test("configuration conflicts preserve the draft and require an explicit reload before retrying", async () => {
    let reads = 0;
    let writes = 0;
    const harness = await setup({
        response: (_path, init) =>
            Promise.resolve(
                init?.method === "PUT"
                    ? ++writes === 1
                        ? Response.json({ error: { message: "stale" } }, {
                            status: 409,
                        })
                        : Response.json({ ...dto, revision: "config-v3" })
                    : Response.json(
                        ++reads === 1 ? dto : {
                            ...dto,
                            config: {
                                directory: "/projects/other",
                                preview: true,
                            },
                            revision: "config-v2",
                        },
                    ),
            ),
    });
    const { dom, calls } = harness;
    try {
        await harness.open();
        await dom.act(() => input(dom.root, "directory", "/projects/draft"));
        await dom.act(() => button(dom.root, "保存配置").click());
        await settle(dom);
        assertStringIncludes(
            find(dom.root, '[role="alert"]').textContent,
            "当前编辑内容已保留",
        );
        assertEquals(
            find(dom.root, 'input[name="directory"]').value,
            "/projects/draft",
        );
        assert(button(dom.root, "保存配置").disabled);
        await dom.act(() => button(dom.root, "保存配置").click());
        assertEquals(writes, 1);
        assertEquals(reads, 1);
        assertEquals(harness.events(), 0);
        await dom.act(() => button(dom.root, "重新加载配置").click());
        await settle(dom);
        assertEquals(
            find(dom.root, 'input[name="directory"]').value,
            "/projects/other",
        );
        assertFalse(button(dom.root, "保存配置").disabled);
        await dom.act(() => button(dom.root, "保存配置").click());
        await settle(dom);
        assertEquals(calls.at(-1)?.body, {
            pluginId: plugin.id,
            config: { directory: "/projects/other", preview: true },
            revision: "config-v2",
        });
        assertEquals(harness.refreshes(), 1);
        assertEquals(harness.events(), 1);
    } finally {
        await harness.cleanup();
    }
});

Deno.test("configuration load failures can retry and validation failures keep the entered values", async () => {
    let reads = 0;
    const harness = await setup({
        response: (_path, init) =>
            Promise.resolve(
                init?.method === "PUT"
                    ? Response.json({ error: { message: "目录不存在" } }, {
                        status: 400,
                    })
                    : ++reads === 1
                    ? Response.json({ error: { message: "暂时不可用" } }, {
                        status: 503,
                    })
                    : Response.json(dto),
            ),
    });
    const { dom } = harness;
    try {
        await harness.open();
        assertStringIncludes(
            find(dom.root, '[role="alert"]').textContent,
            "暂时不可用",
        );
        assert(button(dom.root, "保存配置").disabled);
        await dom.act(() => button(dom.root, "重新加载配置").click());
        await settle(dom);
        await dom.act(() => input(dom.root, "directory", "/missing"));
        await dom.act(() => button(dom.root, "保存配置").click());
        await settle(dom);
        assertStringIncludes(
            find(dom.root, '[role="alert"]').textContent,
            "目录不存在",
        );
        assertEquals(
            find(dom.root, 'input[name="directory"]').value,
            "/missing",
        );
        assertFalse(button(dom.root, "保存配置").disabled);
        assertEquals(harness.refreshes(), 0);
        assertEquals(harness.events(), 0);
    } finally {
        await harness.cleanup();
    }
});

Deno.test("clearing optional fields sends only declared values without resending redacted secrets", async () => {
    const payload = {
        ...dto,
        config: { ...dto.config, hidden: { keep: true }, token: "[REDACTED]" },
        configSchema: {
            ...dto.configSchema,
            fields: [
                ...(dto.configSchema.fields as readonly unknown[]),
                {
                    type: "secret",
                    name: "token",
                    label: "密钥",
                    required: true,
                },
            ],
        },
    };
    const harness = await setup({
        response: () => Promise.resolve(Response.json(payload)),
    });
    const { dom, calls } = harness;
    try {
        await harness.open();
        assertEquals(find(dom.root, 'input[name="token"]').value, "");
        assertStringIncludes(dom.root.textContent, "已配置，留空保留原值");
        await dom.act(() => input(dom.root, "directory", ""));
        await dom.act(() => button(dom.root, "保存配置").click());
        await settle(dom);
        assertEquals(calls.at(-1)?.body, {
            pluginId: plugin.id,
            config: { preview: false },
            revision: "config-v1",
        });
    } finally {
        await harness.cleanup();
    }
});

Deno.test("schema validation blocks malformed controls and invalid numeric input before saving", async () => {
    for (const invalidSchema of [true, false]) {
        const harness = await setup({
            response: () =>
                Promise.resolve(Response.json({
                    ...dto,
                    config: {},
                    configSchema: {
                        version: 1,
                        id: "example.numeric",
                        fields: [{
                            type: invalidSchema ? "execute" : "number",
                            name: "limit",
                            label: "数量",
                            required: true,
                            integer: true,
                            min: 1,
                        }],
                    },
                })),
        });
        const { dom, calls } = harness;
        try {
            await harness.open();
            if (invalidSchema) {
                assertStringIncludes(
                    find(dom.root, '[role="alert"]').textContent,
                    "加载插件配置失败",
                );
                assert(button(dom.root, "保存配置").disabled);
            } else {
                await dom.act(() => input(dom.root, "limit", "0"));
                await dom.act(() => button(dom.root, "保存配置").click());
                await settle(dom);
                assertStringIncludes(
                    find(dom.root, '[role="alert"]').textContent,
                    "不能小于 1",
                );
            }
            assertEquals(calls.length, 1);
        } finally {
            await harness.cleanup();
        }
    }
});

Deno.test("a catalog refresh failure after saving can retry without repeating the mutation", async () => {
    const harness = await setup({
        refresh: () => Promise.reject(new Error("离线")),
    });
    const { dom, calls } = harness;
    try {
        await harness.open();
        await dom.act(() => button(dom.root, "保存配置").click());
        await settle(dom);
        assertEquals(dom.root.querySelector("dialog"), null);
        assertStringIncludes(
            find(dom.root, '[role="alert"]').textContent,
            "插件配置已保存，列表刷新失败",
        );
        await dom.act(() => button(dom.root, "重新读取插件列表").click());
        await settle(dom);
        assertEquals(calls.filter((call) => call.method === "PUT").length, 1);
        assertEquals(harness.events(), 1);
        assertEquals(harness.refreshes(), 2);
    } finally {
        await harness.cleanup();
    }
});
