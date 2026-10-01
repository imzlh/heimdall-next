import type {
    ModelRankingDto,
    ModelUsageDto,
    StatsOverviewDto,
    StatsSeriesDto,
    StatsTrendDto,
    StatsTrendMode,
    StatsTrendPointDto,
    UsageCountersDto,
} from "@heimdall/admin-contracts";
import type { RequestStore, RequestWindowStats } from "@heimdall/storage";
import {
    civilClock,
    civilDate,
    dayStart,
    type NaturalDay,
    naturalDay,
    recentNaturalDays,
} from "./calendar.ts";

/** Ranking rows per day. One more row is read to report truncation. */
export const MODEL_RANKING_LIMIT = 50;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const FINE_MS = 15 * MINUTE_MS;
/** A recent window shorter than this reads as a glitch; longer is not "recent". */
const RECENT_MIN_SPAN_MS = 2 * HOUR_MS;
const RECENT_MAX_SPAN_MS = 24 * HOUR_MS;
/** Context shown before today's first active slot, so the ramp into it is visible. */
const RECENT_CONTEXT_MS = 2 * HOUR_MS;
/** How much quiet may trail the last activity before the window cuts off. */
const RECENT_TRAIL_MS = 2 * HOUR_MS;

export type StatsReader = Pick<RequestStore, "windowStats" | "modelStats">;

export interface StatsClock {
    /** IANA zone whose civil dates define a natural day. */
    readonly timeZone: string;
    readonly now: () => Date;
}

/** Today, the last seven natural days (today included), and today's models. */
export function statsOverview(
    reader: StatsReader,
    clock: StatsClock,
): StatsOverviewDto {
    // One clock read, so the three figures cannot straddle midnight.
    const days = recentNaturalDays(7, clock.timeZone, clock.now());
    const today = days[days.length - 1]!;
    const ranking = rank(reader, today);
    return {
        timeZone: clock.timeZone,
        date: today.date,
        today: counters(reader.windowStats(today.from, today.until)),
        week: counters(reader.windowStats(days[0]!.from, today.until)),
        models: ranking.models,
        modelsTruncated: ranking.truncated,
    };
}

/** One point per natural day, oldest first, ending today. */
export function statsSeries(
    reader: StatsReader,
    clock: StatsClock,
    count: number,
): StatsSeriesDto {
    const days = recentNaturalDays(count, clock.timeZone, clock.now());
    return {
        timeZone: clock.timeZone,
        days: count,
        series: days.map((day) => ({
            date: day.date,
            ...counters(reader.windowStats(day.from, day.until)),
        })),
    };
}

/** `mode=day` draws the weekly series, `hour` the trailing day, `recent` zooms into today's usage. */
export function statsTrend(
    reader: StatsReader,
    clock: StatsClock,
    mode: StatsTrendMode,
): StatsTrendDto {
    if (mode === "hour") return hourTrend(reader, clock, false);
    if (mode === "recent") return recentTrend(reader, clock);
    return dayTrend(reader, clock);
}

function dayTrend(reader: StatsReader, clock: StatsClock): StatsTrendDto {
    const days = recentNaturalDays(7, clock.timeZone, clock.now());
    const first = days[0]!;
    const last = days[days.length - 1]!;
    return {
        timeZone: clock.timeZone,
        mode: "day",
        bucketMinutes: 1440,
        from: first.from,
        until: last.until,
        fallback: false,
        series: days.map((day) => ({
            from: day.from,
            day: day.date,
            label: day.date.slice(5),
            ...counters(reader.windowStats(day.from, day.until)),
        })),
    };
}

function hourTrend(reader: StatsReader, clock: StatsClock, fallback: boolean) {
    const current = wallBucketStart(
        clock.now().getTime(),
        HOUR_MS,
        clock.timeZone,
    );
    const from = current - 23 * HOUR_MS;
    const until = current + HOUR_MS;
    return {
        timeZone: clock.timeZone,
        mode: fallback ? "recent" as const : "hour" as const,
        bucketMinutes: 60,
        from: iso(from),
        until: iso(until),
        fallback,
        series: bucketSeries(reader, clock, from, until, HOUR_MS),
    };
}

/**
 * The smart recent window: today's usage periods at the finest readable grain.
 * A 15-minute probe of today finds the active span — token usage first, bare
 * request counts only when nothing reported tokens. The window covers that
 * span plus two hours of context on each side (capped at a day), and picks a
 * bucket width the point count can still label clearly, so bursts render as a
 * shape instead of a single spike. With no usage today it falls back to the
 * trailing day.
 */
