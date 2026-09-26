/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import { ChannelsPanel } from "../../src/web/client/dashboard.tsx";
import { SourceCard } from "../../src/web/components/catalog-cards.tsx";
import { configureAdminTransport } from "../../src/web/client/api/admin.ts";
import type {
    DashboardData,
    ListedSource,
} from "@heimdall/admin-contracts/console.ts";
import {
    sourceInstanceEnabled,
    sourceState,
} from "../../src/web/shared/catalog-presentation.ts";
import { installTestDom, type TestElement } from "./helpers/jsx-dom.ts";

const source: ListedSource = {
    id: "channel-1",
    name: "备用模型渠道",
    priority: 3,
    enabled: false,
    instanceEnabled: true,
    pluginEnabled: false,
    versionstamp: "revision-1",
};

function dashboard(): DashboardData {
    return {
        status: {
            sources: [{ ...source }],
            plugins: [],
            presets: [],
            managed: [],
        },
        models: [],
        health: { status: "ok" },
        authRequired: false,
        errors: { health: "", models: "", status: "", presets: "", source: "" },
    };
}

function button(root: TestElement, label: string): TestElement {
    const found = root.querySelectorAll("button").find((item) =>
        (item.getAttribute("aria-label") || item.textContent).includes(label)
    );
    assert(found, `Missing ${label}: ${root.textContent}`);
    return found;
}

Deno.test("SSR source cards expose disabled instance controls and distinguish a stopped plugin", () => {
    const html = SourceCard({ source, editing: true }).toString();
    assertStringIncludes(html, "备用模型渠道");
    assertStringIncludes(html, "channel-1");
    assertStringIncludes(html, "源插件已停用，此渠道暂不可用");
    assertStringIncludes(html, 'aria-checked="true"');
    assertStringIncludes(html, 'aria-label="管理 备用模型渠道"');
    assertStringIncludes(html, "disabled");
    assertEquals(sourceInstanceEnabled(source), true);
    assertEquals(sourceState(source).label, "插件已停用");
    assertEquals(
        sourceState({ ...source, instanceEnabled: false }).label,
        "已停用",
    );
    assertEquals(sourceInstanceEnabled({ enabled: true }), true);
});

Deno.test("channel toggle patches instance state with its revision while its plugin is disabled", async () => {
    const dom = installTestDom();
    const calls: { path: string; body: unknown; revision: string | null }[] =
        [];
    const notes: string[] = [];
    let refreshes = 0;
    configureAdminTransport((input, init) => {
        calls.push({
            path: String(input),
            body: JSON.parse(String(init?.body)),
            revision: new Headers(init?.headers).get("if-match"),
        });
        return Promise.resolve(Response.json({ ok: true }));
    });
    try {
        await dom.act(() =>
            render(
                <ChannelsPanel
                    dashboard={dashboard()}
                    onConfigure={() => {}}
                    onRefresh={() => {
                        refreshes++;
                        return Promise.resolve();
                    }}
                    onNotify={(_tone, message) => notes.push(message)}
                />,
                dom.root as unknown as HTMLElement,
            )
        );
        const toggle = dom.root.querySelector('button[role="switch"]');
        assert(toggle);
        await dom.act(() => toggle.click());
        assertEquals(calls, [{
            path: "/api/admin/sources?id=channel-1",
            body: { enabled: false },
            revision: "revision-1",
        }]);
        assertEquals(refreshes, 1);
        assertEquals(notes, ["已停用 备用模型渠道。"]);
        assertEquals(dom.navigation, []);
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        configureAdminTransport();
        dom.restore();
    }
});

