/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import {
    assert,
    assertEquals,
    assertFalse,
    assertStringIncludes,
} from "@std/assert";
import { render, useState } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import { jsx as serverJsx } from "hono/jsx/jsx-runtime";
import type {
    StatsOverviewDto,
    StatsSeriesDto,
    StatsTrendDto,
    UsageCountersDto,
} from "@heimdall/admin-contracts";
import type { ConsoleSnapshot } from "@heimdall/admin-contracts/console.ts";
import { configureAdminTransport } from "@heimdall/core/web/client/api/transport.ts";
import { useStats } from "@heimdall/core/web/client/use-stats.ts";
import { StatsPanels } from "@heimdall/core/web/shared/stats-panels.tsx";
import { installTestDom } from "./helpers/jsx-dom.ts";

const ZERO: UsageCountersDto = {
    requestCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
};
const overview: StatsOverviewDto = {
    timeZone: "America/New_York",
    date: "2026-09-23",
    today: { ...ZERO, requestCount: 25, totalTokens: 1250 },
    week: { ...ZERO, requestCount: 30, totalTokens: 1500 },
    models: [{ ...ZERO, model: "model-a", requestCount: 25 }],
    modelsTruncated: false,
};
const series: StatsSeriesDto = {
    timeZone: "America/New_York",
    days: 7,
    series: Array.from({ length: 7 }, (_, index) => ({
        ...ZERO,
        date: `2026-09-${17 + index}`,
        ...(index === 6
            ? { requestCount: 25, inputTokens: 1000, totalTokens: 1250 }
            : {}),
    })),
};
const initial: NonNullable<ConsoleSnapshot["stats"]> = {
    overview,
    series,
    errors: { overview: "", series: "" },
};

/** Interval buckets starting at `start`, with one active bucket carrying tokens. */
function trendBuckets(
    count: number,
    start: string,
    stepMinutes: number,
    active = -1,
): StatsTrendDto["series"] {
    const begin = Date.parse(start);
    return Array.from({ length: count }, (_, index) => {
        const from = new Date(begin + index * stepMinutes * 60_000)
            .toISOString();
        return {
            ...ZERO,
            from,
            day: from.slice(0, 10),
            label: from.slice(11, 16),
            ...(index === active
                ? {
                    requestCount: 3,
                    inputTokens: 600,
                    outputTokens: 150,
                    totalTokens: 750,
                }
                : {}),
        };
    });
}

const hourTrend: StatsTrendDto = {
    timeZone: "America/New_York",
    mode: "hour",
    bucketMinutes: 60,
    from: "2026-09-23T04:00:00.000Z",
    until: "2026-09-24T04:00:00.000Z",
    fallback: false,
    series: trendBuckets(24, "2026-09-23T04:00:00.000Z", 60, 20),
};
const recentTrend: StatsTrendDto = {
    timeZone: "America/New_York",
    mode: "recent",
    bucketMinutes: 30,
    from: "2026-09-23T14:00:00.000Z",
    until: "2026-09-24T04:00:00.000Z",
    fallback: false,
    series: trendBuckets(28, "2026-09-23T14:00:00.000Z", 30, 24),
};

async function html(stats?: ConsoleSnapshot["stats"]): Promise<string> {
    return await serverJsx(StatsPanels, { stats }).toString();
}

Deno.test("statistics render each endpoint's calendar and totals independently in SSR", async () => {
    const markup = await html(initial);
    assertStringIncludes(markup, "缓存 0");
    assertStringIncludes(
        markup,
        "2026-09-17 至 2026-09-23 · America/New_York",
    );
    assertStringIncludes(markup, '<span class="token-total">1,250</span>');
    assertStringIncludes(markup, "<strong>1,500</strong>");
    assertStringIncludes(markup, "25 次请求");
    assertStringIncludes(markup, "model-a");
    assertStringIncludes(markup, '<details class="usage-history">');
    // SSR renders the mode switch inert until the island takes over.
    assertStringIncludes(markup, 'aria-label="趋势范围"');
    assertStringIncludes(markup, ">近7天</button>");
    assertStringIncludes(markup, ">24小时</button>");
    assertStringIncludes(markup, ">近期</button>");
    assertStringIncludes(markup, "disabled");
});

Deno.test("statistics surface cached prompt tokens on the input card", async () => {
    const cached = await html({
        ...initial,
        overview: {
            ...overview,
            today: {
                ...overview.today,
                inputTokens: 2000,
                cachedInputTokens: 18400,
            },
        },
    });
    // cached / (plain input + cached) = 18400/20400 = 90.2%
    assertStringIncludes(cached, "缓存 18,400 90.2%");
});

Deno.test("statistics distinguish an unavailable chart from a successful zero series", async () => {
    const unavailable = await html({ ...initial, series: null });
    assertStringIncludes(unavailable, '<span class="token-total">—</span>');
    assertStringIncludes(unavailable, "用量趋势暂不可用。");
    assertFalse(unavailable.includes("这段时间暂无请求"));

    const empty = await html({
        overview: null,
        series: {
            ...series,
            series: series.series.map((point) => ({
                ...ZERO,
                date: point.date,
            })),
        },
        errors: { overview: "总览读取失败", series: "" },
    });
    assertStringIncludes(empty, '<span class="token-total">0</span>');
    assertStringIncludes(empty, "这段时间暂无请求");
    assertStringIncludes(empty, "统计暂不可用");
    assertFalse(empty.includes("今日暂无模型调用记录"));
});

function Statistics({ revision, boot }: {
    revision: number;
    boot?: ConsoleSnapshot["stats"];
}) {
    const stats = useStats(revision, boot);
    return (
        <StatsPanels
            stats={{ ...stats, onModeChange: stats.setMode }}
            loading={stats.loading}
        />
    );
}

