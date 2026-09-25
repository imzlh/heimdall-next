import type {
    ModelRankingDto,
    ModelUsageDto,
    StatsOverviewDto,
    StatsSeriesDto,
    UsageCountersDto,
} from "@heimdall/admin-contracts";
import type { RequestStore, RequestWindowStats } from "@heimdall/storage";
import {
    civilDate,
    type NaturalDay,
    naturalDay,
    recentNaturalDays,
} from "./calendar.ts";

/** Ranking rows per day. One more row is read to report truncation. */
export const MODEL_RANKING_LIMIT = 50;

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