function recentTrend(reader: StatsReader, clock: StatsClock): StatsTrendDto {
    const now = clock.now().getTime();
    const zone = clock.timeZone;
    const midnight = dayStart(civilDate(now, zone), zone);
    let first = -1;
    let last = -1;
    let firstRequest = -1;
    let lastRequest = -1;
    for (let start = midnight; start <= now; start += FINE_MS) {
        const stats = reader.windowStats(iso(start), iso(start + FINE_MS));
        if (stats.requestCount === 0) continue;
        if (firstRequest < 0) firstRequest = start;
        lastRequest = start;
        if (stats.totalTokens === 0) continue;
        if (first < 0) first = start;
        last = start;
    }
    if (first < 0 && firstRequest < 0) return hourTrend(reader, clock, true);
    if (first < 0) {
        first = firstRequest;
        last = lastRequest;
    }
    const ceilNow = midnight +
        Math.ceil((now - midnight) / FINE_MS) * FINE_MS;
    const end = Math.min(
        Math.max(ceilNow, last + 2 * FINE_MS),
        last + RECENT_TRAIL_MS,
    );
    const start = Math.max(first - RECENT_CONTEXT_MS, end - RECENT_MAX_SPAN_MS);
    const span = end - start;
    const widened = span < RECENT_MIN_SPAN_MS
        ? end - RECENT_MIN_SPAN_MS
        : start;
    const bucketMs = span <= 8 * HOUR_MS
        ? FINE_MS
        : span <= 20 * HOUR_MS
        ? 30 * MINUTE_MS
        : HOUR_MS;
    // Snap onto the wall-clock bucket grid anchored at midnight. DST shifts
    // post-transition labels by an hour, the same trade the day boundaries make.
    const from = midnight +
        Math.floor((widened - midnight) / bucketMs) * bucketMs;
    const until = midnight +
        Math.ceil((end - midnight) / bucketMs) * bucketMs;
    return {
        timeZone: zone,
        mode: "recent",
        bucketMinutes: bucketMs / MINUTE_MS,
        from: iso(from),
        until: iso(until),
        fallback: false,
        series: bucketSeries(reader, clock, from, until, bucketMs),
    };
}

/** Wall-clock bucket start: the grid is anchored at the zone's midnight. */
function wallBucketStart(
    now: number,
    bucketMs: number,
    timeZone: string,
): number {
    const midnight = dayStart(civilDate(now, timeZone), timeZone);
    return midnight + Math.floor((now - midnight) / bucketMs) * bucketMs;
}

function bucketSeries(
    reader: StatsReader,
    clock: StatsClock,
    from: number,
    until: number,
    stepMs: number,
): StatsTrendPointDto[] {
    const zone = clock.timeZone;
    const points: StatsTrendPointDto[] = [];
    for (let start = from; start < until; start += stepMs) {
        const day = civilDate(start, zone);
        points.push({
            from: iso(start),
            day,
            label: stepMs >= 1440 * MINUTE_MS
                ? day.slice(5)
                : civilClock(start, zone),
            ...counters(reader.windowStats(iso(start), iso(start + stepMs))),
        });
    }
    return points;
}

function iso(instant: number): string {
    return new Date(instant).toISOString();
}

/** One natural day's models, busiest first. */
export function modelRanking(
    reader: StatsReader,
    clock: StatsClock,
    date: string,
): ModelRankingDto {
    const ranking = rank(reader, naturalDay(date, clock.timeZone));
    return {
        timeZone: clock.timeZone,
        date,
        models: ranking.models,
        truncated: ranking.truncated,
    };
}

/** Today's civil date in the statistics zone. */
export function statsToday(clock: StatsClock): string {
    return civilDate(clock.now().getTime(), clock.timeZone);
}

function rank(
    reader: StatsReader,
    day: NaturalDay,
): { models: ModelUsageDto[]; truncated: boolean } {
    const rows = reader.modelStats(
        day.from,
        day.until,
        MODEL_RANKING_LIMIT + 1,
    );
    return {
        models: rows.slice(0, MODEL_RANKING_LIMIT).map((row) => ({
            model: row.model,
            ...counters(row),
        })),
        truncated: rows.length > MODEL_RANKING_LIMIT,
    };
}

/** Copy counters field by field so storage-only fields never reach the DTO. */
function counters(stats: RequestWindowStats): UsageCountersDto {
    return {
        requestCount: stats.requestCount,
        completedCount: stats.completedCount,
        failedCount: stats.failedCount,
        cancelledCount: stats.cancelledCount,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        reasoningTokens: stats.reasoningTokens,
        cachedInputTokens: stats.cachedInputTokens,
        cacheWriteTokens: stats.cacheWriteTokens,
        totalTokens: stats.totalTokens,
    };
}