Deno.test("statistics island keeps SSR figures on first render and refreshes server data across midnight", async () => {
    const dom = installTestDom();
    const requests: string[] = [];
    let fail: "overview" | "series" = "overview";
    let changeRevision = (_revision: number) => {};
    function App() {
        const [revision, setRevision] = useState(0);
        changeRevision = setRevision;
        return <Statistics revision={revision} boot={initial} />;
    }
    const tomorrow: StatsSeriesDto = {
        ...series,
        series: series.series.map((point, index) => ({
            ...point,
            date: `2026-09-${18 + index}`,
            totalTokens: index === 6 ? 2100 : 0,
        })),
    };
    configureAdminTransport((input) => {
        const path = String(input);
        requests.push(path);
        const isOverview = path === "/api/admin/stats";
        assert(isOverview || path === "/api/admin/stats/series?days=7");
        return Promise.resolve(
            (isOverview ? fail === "overview" : fail === "series")
                ? Response.json({ error: { message: "临时不可用" } }, {
                    status: 503,
                })
                : Response.json(
                    isOverview
                        ? {
                            ...overview,
                            date: "2026-09-24",
                            week: { ...overview.week, totalTokens: 3300 },
                        }
                        : tomorrow,
                ),
        );
    });
    try {
        await dom.act(() =>
            render(
                <App />,
                dom.root as unknown as HTMLElement,
            )
        );
        assertEquals(requests, []);
        assertStringIncludes(dom.root.textContent, "缓存 0");
        assertStringIncludes(dom.root.textContent, "25 次请求");
        assertEquals(
            dom.root.querySelector('span[class="token-total"]')?.textContent,
            "1,250",
        );

        await dom.act(() => changeRevision(1));
        await dom.act();
        assertEquals(requests, [
            "/api/admin/stats",
            "/api/admin/stats/series?days=7",
        ]);
        assertStringIncludes(dom.root.textContent, "显示上次读取的统计");
        assertStringIncludes(dom.root.textContent, "缓存 0");
        assertStringIncludes(
            dom.root.textContent,
            "2026-09-18 至 2026-09-24 · America/New_York",
        );
        assertEquals(
            dom.root.querySelector('span[class="token-total"]')?.textContent,
            "2,100",
        );

        fail = "series";
        await dom.act(() => changeRevision(2));
        await dom.act();
        assertStringIncludes(dom.root.textContent, "显示上次读取的趋势");
        assertFalse(dom.root.textContent.includes("显示上次读取的统计"));
        assertStringIncludes(dom.root.textContent, "3,300");
        assertEquals(
            dom.root.querySelector('span[class="token-total"]')?.textContent,
            "2,100",
        );
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        configureAdminTransport();
        dom.restore();
    }
});

Deno.test("statistics island switches trend modes and keeps each window cached", async () => {
    const dom = installTestDom();
    const requests: string[] = [];
    function App() {
        return <Statistics revision={1} />;
    }
    configureAdminTransport((input) => {
        const path = String(input);
        requests.push(path);
        const body = path === "/api/admin/stats"
            ? overview
            : path === "/api/admin/stats/series?days=7"
            ? series
            : path === "/api/admin/stats/trend?mode=hour"
            ? hourTrend
            : path === "/api/admin/stats/trend?mode=recent"
            ? recentTrend
            : undefined;
        if (body === undefined) throw new Error(`unexpected request ${path}`);
        return Promise.resolve(Response.json(body));
    });
    try {
        await dom.act(() => render(<App />, dom.root as unknown as HTMLElement));
        await dom.act();
        // The island boot has no SSR snapshot: day mode fetches the weekly series.
        assertEquals(requests, [
            "/api/admin/stats",
            "/api/admin/stats/series?days=7",
        ]);
        assertStringIncludes(
            dom.root.textContent,
            "近 7 天用量趋势",
        );
        const modeButton = (label: string) => {
            const match = [
                ...dom.root.querySelectorAll("button"),
            ].find((item) => item.textContent === label);
            assert(match !== undefined, `missing mode button ${label}`);
            return match;
        };

        await dom.act(() => modeButton("24小时").click());
        await dom.act();
        assertEquals(requests.slice(2), ["/api/admin/stats/trend?mode=hour"]);
        assertStringIncludes(dom.root.textContent, "近 24 小时用量趋势");
        assertStringIncludes(
            dom.root.textContent,
            "2026-09-23 04:00 – 2026-09-24 03:00 · 每小时 · America/New_York",
        );
        assertEquals(
            dom.root.querySelector('span[class="token-total"]')?.textContent,
            "750",
        );
        assertFalse(dom.root.textContent.includes("查看每日明细"));

        await dom.act(() => modeButton("近期").click());
        await dom.act();
        assertEquals(requests.slice(3), ["/api/admin/stats/trend?mode=recent"]);
        assertStringIncludes(dom.root.textContent, "近期用量趋势");
        assertStringIncludes(
            dom.root.textContent,
            "每 30 分钟 · America/New_York",
        );
        assertEquals(
            dom.root.querySelector('span[class="token-total"]')?.textContent,
            "750",
        );

        await dom.act(() => modeButton("近7天").click());
        await dom.act();
        assertEquals(requests.slice(4), ["/api/admin/stats/series?days=7"]);
        assertStringIncludes(dom.root.textContent, "查看每日明细");
        assertStringIncludes(
            dom.root.textContent,
            "2026-09-17 至 2026-09-23 · America/New_York",
        );
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        configureAdminTransport();
        dom.restore();
    }
});
