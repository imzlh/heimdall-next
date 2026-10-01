/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { render, useState } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import type { RuntimeSettingsEnvelope } from "@heimdall/admin-contracts/console.ts";
import { configureAdminTransport } from "@heimdall/core/web/client/api/admin.ts";
import { RuntimeSettingsPanel } from "@heimdall/core/web/client/settings.tsx";
import { installTestDom, type TestElement } from "./helpers/jsx-dom.ts";

const initial: RuntimeSettingsEnvelope = {
    settings: {
        proxyKeyConfigured: false,
        limitPerMinute: 120,
        probeIntervalMs: 300_000,
        titleModel: "",
        requestRetentionDays: 30,
        chatRetentionDays: 90,
    },
    etag: '"retention-1"',
    maintenance: {
        enabled: true,
        running: false,
        lastRunAt: "2026-09-29T00:00:00.000Z",
        nextRunAt: "2026-09-29T01:00:00.000Z",
        prunedRequests: 12,
        prunedConversations: 3,
        prunedAssets: 5,
        lastError: null,
    },
};

function find(root: TestElement, selector: string): TestElement {
    const item = root.querySelector(selector);
    assert(item, `Missing ${selector}: ${root.textContent}`);
    return item;
}

function button(root: TestElement, label: string): TestElement {
    const item = root.querySelectorAll("button").find((item) =>
        item.textContent.trim() === label ||
        item.getAttribute("aria-label") === label
    );
    assert(item, `Missing button ${label}: ${root.textContent}`);
    return item;
}

async function setup(
    respond?: (init: RequestInit, call: number) => Response | Promise<Response>,
) {
    const dom = installTestDom();
    const requests: RequestInit[] = [];
    let unmount = () => {};
    configureAdminTransport((path, init = {}) => {
        assertEquals(path, "/api/admin/settings");
        requests.push(init);
        if (respond) return Promise.resolve(respond(init, requests.length));
        return Promise.resolve(Response.json({
            settings: {
                ...initial.settings,
                ...JSON.parse(String(init.body ?? "{}")),
            },
            maintenance: initial.maintenance,
        }, { headers: { etag: '"retention-2"' } }));
    });
    function App() {
        const [active, setActive] = useState(true);
        unmount = () => setActive(false);
        return active ? <RuntimeSettingsPanel initial={initial} /> : null;
    }
    await dom.act(() => render(<App />, dom.root as unknown as HTMLElement));
    return {
        ...dom,
        requests,
        field(name: string) {
            return find(dom.root, `[name="${name}"]`);
        },
        async edit(name: string, value: string) {
            await dom.act(() => {
                const field = find(dom.root, `[name="${name}"]`);
                field.value = value;
                field.dispatchEvent(new Event("input"));
            });
        },
        async click(label: string) {
            await dom.act(() => button(dom.root, label).click());
        },
        async dispose() {
            try {
                await dom.act(unmount);
            } finally {
                configureAdminTransport();
                dom.restore();
            }
        },
    };
}

Deno.test("retention settings show cleanup results and save only changed policies with the settings revision", async () => {
    const test = await setup();
    try {
        assertEquals(test.field("requestRetentionDays").value, "30");
        assertEquals(test.field("chatRetentionDays").value, "90");
        assertStringIncludes(test.root.textContent, "自动清理已启用");
        assertStringIncludes(test.root.textContent, "12 条请求记录");
        assertStringIncludes(test.root.textContent, "3 个对话");
        assertStringIncludes(test.root.textContent, "5 个附件");
        assertStringIncludes(test.root.textContent, "2026-09-29 01:00:00 UTC");
        assertStringIncludes(test.root.textContent, "没有引用且上传租约已到期");
        await test.edit("requestRetentionDays", "0");
        assertStringIncludes(test.root.textContent, "有未保存的更改");
        await test.click("保存设置");
        assertEquals(test.requests.length, 1);
        assertEquals(
            new Headers(test.requests[0]!.headers).get("if-match"),
            initial.etag,
        );
        assertEquals(JSON.parse(String(test.requests[0]!.body)), {
            limitPerMinute: 120,
            probeIntervalMs: 300_000,
            requestRetentionDays: 0,
        });
        assertEquals(test.field("requestRetentionDays").value, "0");
        assertEquals(test.field("chatRetentionDays").value, "90");
        assertEquals(test.root.textContent.includes("有未保存的更改"), false);
        assertEquals(test.storageWrites, []);
    } finally {
        await test.dispose();
    }
});

Deno.test("invalid retention intervals never reach the API", async () => {
    const test = await setup();
    try {
        for (const value of ["", "-1", "1.5", "3651"]) {
            await test.edit("requestRetentionDays", value);
            await test.click("保存设置");
            assertStringIncludes(
                test.root.textContent,
                "请求记录保留天数必须是 0 到 3650 的整数",
            );
        }
        await test.edit("requestRetentionDays", "3650");
        await test.edit("chatRetentionDays", "-2");
        await test.click("保存设置");
        assertStringIncludes(
            test.root.textContent,
            "对话保留天数必须是 0 到 3650 的整数",
        );
        assertEquals(test.requests.length, 0);
    } finally {
        await test.dispose();
    }
});

Deno.test("a failed retention save preserves both drafts and retries with the same revision", async () => {
    const test = await setup((init, call) =>
        call === 1
            ? Response.json({ error: { message: "暂时不可用" } }, {
                status: 503,
            })
            : Response.json({
                settings: {
                    ...initial.settings,
                    ...JSON.parse(String(init.body)),
                },
                maintenance: {
                    ...initial.maintenance,
                    lastError: "附件清理失败，将在下次任务重试",
                },
            }, { headers: { etag: '"retention-2"' } })
    );
    try {
        await test.edit("requestRetentionDays", "7");
        await test.edit("chatRetentionDays", "14");
        await test.click("保存设置");
        assertEquals(test.field("requestRetentionDays").value, "7");
        assertEquals(test.field("chatRetentionDays").value, "14");
        assertStringIncludes(test.root.textContent, "保存运行设置失败");
        await test.click("保存设置");
        assertEquals(test.requests.length, 2);
        assertEquals(test.requests[0]!.body, test.requests[1]!.body);
        assertEquals(
            new Headers(test.requests[1]!.headers).get("if-match"),
            initial.etag,
        );
        assertStringIncludes(test.root.textContent, "上次清理失败");
        assertStringIncludes(
            test.root.textContent,
            "附件清理失败，将在下次任务重试",
        );
    } finally {
        await test.dispose();
    }
});

Deno.test("a retention revision conflict retains drafts until explicit reload and cannot overwrite concurrent settings", async () => {
    const test = await setup((init) =>
        init.method === "PUT"
            ? Response.json({ error: { message: "冲突" } }, { status: 412 })
            : Response.json({
                settings: { ...initial.settings, requestRetentionDays: 180 },
                maintenance: initial.maintenance,
            }, { headers: { etag: '"retention-3"' } })
    );
    try {
        await test.edit("requestRetentionDays", "7");
        await test.click("保存设置");
        assertEquals(test.field("requestRetentionDays").value, "7");
        assertEquals(button(test.root, "保存设置").disabled, true);
        await test.click("保存设置");
        assertEquals(test.requests.length, 1);
        await test.click("重新加载（丢弃更改）");
        assertEquals(test.field("requestRetentionDays").value, "180");
        assertEquals(button(test.root, "保存设置").disabled, false);
        assertEquals(test.root.textContent.includes("有未保存的更改"), false);
    } finally {
        await test.dispose();
    }
});
