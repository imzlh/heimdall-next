import { assert, assertEquals, assertFalse } from "@std/assert";
import type {
    StatsOverviewDto,
    StatsSeriesDto,
    UsageCountersDto,
} from "@heimdall/admin-contracts";
import { createStatsRoutes } from "@heimdall/core/http/stats-routes.ts";
import { openSqliteRequestStore } from "@heimdall/core/storage/sqlite-requests.ts";
import { loadConsoleSnapshot } from "@heimdall/core/web/server/snapshot.ts";

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
const OVERVIEW: StatsOverviewDto = {
    timeZone: "Asia/Shanghai",
    date: "2026-09-24",
    today: { ...ZERO, requestCount: 2, completedCount: 1, failedCount: 1 },
    week: { ...ZERO, requestCount: 3, completedCount: 2, failedCount: 1 },
    models: [{
        ...ZERO,
        model: "model-a",
        requestCount: 2,
        completedCount: 1,
        failedCount: 1,
    }],
    modelsTruncated: false,
};
const SERIES: StatsSeriesDto = {
    timeZone: "Asia/Shanghai",
    days: 7,
    series: Array.from({ length: 7 }, (_, index) => ({
        ...ZERO,
        date: `2026-09-${18 + index}`,
        ...(index === 5 ? { requestCount: 1, completedCount: 1 } : {}),
        ...(index === 6 ? OVERVIEW.today : {}),
    })),
};

function otherResource(path: string): Response {
    if (path === "/health") return Response.json({ status: "ok" });
    if (path === "/api/admin/models") {
        return Response.json({ data: [{ id: "working-model" }] });
    }
    if (path === "/api/admin/proxies") {
        return Response.json({ pool: { defaultProxyId: null, entries: [] } });
    }
    return Response.json({});
}

Deno.test("SSR statistics remain unread and empty until the management session is authorized", async () => {
    const paths: string[] = [];
    const snapshot = await loadConsoleSnapshot({
        authorized: false,
        adminAuthToken: "server-secret",
        dispatch(request) {
            const path = new URL(request.url).pathname;
            paths.push(path);
            assertEquals(request.headers.get("authorization"), null);
            return otherResource(path);
        },
    });
    assertEquals(paths, ["/health"]);
    assertEquals(snapshot.stats, {
        overview: null,
        series: null,
        errors: { overview: "", series: "" },
    });
    assert(snapshot.dashboard.authRequired);
});

Deno.test("SSR statistics use protected overview and seven-day series reads with an explicit public projection", async () => {
    const paths: string[] = [];
    const snapshot = await loadConsoleSnapshot({
        authorized: true,
        adminAuthToken: "server-secret",
        dispatch(request) {
            const url = new URL(request.url);
            paths.push(url.pathname + url.search);
            assertEquals(
                request.headers.get("authorization"),
                url.pathname === "/health" ? null : "Bearer server-secret",
            );
            if (url.pathname === "/api/admin/stats") {
                return Response.json({
                    ...OVERVIEW,
                    today: { ...OVERVIEW.today, apiKey: "private-key" },
                    models: [{
                        ...OVERVIEW.models[0],
                        model: "model-server-secret",
                        request: { messages: ["private-message"] },
                    }],
                    adminToken: "server-secret",
                    config: { password: "private-password" },
                });
            }
            if (url.pathname === "/api/admin/stats/series") {
                assertEquals(url.search, "?days=7");
                return Response.json({
                    ...SERIES,
                    series: SERIES.series.map((point) => ({
                        ...point,
                        request: "private-message",
                    })),
                    apiKey: "private-key",
                });
            }
            return otherResource(url.pathname);
        },
    });
    assertEquals(paths.filter((path) => path.startsWith("/api/admin/stats")), [
        "/api/admin/stats",
        "/api/admin/stats/series?days=7",
    ]);
    assertEquals(snapshot.stats?.overview, {
        ...OVERVIEW,
        models: [{ ...OVERVIEW.models[0]!, model: "model-[已隐藏]" }],
    });
    assertEquals(snapshot.stats?.series, SERIES);
    assertEquals(snapshot.stats?.errors, { overview: "", series: "" });
    assertFalse(snapshot.dashboard.authRequired);
    const serialized = JSON.stringify(snapshot);
    for (
        const secret of [
            "server-secret",
            "private-key",
            "private-message",
            "private-password",
        ]
    ) {
        assertFalse(serialized.includes(secret), secret);
    }
});

