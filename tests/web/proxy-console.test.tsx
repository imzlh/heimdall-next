/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { render, useState } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import {
    Console,
    type ConsoleProps,
} from "@heimdall/core/web/client/console.tsx";
import { configureAdminTransport } from "@heimdall/core/web/client/api/admin.ts";
import type { ProxyPoolView } from "@heimdall/admin-contracts/proxies.ts";
import { sourceConfigSchema } from "@heimdall/core/web/shared/source-schemas.ts";
import { installTestDom, type TestElement } from "./helpers/jsx-dom.ts";

const sourcePluginId = "heimdall.source.openai-compatible";
const pool: ProxyPoolView = {
    defaultProxyId: "office",
    entries: [{
        id: "office",
        name: "办公室代理",
        url: "http://localhost:7890/",
        enabled: true,
        authConfigured: true,
    }],
};
const initial: NonNullable<ConsoleProps["initial"]> = {
    health: { status: "ok" },
    models: [],
    authRequired: false,
    status: {
        sources: [{
            id: "primary",
            name: "主力渠道",
            priority: 0,
            sourcePluginId,
            proxy: { mode: "inherit" },
            versionstamp: '"source-1"',
        }],
        plugins: [{ id: sourcePluginId, kind: "source", enabled: true }],
        managed: [],
        presets: [],
    },
    errors: { health: "", models: "", source: "", status: "", presets: "" },
};
const panels: NonNullable<ConsoleProps["initialPanels"]> = {
    proxies: { pool, etag: '"pool-1"' },
    settings: {
        settings: {
            proxyKeyConfigured: false,
            limitPerMinute: 0,
            probeIntervalMs: 0,
        },
        etag: '"settings-1"',
    },
    requests: [],
    usage: {},
    errors: { requests: "", usage: "", settings: "", proxies: "" },
};

function find(root: TestElement, selector: string): TestElement {
    const element = root.querySelector(selector);
    assert(element, `Missing ${selector}: ${root.textContent}`);
    return element;
}
function button(root: TestElement, label: string): TestElement {
    const element = root.querySelectorAll("button").find((entry) =>
        entry.textContent.includes(label) ||
        entry.getAttribute("aria-label") === label
    );
    assert(element, `Missing ${label}: ${root.textContent}`);
    return element;
}
function input(element: TestElement, value: string) {
    element.value = value;
    element.dispatchEvent(new Event("input"));
}

async function setup(page: ConsoleProps["page"], initialPanels = panels) {
    const dom = installTestDom();
    Object.defineProperties(dom.document, {
        documentElement: { value: { dataset: {} } },
        querySelector: {
            value: (selector: string) => dom.root.querySelector(selector),
        },
        querySelectorAll: {
            value: (selector: string) => dom.root.querySelectorAll(selector),
        },
        addEventListener: { value: () => {} },
        removeEventListener: { value: () => {} },
    });
    const calls: { path: string; init?: RequestInit }[] = [];
    let nextPool = pool;
    configureAdminTransport((request, init) => {
        const path = String(request);
        calls.push({ path, init });
        const payload = path === "/api/admin/proxies"
            ? { pool: nextPool }
            : path === "/health"
            ? initial.health
            : path === "/api/admin/status"
            ? initial.status
            : path === "/api/admin/plugins"
            ? { plugins: initial.status.plugins }
            : path === "/api/admin/sources"
            ? { sources: initial.status.sources }
            : path === "/api/admin/presets"
            ? { presets: [] }
            : path === "/api/admin/models"
            ? { data: [] }
            : { updated: true };
        return Promise.resolve(
            Response.json(payload, { headers: { etag: '"pool-2"' } }),
        );
    });
    let unmount = () => {};
    function App() {
        const [active, setActive] = useState(true);
        unmount = () => setActive(false);
        return active
            ? (
                <Console
                    page={page}
                    initial={initial}
                    initialPanels={initialPanels}
                    authenticated
                    schemas={{
                        [sourcePluginId]: sourceConfigSchema(sourcePluginId),
                    }}
                    sourcePluginIds={{ primary: sourcePluginId }}
                />
            )
            : null;
    }
    await dom.act(() => render(<App />, dom.root as unknown as HTMLElement));
    return {
        ...dom,
        calls,
        setPool: (value: ProxyPoolView) => nextPool = value,
        async dispose() {
            await dom.act(unmount);
            configureAdminTransport();
            dom.restore();
        },
    };
}