Deno.test("channel toggle prevents duplicate writes and offers refresh on a version conflict", async () => {
    const dom = installTestDom();
    let resolve!: (response: Response) => void;
    let calls = 0;
    let refreshes = 0;
    configureAdminTransport(() => {
        calls++;
        return new Promise<Response>((done) => {
            resolve = done;
        });
    });
    try {
        await dom.act(() =>
            render(
                <ChannelsPanel
                    dashboard={dashboard()}
                    onConfigure={() => {}}
                    onRefresh={() => {
                        refreshes++;
                        return Promise.resolve();
                    }}
                />,
                dom.root as unknown as HTMLElement,
            )
        );
        const toggle = dom.root.querySelector('button[role="switch"]');
        assert(toggle);
        await dom.act(() => {
            toggle.click();
            toggle.click();
        });
        assertEquals(calls, 1);
        assertEquals(toggle.disabled, true);
        await dom.act(() =>
            resolve(
                Response.json({
                    error: { code: "conflict", message: "changed" },
                }, {
                    status: 409,
                    headers: { "x-heimdall-request-id": "conflict-id" },
                }),
            )
        );
        assertEquals(toggle.getAttribute("aria-checked"), "true");
        assertStringIncludes(dom.root.textContent, "渠道已被修改");
        assertStringIncludes(dom.root.textContent, "conflict-id");
        await dom.act(() => button(dom.root, "刷新渠道列表").click());
        assertEquals(refreshes, 1);
        assertEquals(calls, 1);
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        configureAdminTransport();
        dom.restore();
    }
});

Deno.test("channel management launches an in-place dialog and refreshes only after save", async () => {
    const dom = installTestDom();
    const calls: { method?: string; body: unknown }[] = [];
    const notes: string[] = [];
    let refreshes = 0;
    configureAdminTransport((_input, init) => {
        calls.push({
            method: init?.method,
            body: JSON.parse(String(init?.body)),
        });
        return Promise.resolve(Response.json({ ok: true }));
    });
    try {
        await dom.act(() =>
            render(
                <ChannelsPanel
                    dashboard={dashboard()}
                    onConfigure={() => {}}
                    onRefresh={() => {
                        refreshes++;
                        return Promise.resolve();
                    }}
                    onNotify={(_tone, message) => notes.push(message)}
                />,
                dom.root as unknown as HTMLElement,
            )
        );
        await dom.act(() => button(dom.root, "管理").click());
        const dialog = dom.root.querySelector("dialog");
        assert(dialog?.open);
        assertEquals(refreshes, 0);
        const name = dialog.querySelector('input[name="source-name"]');
        assert(name);
        await dom.act(() => {
            name.value = "备用渠道 · 东京";
            name.dispatchEvent(new Event("input"));
        });
        await dom.act(() => button(dialog, "保存修改").click());
        assertEquals(calls, [{
            method: "PATCH",
            body: { name: "备用渠道 · 东京" },
        }]);
        assertEquals(refreshes, 1);
        assertEquals(dom.root.querySelector("dialog"), null);
        assertEquals(notes, ["已保存 备用渠道 · 东京。"]);
        assertEquals(dom.navigation, []);
        assertEquals(dom.storageWrites, []);
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        configureAdminTransport();
        dom.restore();
    }
});

Deno.test("empty channels opens creation and never configures an invented default source", async () => {
    const dom = installTestDom();
    const empty = dashboard();
    empty.status.sources = [];
    let adds = 0;
    let configurations = 0;
    try {
        await dom.act(() =>
            render(
                <ChannelsPanel
                    dashboard={empty}
                    onAdd={() => adds++}
                    onConfigure={() => configurations++}
                    onRefresh={() => Promise.resolve()}
                />,
                dom.root as unknown as HTMLElement,
            )
        );
        await dom.act(() => button(dom.root, "添加渠道").click());
        assertEquals(adds, 1);
        assertEquals(configurations, 0);
        await dom.act(() =>
            render(
                <ChannelsPanel
                    dashboard={empty}
                    onConfigure={() => configurations++}
                    onRefresh={() => Promise.resolve()}
                />,
                dom.root as unknown as HTMLElement,
            )
        );
        assertEquals(button(dom.root, "添加渠道").disabled, true);
        await dom.act(() => button(dom.root, "添加渠道").click());
        assertEquals(configurations, 0);
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        dom.restore();
    }
});