Deno.test("SSR statistics preserve each successful panel when its peer fails or expires", async () => {
    for (
        const [failed, status] of [
            ["overview", 503],
            ["overview", 401],
            ["series", 503],
            ["series", 401],
        ] as const
    ) {
        const failedPath = failed === "overview"
            ? "/api/admin/stats"
            : "/api/admin/stats/series";
        const snapshot = await loadConsoleSnapshot({
            authorized: true,
            adminAuthToken: "server-secret",
            dispatch(request) {
                const path = new URL(request.url).pathname;
                if (path === failedPath) {
                    return Response.json({ error: "private server failure" }, {
                        status,
                        headers: {
                            "x-heimdall-request-id": "trace-server-secret",
                        },
                    });
                }
                if (path === "/api/admin/stats") return Response.json(OVERVIEW);
                if (path === "/api/admin/stats/series") {
                    return Response.json(SERIES);
                }
                return otherResource(path);
            },
        });
        assertEquals(snapshot.stats?.[failed], null);
        assert(
            snapshot.stats?.errors[failed].includes(
                String(status),
            ),
        );
        assert(snapshot.stats?.errors[failed].includes("trace-[已隐藏]"));
        assertEquals(
            snapshot.stats?.[failed === "overview" ? "series" : "overview"],
            failed === "overview" ? SERIES : OVERVIEW,
        );
        assertEquals(snapshot.dashboard.models[0]?.id, "working-model");
        assertEquals(snapshot.dashboard.authRequired, status === 401);
        assertFalse(
            JSON.stringify(snapshot).includes("private server failure"),
        );
        assertFalse(JSON.stringify(snapshot).includes("server-secret"));
    }
});

Deno.test("SSR rejects invalid successful statistics without substituting false zero totals", async () => {
    for (
        const invalid of [
            {
                overview: { ...OVERVIEW, today: { ...ZERO, requestCount: -1 } },
                series: SERIES,
            },
            {
                overview: OVERVIEW,
                series: { ...SERIES, series: [{ date: "2026-09-24" }] },
            },
        ]
    ) {
        const snapshot = await loadConsoleSnapshot({
            authorized: true,
            dispatch(request) {
                const path = new URL(request.url).pathname;
                if (path === "/api/admin/stats") {
                    return Response.json(invalid.overview);
                }
                if (path === "/api/admin/stats/series") {
                    return Response.json(invalid.series);
                }
                return otherResource(path);
            },
        });
        const failed = invalid.overview === OVERVIEW ? "series" : "overview";
        assertEquals(snapshot.stats?.[failed], null);
        assert(snapshot.stats?.errors[failed]);
        assertEquals(
            snapshot.stats?.[failed === "overview" ? "series" : "overview"],
            failed === "overview" ? SERIES : OVERVIEW,
        );
        assertFalse(snapshot.dashboard.authRequired);
    }
});

Deno.test("SSR dashboard reads complete statistics beyond its twenty-request preview using server natural days", async () => {
    const directory = Deno.makeTempDirSync({
        prefix: "heimdall-snapshot-stats-",
    });
    const store = openSqliteRequestStore(`${directory}/requests.sqlite`);
    try {
        const addRequest = (
            id: string,
            model: string,
            receivedAt: string,
            tokens: number,
        ) => {
            store.createRequest({
                requestId: id,
                model,
                receivedAt,
                request: {},
            });
            store.updateRequest(id, { status: "completed" });
            store.putUsage({
                requestId: id,
                totalTokens: tokens,
                inputTokens: tokens,
                outputTokens: 0,
                updatedAt: receivedAt,
            });
        };
        addRequest(
            "yesterday",
            "yesterday-only",
            "2026-09-23T15:59:59.999Z",
            999,
        );
        for (let index = 0; index < 25; index++) {
            addRequest(
                `today-${index}`,
                `model-${String(index).padStart(2, "0")}`,
                new Date(
                    Date.parse("2026-09-23T16:00:00.000Z") + index * 60_000,
                ).toISOString(),
                30,
            );
        }
        const routes = createStatsRoutes(store, {
            timeZone: "Asia/Shanghai",
            now: () => new Date("2026-09-24T03:00:00.000Z"),
        });
        const snapshot = await loadConsoleSnapshot({
            authorized: true,
            dispatch(request) {
                const url = new URL(request.url);
                if (url.pathname.startsWith("/api/admin/stats")) {
                    url.pathname = url.pathname.slice("/api/admin".length);
                    return routes.request(new Request(url, request));
                }
                if (url.pathname === "/api/admin/requests") {
                    assertEquals(url.search, "?limit=20");
                    return Response.json({
                        requests: store.listRequests({ limit: 20 }),
                    });
                }
                return otherResource(url.pathname);
            },
        });
        assertEquals(snapshot.requests.length, 20);
        assertEquals(snapshot.stats?.errors, { overview: "", series: "" });
        const overview = snapshot.stats?.overview;
        assert(overview);
        assertEquals(overview.timeZone, "Asia/Shanghai");
        assertEquals(overview.date, "2026-09-24");
        assertEquals(overview.today.requestCount, 25);
        assertEquals(overview.today.totalTokens, 750);
        assertEquals(overview.week.requestCount, 26);
        assertEquals(overview.week.totalTokens, 1749);
        assertEquals(overview.models.length, 25);
        assertEquals(overview.modelsTruncated, false);
        assertFalse(
            overview.models.some((entry) => entry.model === "yesterday-only"),
        );
        assertEquals(
            snapshot.stats?.series?.series.map((
                day,
            ) => [day.date, day.requestCount]),
            [
                ["2026-09-18", 0],
                ["2026-09-19", 0],
                ["2026-09-20", 0],
                ["2026-09-21", 0],
                ["2026-09-22", 0],
                ["2026-09-23", 1],
                ["2026-09-24", 25],
            ],
        );
    } finally {
        store.close();
        Deno.removeSync(directory, { recursive: true });
    }
});
