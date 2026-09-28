import {
    assertEquals,
    assertFalse,
    assertStringIncludes,
    assertThrows,
} from "@std/assert";
import type { DashboardData } from "@heimdall/admin-contracts/console.ts";
import {
    isUiJsonObject,
    parseUiContributions,
    resolveUiBlock,
    type UiBlock,
    type UiContext,
    type UiContribution,
} from "@heimdall/admin-contracts/ui.ts";
import {
    dashboardUiContext,
    sourceUiContext,
} from "@heimdall/core/web/shared/ui-context.ts";
import { PluginSlot } from "@heimdall/core/web/components/slots.tsx";
import { createServerApp } from "@heimdall/core/http/app.ts";

const source = {
    id: "channel-a",
    name: "生产渠道",
    sourcePluginId: "sample.source",
    enabled: true,
    priority: 4,
    models: ["alpha", "beta"],
    capabilities: ["generation.create"],
    probe: {
        ok: true,
        checkedAt: "2026-09-25T00:00:00Z",
        message: "do not forward API-SECRET",
    },
    config: { apiKey: "API-SECRET" },
};
const contribution: UiContribution = {
    pluginId: "sample.source",
    id: "status",
    slot: "source.status",
    sourcePluginId: "sample.source",
    title: "连接状态",
    schema: {
        blocks: [
            {
                kind: "metric",
                label: "模型",
                value: "待更新",
                valueFrom: ["source", "modelCount"],
            },
            { kind: "badge", label: "未知", labelFrom: ["source", "state"] },
            {
                kind: "text",
                text: "尚无探测结果",
                textFrom: ["source", "probeStatus"],
            },
        ],
    },
};
const dashboard: DashboardData = {
    health: { status: "ok" },
    models: [{ id: "alpha" }, { id: "beta" }],
    status: {
        sources: [source, { id: "other", enabled: false }],
        plugins: [{ id: "sample.source", enabled: true }, {
            id: "failed",
            enabled: false,
            lastError: "do not forward ADMIN-SECRET",
        }],
        presets: [],
        managed: [{ config: { token: "ADMIN-SECRET" } }],
    },
    authRequired: false,
    errors: { health: "", models: "", status: "", presets: "", source: "" },
};

Deno.test("UI context exposes only host-selected scalar status, scoped to one source", () => {
    const overview = dashboardUiContext(dashboard, "dark");
    assertEquals(overview.data, {
        service: { state: "正常" },
        sources: { total: 2, enabled: 1 },
        models: { total: 2 },
        plugins: { total: 2, enabled: 1, failed: 1 },
    });
    const context = sourceUiContext(overview, source);
    assertEquals(context, {
        locale: "zh",
        theme: "dark",
        sourceId: "channel-a",
        sourcePluginId: "sample.source",
        data: {
            source: {
                enabled: true,
                state: "可用",
                stateTone: "success",
                priority: 4,
                modelCount: 2,
                capabilityCount: 1,
                probeStatus: "最近探测通过",
            },
        },
    });
    assertEquals(isUiJsonObject(context), true);
    assertEquals(JSON.parse(JSON.stringify(context)), context);
    assertFalse(JSON.stringify(context).includes("SECRET"));
    assertFalse(JSON.stringify(context).includes("other"));
    assertEquals(
        dashboardUiContext({ ...dashboard, authRequired: true }).data,
        {},
    );
});

Deno.test("schema bindings render actual status during SSR and keep fallback when missing", () => {
    const context = sourceUiContext(dashboardUiContext(dashboard), source);
    const html = (<PluginSlot contribution={contribution} context={context} />)
        .toString();
    assertStringIncludes(html, "<dd><strong>2</strong></dd>");
    assertStringIncludes(html, "可用");
    assertStringIncludes(html, "最近探测通过");
    assertFalse(html.includes("待更新"));
    const fallback = (<PluginSlot
        contribution={contribution}
        context={{ locale: "zh", theme: "system", data: {} }}
    />).toString();
    assertStringIncludes(fallback, "待更新");
    const escaped = (<PluginSlot
        contribution={contribution}
        context={{
            ...context,
            data: { source: { state: "<img src=x onerror=alert(1)>" } },
        }}
    />).toString();
    assertStringIncludes(escaped, "&lt;img src=x onerror=alert(1)&gt;");
    assertFalse(escaped.includes("<img"));
    const metric = contribution.schema.blocks[0]!;
    for (
        const value of [undefined, null, true, {}, [], Infinity, "x".repeat(81)]
    ) {
        assertEquals(
            resolveUiBlock(metric, {
                ...context,
                data: { source: { modelCount: value } } as UiContext["data"],
            }),
            metric,
        );
    }
});

Deno.test("schema binding paths reject expressions, prototype access and invalid shapes", () => {
    for (
        const path of [
            [],
            "source.modelCount",
            ["__proto__"],
            ["source", "constructor"],
            ["source", "modelCount()"],
            Array(7).fill("nested"),
            [2],
        ]
    ) {
        assertThrows(() =>
            parseUiContributions([{
                ...contribution,
                schema: {
                    blocks: [{
                        kind: "metric",
                        label: "模型",
                        value: "—",
                        valueFrom: path,
                    }],
                },
            }]), TypeError);
    }
    assertEquals(parseUiContributions([contribution]), [contribution]);
    const inherited = Object.create({ modelCount: 77 });
    assertEquals(
        resolveUiBlock(contribution.schema.blocks[0]!, {
            locale: "zh",
            theme: "system",
            data: { source: inherited },
        }),
        contribution.schema.blocks[0],
    );
    const accessor = Object.defineProperty({}, "modelCount", {
        get() {
            throw new Error("must not execute getters");
        },
    });
    assertEquals(
        resolveUiBlock(contribution.schema.blocks[0]!, {
            locale: "zh",
            theme: "system",
            data: { source: accessor },
        }),
        contribution.schema.blocks[0],
    );
    const malicious = {
        kind: "text",
        text: "fallback",
        textFrom: ["source", "constructor"],
    } as UiBlock;
    assertEquals(
        resolveUiBlock(malicious, { locale: "zh", theme: "system", data: {} }),
        malicious,
    );
});

Deno.test("SSR status bindings update with the live catalog and disappear when plugin stops", async () => {
    let enabled = true;
    let models = ["alpha", "beta"];
    const app = createServerApp({
        adminCatalog: {
            sources: () => [{ ...source, models }],
            plugins: () => [{
                id: "sample.source",
                kind: "source",
                version: "1",
                trust: "trusted",
                name: "Sample",
                enabled,
            }],
        },
        adminUiContributions: [contribution],
    });
    const html = async () =>
        await (await app.request("/admin?view=channels")).text();
    assertStringIncludes(await html(), "<dd><strong>2</strong></dd>");
    models = ["alpha", "beta", "gamma"];
    assertStringIncludes(await html(), "<dd><strong>3</strong></dd>");
    enabled = false;
    assertFalse(
        (await html()).includes('data-ui-extension="sample.source:status"'),
    );
});
