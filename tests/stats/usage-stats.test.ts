import { assertEquals, assertThrows } from "@std/assert";
import type { RequestStatus } from "@heimdall/storage";
import { createServer } from "../../main.ts";
import { createStatsRoutes } from "@heimdall/core/http/stats-routes.ts";
import { MODEL_RANKING_LIMIT } from "@heimdall/core/stats/report.ts";
import { openSqliteRequestStore } from "@heimdall/core/storage/sqlite-requests.ts";

type Store = ReturnType<typeof openSqliteRequestStore>;

const TIME_ZONE = "Asia/Shanghai";
/** 11:00 on 2026-09-24 in Shanghai. */
const NOW = new Date("2026-09-24T03:00:00.000Z");
const clock = { timeZone: TIME_ZONE, now: () => NOW };

function openStore(): Store & Disposable {
    const directory = Deno.makeTempDirSync({ prefix: "heimdall-stats-" });
    const store = openSqliteRequestStore(`${directory}/requests.sqlite`);
    return Object.assign(store, {
        [Symbol.dispose]() {
            store.close();
            Deno.removeSync(directory, { recursive: true });
        },
    });
}

function record(
    store: Store,
    requestId: string,
    receivedAt: string,
    model: string | undefined,
    status: RequestStatus,
    tokens?: { input: number; output: number; total: number },
): void {
    store.createRequest({ requestId, receivedAt, model, request: {} });
    if (status !== "running") store.updateRequest(requestId, { status });
    if (tokens !== undefined) {
        store.putUsage({
            requestId,
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            totalTokens: tokens.total,
            updatedAt: receivedAt,
        });
    }
}

/** Shanghai days: 09-23 holds r1; 09-24 holds r2..r5; 09-17 holds r6. */
function seed(store: Store): void {
    record(store, "r1", "2026-09-23T15:59:59.999Z", "model-a", "completed", {
        input: 1,
        output: 2,
        total: 3,
    });
    record(store, "r2", "2026-09-23T16:00:00.000Z", "model-a", "completed", {
        input: 10,
        output: 20,
        total: 30,
    });
    record(store, "r3", "2026-09-23T20:00:00.000Z", "model-b", "error");
    record(store, "r4", "2026-09-24T01:00:00.000Z", undefined, "cancelled");
    record(store, "r5", "2026-09-24T02:00:00.000Z", "model-b", "running", {
        input: 5,
        output: 5,
        total: 10,
    });
    record(store, "r6", "2026-09-17T12:00:00.000Z", "model-c", "completed", {
        input: 50,
        output: 50,
        total: 100,
    });
}

