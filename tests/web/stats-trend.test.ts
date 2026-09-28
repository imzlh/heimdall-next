import { assertEquals, assertThrows } from "@std/assert";
import { readStatsTrend } from "@heimdall/core/web/shared/stats.ts";

const point = {
    requestCount: 1,
    completedCount: 1,
    failedCount: 0,
    cancelledCount: 0,
    inputTokens: 10,
    outputTokens: 20,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 30,
    from: "2026-09-23T16:00:00.000Z",
    day: "2026-09-24",
    label: "00:00",
};

const valid = {
    timeZone: "Asia/Shanghai",
    mode: "hour",
    bucketMinutes: 60,
    from: "2026-09-23T04:00:00.000Z",
    until: "2026-09-24T04:00:00.000Z",
    fallback: false,
    series: [point],
};

Deno.test("trend validator accepts the server shape and projects only public fields", () => {
    const trend = readStatsTrend(structuredClone(valid));
    assertEquals(trend.mode, "hour");
    assertEquals(trend.bucketMinutes, 60);
    assertEquals(trend.series[0]!.label, "00:00");
    assertEquals(trend.series[0]!.day, "2026-09-24");
});

Deno.test("trend validator rejects malformed windows point by point", () => {
    for (
        const broken of [
            { ...valid, mode: "weekly" },
            { ...valid, bucketMinutes: 45 },
            { ...valid, until: "2026-09-23T04:00:00.000Z" },
            { ...valid, fallback: 0 },
            { ...valid, timeZone: "Mars/Olympus" },
            { ...valid, series: [{ ...point, from: "2026-09-23 16:00:00" }] },
            { ...valid, series: [point, { ...point }] },
            { ...valid, series: [{ ...point, label: "way too long" }] },
            { ...valid, series: [{ ...point, day: "2026-13-01" }] },
            { ...valid, series: [{ ...point, totalTokens: -1 }] },
        ]
    ) {
        assertThrows(() => readStatsTrend(broken), TypeError);
    }
    // An empty window is well formed; the chart renders its own empty state.
    assertEquals(readStatsTrend({ ...valid, series: [] }).series.length, 0);
});
