/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import {
    assert,
    assertEquals,
    assertFalse,
    assertRejects,
    assertStringIncludes,
} from "@std/assert";
import { render, useState } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import type {
    DashboardData,
    ListedSource,
} from "@heimdall/admin-contracts/console.ts";
import { readSourceCooldown } from "@heimdall/admin-contracts/source-health.ts";
import { SourceCard } from "@heimdall/core/web/components/catalog-cards.tsx";
import { ChannelsPanel } from "@heimdall/core/web/client/dashboard.tsx";
import {
    AdminApiError,
    clearSourceCooldown,
    configureAdminTransport,
} from "@heimdall/core/web/client/api/admin.ts";
import { sourceState } from "@heimdall/core/web/shared/catalog-presentation.ts";
import {
    cooldownRemaining,
    SOURCE_RECOVERY_NOTE,
} from "@heimdall/core/web/shared/source-health.tsx";
import { loadConsoleSnapshot } from "@heimdall/core/web/server/snapshot.ts";
import { installTestDom, type TestElement } from "./helpers/jsx-dom.ts";

const source: ListedSource = {
    id: "channel-health",
    name: "测试渠道",
    enabled: true,
    health: "cooldown",
    cooldown: {
        reason: "authentication",
        startedAt: "2026-09-29T00:00:00.000Z",
        until: "2026-09-29T00:05:00.000Z",
    },
    probe: { ok: false, message: "连接失败" },
};

function dashboard(channels: ListedSource[]): DashboardData {
    return {
        health: { status: "ok" },
        models: [],
        authRequired: false,
        status: { sources: channels, plugins: [], presets: [], managed: [] },
        errors: { health: "", models: "", status: "", presets: "", source: "" },
    };
}

function resetButton(root: TestElement): TestElement {
    const found = root.querySelectorAll("button").find((item) =>
        item.textContent.trim() === "解除冷却"
    );
    assert(found, root.textContent);
    return found;
}

Deno.test("SSR channels explain cooldown reason and deadline without claiming successful verification", () => {
    const html = SourceCard({ source, editing: true }).toString();
    assertStringIncludes(html, "冷却中");
    assertStringIncludes(html, "上游认证失败");
    assertStringIncludes(html, 'datetime="2026-09-29T00:05:00.000Z"');
    assertStringIncludes(html, "2026-09-29 00:05:00 UTC");
    assertStringIncludes(html, SOURCE_RECOVERY_NOTE);
    assertStringIncludes(html, "解除冷却");
    assertStringIncludes(html, "disabled");
    assertFalse(html.includes("最近探测通过"));
    assertEquals(
        sourceState({ enabled: true, health: "ready" }).label,
        "已启用",
    );
    assertEquals(
        sourceState({ ...source, health: "ready", cooldown: undefined }).label,
        "探测异常",
    );
    assertEquals(
        cooldownRemaining(
            source.cooldown!.until,
            Date.parse("2026-09-29T00:04:01Z"),
        ),
        "约 59 秒后自动解除",
    );
    assertEquals(
        cooldownRemaining(
            source.cooldown!.until,
            Date.parse("2026-09-29T00:05:00Z"),
        ),
        "冷却时间已到，可刷新状态",
    );
});

Deno.test("SSR health projection accepts only host categories and timestamps and drops unknown payload fields", async () => {
    for (
        const malformed of [
            null,
            {},
            { ...source.cooldown, reason: "<secret>" },
            { ...source.cooldown, until: "<script>" },
            { ...source.cooldown, reason: { toString: "broken" } },
        ]
    ) {
        assertEquals(readSourceCooldown(malformed), undefined);
    }
    const snapshot = await loadConsoleSnapshot({
        authorized: true,
        includeActivity: false,
        dispatch(request) {
            return Response.json(
                new URL(request.url).pathname === "/api/admin/status"
                    ? {
                        sources: [{
                            ...source,
                            cooldown: {
                                ...source.cooldown,
                                privateError: "UPSTREAM-SECRET",
                            },
                        }],
                    }
                    : {},
            );
        },
    });
    assertEquals(
        snapshot.dashboard.status.sources[0]?.cooldown,
        source.cooldown,
    );
    assertFalse(JSON.stringify(snapshot).includes("UPSTREAM-SECRET"));
});

Deno.test("channel cooldown reset prevents duplicates, refreshes and preserves the failed probe", async () => {
    const dom = installTestDom();
    const calls: unknown[] = [];
    const notes: string[] = [];
    let finish!: (response: Response) => void;
    let refreshes = 0;
    configureAdminTransport((path, init) => {
        assertEquals(path, "/api/admin/source-health/reset");
        assertEquals(init?.method, "POST");
        calls.push(JSON.parse(String(init?.body)));
        return new Promise((resolve) => finish = resolve);
    });
    function App() {
        const [channels, setChannels] = useState([source]);
        return (
            <ChannelsPanel
                dashboard={dashboard(channels)}
                onConfigure={() => {}}
                onNotify={(_tone, message) => notes.push(message)}
                onRefresh={() => {
                    refreshes++;
                    setChannels([{
                        ...source,
                        health: "ready",
                        cooldown: undefined,
                    }]);
                    return Promise.resolve();
                }}
            />
        );
    }
    try {
        await dom.act(() =>
            render(<App />, dom.root as unknown as HTMLElement)
        );
        const button = resetButton(dom.root);
        await dom.act(() => {
            button.click();
            button.click();
        });
        assertEquals(calls, [{ sourceId: source.id }]);
        assert(button.disabled);
        assertEquals(refreshes, 0);
        await dom.act(() =>
            finish(
                Response.json({
                    source: {
                        sourceId: source.id,
                        health: "ready",
                        cleared: true,
                    },
                }),
            )
        );
        assertEquals(refreshes, 1);
        assertFalse(dom.root.textContent.includes("解除冷却"));
        assertStringIncludes(dom.root.textContent, "探测异常");
        assertStringIncludes(notes[0]!, SOURCE_RECOVERY_NOTE);
        assertEquals(dom.navigation, []);
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        configureAdminTransport();
        dom.restore();
    }
});

Deno.test("failed cooldown reset keeps the action available and reports errors without claiming recovery", async () => {
    const dom = installTestDom();
    let refreshes = 0;
    configureAdminTransport(() =>
        Promise.resolve(
            Response.json({
                error: { code: "source_not_found", message: "渠道已停用" },
            }, { status: 404 }),
        )
    );
    try {
        await dom.act(() =>
            render(
                <ChannelsPanel
                    dashboard={dashboard([source])}
                    onConfigure={() => {}}
                    onRefresh={() => {
                        refreshes++;
                        return Promise.resolve();
                    }}
                />,
                dom.root as unknown as HTMLElement,
            )
        );
        await dom.act(() => resetButton(dom.root).click());
        assertEquals(refreshes, 0);
        assertStringIncludes(dom.root.textContent, "渠道已停用");
        assertFalse(resetButton(dom.root).disabled);
        assertStringIncludes(dom.root.textContent, "冷却中");
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        configureAdminTransport();
        dom.restore();
    }
});

Deno.test("cooldown reset API rejects malformed success responses", async () => {
    configureAdminTransport(() =>
        Promise.resolve(
            Response.json({
                source: { sourceId: "wrong", health: "ready", cleared: true },
            }),
        )
    );
    try {
        await assertRejects(
            () => clearSourceCooldown("channel-health"),
            AdminApiError,
            "渠道恢复结果无效",
        );
    } finally {
        configureAdminTransport();
    }
});