const ZERO = {
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

Deno.test("window stats count requests by status and join their usage", () => {
    using store = openStore();
    seed(store);
    assertEquals(
        store.windowStats(
            "2026-09-23T16:00:00.000Z",
            "2026-09-24T16:00:00.000Z",
        ),
        {
            ...ZERO,
            requestCount: 4,
            completedCount: 1,
            failedCount: 1,
            cancelledCount: 1,
            inputTokens: 15,
            outputTokens: 25,
            totalTokens: 40,
        },
    );
    assertEquals(
        store.windowStats(
            "2030-01-01T00:00:00.000Z",
            "2030-01-02T00:00:00.000Z",
        ),
        ZERO,
    );
    // Busiest first; equal counts rank by tokens, and unnamed models last.
    const models = store.modelStats(
        "2026-09-23T16:00:00.000Z",
        "2026-09-24T16:00:00.000Z",
        10,
    );
    assertEquals(models.map((row) => [row.model, row.requestCount]), [
        ["model-b", 2],
        ["model-a", 1],
        [null, 1],
    ]);
    assertEquals(
        store.modelStats(
            "2026-09-23T16:00:00.000Z",
            "2026-09-24T16:00:00.000Z",
            2,
        ).length,
        2,
    );
});

Deno.test("stats overview uses natural days of the configured zone", async () => {
    using store = openStore();
    seed(store);
    const app = createStatsRoutes(store, clock);
    const body = await (await app.request("/stats")).json();
    assertEquals(body.timeZone, TIME_ZONE);
    assertEquals(body.date, "2026-09-24");
    // r1 is 1 ms before Shanghai midnight: yesterday, though the same UTC day.
    assertEquals(body.today.requestCount, 4);
    assertEquals(body.today.totalTokens, 40);
    // The week spans 09-18..09-24, so it adds r1 but not r6 from 09-17.
    assertEquals(body.week.requestCount, 5);
    assertEquals(body.week.totalTokens, 43);
    assertEquals(
        body.models.map((row: { model: string | null }) => row.model),
        ["model-b", "model-a", null],
    );
    assertEquals(body.modelsTruncated, false);
});

Deno.test("stats series and rankings cover the requested natural days", async () => {
    using store = openStore();
    seed(store);
    const app = createStatsRoutes(store, clock);
    const series = await (await app.request("/stats/series?days=2")).json();
    assertEquals(series.days, 2);
    assertEquals(
        series.series.map((
            point: { date: string; requestCount: number; totalTokens: number },
        ) => [point.date, point.requestCount, point.totalTokens]),
        [["2026-09-23", 1, 3], ["2026-09-24", 4, 40]],
    );
    const week = await (await app.request("/stats/series")).json();
    assertEquals(week.series.length, 7);
    assertEquals(week.series[0].date, "2026-09-18");

    const ranking = await (await app.request("/stats/models?date=2026-09-17"))
        .json();
    assertEquals(ranking.date, "2026-09-17");
    assertEquals(ranking.models.length, 1);
    assertEquals(ranking.models[0].model, "model-c");
    assertEquals(ranking.models[0].totalTokens, 100);
    const today = await (await app.request("/stats/models")).json();
    assertEquals(today.date, "2026-09-24");
    assertEquals(today.models.length, 3);
});

Deno.test("stats trend serves wall-clock hour buckets", async () => {
    using store = openStore();
    seed(store);
    const app = createStatsRoutes(store, clock);
    const trend = await (await app.request("/stats/trend?mode=hour")).json();
    assertEquals(trend.mode, "hour");
    assertEquals(trend.bucketMinutes, 60);
    assertEquals(trend.fallback, false);
    // 11:00 Shanghai now: the 24 hour buckets start 12:00 yesterday and end
    // with the hour in progress.
    assertEquals(trend.from, "2026-09-23T04:00:00.000Z");
    assertEquals(trend.until, "2026-09-24T04:00:00.000Z");
    assertEquals(trend.series.length, 24);
    const first = trend.series[0];
    assertEquals(first.from, "2026-09-23T04:00:00.000Z");
    assertEquals(first.day, "2026-09-23");
    assertEquals(first.label, "12:00");
    // r1 (15:59:59.999Z) lands in the 23:00 Shanghai bucket; r2 (16:00Z) in midnight's.
    const buckets = trend.series.map(
        (
            point: { label: string; requestCount: number; totalTokens: number },
        ) => [
            point.label,
            point.requestCount,
            point.totalTokens,
        ],
    );
    assertEquals(buckets[11], ["23:00", 1, 3]);
    assertEquals(buckets[12], ["00:00", 1, 30]);
    assertEquals(buckets[16], ["04:00", 1, 0]);
    assertEquals(buckets[21], ["09:00", 1, 0]);
    assertEquals(buckets[22], ["10:00", 1, 10]);
    assertEquals(
        buckets.filter((entry: [string, number, number]) => entry[1] > 0)
            .length,
        5,
    );
});

Deno.test("stats trend zooms the recent window onto today's active span", async () => {
    using store = openStore();
    seed(store);
    const app = createStatsRoutes(store, clock);
    const trend = await (await app.request("/stats/trend?mode=recent")).json();
    assertEquals(trend.mode, "recent");
    assertEquals(trend.fallback, false);
    // Token activity runs midnight Shanghai (r2) to 10:00 (r5); two hours of
    // context on each side make a 13h window, so 30 minute buckets fit.
    assertEquals(trend.from, "2026-09-23T14:00:00.000Z");
    assertEquals(trend.until, "2026-09-24T03:00:00.000Z");
    assertEquals(trend.bucketMinutes, 30);
    assertEquals(trend.series.length, 26);
    // r1 at 23:59:59.999 Shanghai (yesterday) survives inside the context.
    const context = trend.series[3];
    assertEquals(context.from, "2026-09-23T15:30:00.000Z");
    assertEquals(context.label, "23:30");
    assertEquals(context.requestCount, 1);
    assertEquals(context.totalTokens, 3);
    const burst = trend.series[4];
    assertEquals(burst.requestCount, 1);
    assertEquals(burst.totalTokens, 30);
});

Deno.test("stats trend falls back to the trailing day when today is quiet", async () => {
    using store = openStore();
    record(store, "old", "2026-09-17T12:00:00.000Z", "model-c", "completed", {
        input: 50,
        output: 50,
        total: 100,
    });
    const app = createStatsRoutes(store, clock);
    const trend = await (await app.request("/stats/trend?mode=recent")).json();
    assertEquals(trend.mode, "recent");
    assertEquals(trend.fallback, true);
    assertEquals(trend.bucketMinutes, 60);
    assertEquals(trend.from, "2026-09-23T04:00:00.000Z");
    assertEquals(trend.until, "2026-09-24T04:00:00.000Z");
    assertEquals(trend.series.length, 24);
    assertEquals(
        trend.series.every((point: { requestCount: number }) =>
            point.requestCount === 0
        ),
        true,
    );
});

Deno.test("model ranking reports truncation beyond its row limit", async () => {
    using store = openStore();
    for (let index = 0; index <= MODEL_RANKING_LIMIT; index++) {
        record(
            store,
            `bulk-${index}`,
            "2026-09-24T02:00:00.000Z",
            `model-${String(index).padStart(3, "0")}`,
            "completed",
        );
    }
    const app = createStatsRoutes(store, clock);
    const body = await (await app.request("/stats/models")).json();
    assertEquals(body.models.length, MODEL_RANKING_LIMIT);
    assertEquals(body.truncated, true);
});

Deno.test("mounted stats routes validate parameters and the time zone", async () => {
    using store = openStore();
    const app = createServer({
        requestJournal: store,
        statsTimeZone: TIME_ZONE,
    });
    const overview = await app.request("http://localhost/api/admin/stats");
    assertEquals(overview.status, 200);
    assertEquals((await overview.json()).timeZone, TIME_ZONE);
    for (
        const query of [
            "series?days=0",
            "series?days=91",
            "series?days=7.5",
            "series?days=1e1",
            "series?days=abc",
            "trend?mode=week",
            "trend?mode=hourly",
            "models?date=2026-02-30",
            "models?date=2026-9-1",
            "models?date=2999-01-01",
            "models?date=2019-12-31",
        ]
    ) {
        const response = await app.request(
            `http://localhost/api/admin/stats/${query}`,
        );
        assertEquals(response.status, 400, query);
        assertEquals((await response.json()).error.code, "invalid_request");
    }
    assertThrows(
        () =>
            createServer({
                requestJournal: store,
                statsTimeZone: "Mars/Olympus",
            }),
        RangeError,
    );
});
