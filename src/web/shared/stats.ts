import type {
    ModelUsageDto,
    StatsOverviewDto,
    StatsSeriesDto,
    UsageCountersDto,
} from "@heimdall/admin-contracts";

const COUNTERS = [
    "requestCount",
    "completedCount",
    "failedCount",
    "cancelledCount",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "totalTokens",
] as const;

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("统计响应格式无效。");
    }
    return value as Record<string, unknown>;
}

function counters(value: unknown): UsageCountersDto {
    const source = record(value);
    const result = {} as Record<typeof COUNTERS[number], number>;
    for (const key of COUNTERS) {
        const count = source[key];
        if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
            throw new TypeError("统计计数无效。");
        }
        result[key] = count;
    }
    return result;
}

function civilDate(value: unknown): string {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new TypeError("统计日期无效。");
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    if (
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value
    ) {
        throw new TypeError("统计日期无效。");
    }
    return value;
}

function timeZone(value: unknown): string {
    if (typeof value !== "string" || !value || value.length > 100) {
        throw new TypeError("统计时区无效。");
    }
    try {
        new Intl.DateTimeFormat("en", { timeZone: value });
    } catch {
        throw new TypeError("统计时区无效。");
    }
    return value;
}

/** Project only public DTO fields; malformed counters must not become false zeros. */
export function readStatsOverview(
    value: unknown,
    redact: (value: string) => string = (value) => value,
): StatsOverviewDto {
    const source = record(value);
    if (
        !Array.isArray(source.models) ||
        typeof source.modelsTruncated !== "boolean"
    ) {
        throw new TypeError("模型统计格式无效。");
    }
    const models = source.models.map((value): ModelUsageDto => {
        const model = record(value);
        if (model.model !== null && typeof model.model !== "string") {
            throw new TypeError("模型统计格式无效。");
        }
        return {
            model: model.model === null ? null : redact(model.model),
            ...counters(model),
        };
    });
    return {
        timeZone: timeZone(source.timeZone),
        date: civilDate(source.date),
        today: counters(source.today),
        week: counters(source.week),
        models,
        modelsTruncated: source.modelsTruncated,
    };
}

/** Dates and zero-filled natural days come from the server, never the browser clock. */
export function readStatsSeries(
    value: unknown,
    _redact?: (value: string) => string,
): StatsSeriesDto {
    const source = record(value);
    if (
        typeof source.days !== "number" || !Number.isInteger(source.days) ||
        source.days < 1 || source.days > 90 || !Array.isArray(source.series) ||
        source.series.length !== source.days
    ) throw new TypeError("用量趋势格式无效。");
    let previous = "";
    const series = source.series.map((value) => {
        const point = record(value);
        const date = civilDate(point.date);
        if (date <= previous) throw new TypeError("用量趋势日期顺序无效。");
        previous = date;
        return { date, ...counters(point) };
    });
    return { timeZone: timeZone(source.timeZone), days: source.days, series };
}