Deno.test("console mounts the editable proxy pool from the SSR snapshot and preserves its ETag", async () => {
    const test = await setup("settings");
    try {
        assert(test.root.textContent.includes("出站代理池"));
        assert(test.root.textContent.includes("办公室代理"));
        assertEquals(test.calls, []);
        await test.act(() => button(test.root, "编辑 办公室代理").click());
        await test.act(() =>
            input(
                find(test.root, 'input[name="proxy-name-office"]'),
                "更新代理",
            )
        );
        await test.act(() => button(test.root, "保存代理池").click());
        assertEquals(test.calls.length, 1);
        assertEquals(test.calls[0]!.path, "/api/admin/proxies");
        assertEquals(
            new Headers(test.calls[0]!.init?.headers).get("if-match"),
            '"pool-1"',
        );
        const body = JSON.parse(String(test.calls[0]!.init?.body));
        assertEquals(body.entries[0].name, "更新代理");
        assertEquals(body.entries[0].basicAuth, undefined);
        assert(
            test.storageWrites.every((item) =>
                item.startsWith("heimdall.theme=")
            ),
        );
    } finally {
        await test.dispose();
    }
});

Deno.test("channel console supplies the same pool to create and management dialogs without leaving the modal", async () => {
    const test = await setup("channels");
    try {
        assert(test.root.textContent.includes("代理：继承全局 · 办公室代理"));
        assertEquals(test.calls, []);
        await test.act(() => button(test.root, "管理 主力渠道").click());
        const management = find(test.root, "dialog");
        const options = find(management, 'select[name="source-proxy"]')
            .querySelectorAll("option").map((option) =>
                option.getAttribute("value")
            );
        assertEquals(options, ["inherit", "direct", "proxy:office"]);
        await test.act(() => button(management, "取消").click());
        await test.act(() => button(test.root, "添加渠道").click());
        const creation = find(test.root, "dialog");
        assertEquals(
            find(creation, 'select[name="source-proxy"]').querySelectorAll(
                "option",
            ).map((option) => option.getAttribute("value")),
            options,
        );
        await test.act(() =>
            input(find(creation, 'select[name="source-proxy"]'), "proxy:office")
        );
        await test.act(() =>
            input(creation.querySelectorAll("input")[0]!, "新渠道")
        );
        await test.act(() => button(creation, "下一步").click());
        await test.act(() => button(creation, "自定义配置").click());
        assertStrictEquals(find(test.root, "dialog"), creation);
        assert(creation.textContent.includes("指定代理 · 办公室代理"));
        assertEquals(creation.showModalCalls, 1);
        assertEquals(test.navigation, []);
    } finally {
        await test.dispose();
    }
});

Deno.test("channel refresh updates available proxies and inherited summaries without changing an open choice", async () => {
    const test = await setup("channels");
    try {
        await test.act(() => button(test.root, "管理 主力渠道").click());
        const dialog = find(test.root, "dialog");
        await test.act(() =>
            input(find(dialog, 'select[name="source-proxy"]'), "direct")
        );
        test.setPool({
            defaultProxyId: "edge",
            entries: [{ ...pool.entries[0]!, enabled: false }, {
                ...pool.entries[0]!,
                id: "edge",
                name: "新默认代理",
            }],
        });
        await test.act(() => button(test.root, "刷新").click());
        await test.act();
        assertEquals(
            test.calls.filter((call) => call.path === "/api/admin/proxies")
                .length,
            1,
        );
        assert(test.root.textContent.includes("代理：继承全局 · 新默认代理"));
        assertEquals(
            find(dialog, 'select[name="source-proxy"]').value,
            "direct",
        );
        assert(find(dialog, 'option[value="proxy:office"]').disabled);
        assertEquals(
            find(dialog, 'option[value="proxy:edge"]').textContent,
            "新默认代理",
        );
    } finally {
        await test.dispose();
    }
});

Deno.test("channel console loads the pool when no SSR proxy snapshot was available", async () => {
    const test = await setup("channels", { ...panels, proxies: null });
    try {
        assertEquals(test.calls.map((call) => call.path), [
            "/api/admin/proxies",
        ]);
        assert(test.root.textContent.includes("代理：继承全局 · 办公室代理"));
    } finally {
        await test.dispose();
    }
});
