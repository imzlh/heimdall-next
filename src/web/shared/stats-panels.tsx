import type {
    StatsOverviewDto,
    StatsSeriesDto,
    StatsTrendDto,
    StatsTrendMode,
    StatsTrendPointDto,
    ModelUsageDto,
} from "@heimdall/admin-contracts";
import {
    dayTrendPoints,
    intervalTrendPoints,
    TrendChart,
} from "./trend-chart.tsx";

/** SSR snapshots omit the interactive fields; the island supplies them. */
export interface StatsView {
    readonly overview?: StatsOverviewDto | null;
    readonly series?: StatsSeriesDto | null;
    readonly trend?: StatsTrendDto | null;
    readonly mode?: StatsTrendMode;
    readonly onModeChange?: (mode: StatsTrendMode) => void;
    readonly errors?: { readonly overview: string; readonly series: string };
}

const TREND_MODES: readonly StatsTrendMode[] = ["day", "hour", "recent"];

const TREND_MODE_LABELS: Record<StatsTrendMode, string> = {
    day: "近7天",
    hour: "24小时",
    recent: "近期",
};

const TREND_TITLES: Record<StatsTrendMode, string> = {
    day: "近 7 天用量趋势",
    hour: "近 24 小时用量趋势",
    recent: "近期用量趋势",
};

function count(value: number | undefined): string {
    return value === undefined ? "—" : value.toLocaleString("zh-CN");
}

function bucketWord(minutes: number): string {
    if (minutes === 1440) return "每日";
    if (minutes === 60) return "每小时";
    return `每 ${minutes} 分钟`;
}

function stamp(point: StatsTrendPointDto, mode: StatsTrendMode): string {
    return mode === "day" ? point.day : `${point.day} ${point.label}`;
}

function trendNote(trend: StatsTrendDto): string {
    const first = trend.series[0];
    const last = trend.series[trend.series.length - 1];
    return [
        first && last
            ? `${stamp(first, trend.mode)} – ${stamp(last, trend.mode)}`
            : "",
        bucketWord(trend.bucketMinutes),
        trend.fallback ? "今日暂无用量，显示近 24 小时" : "",
        trend.timeZone,
    ].filter(Boolean).join(" · ");
}

function ModelRows({ models, offset = 0, maximum }: {
    models: readonly ModelUsageDto[];
    offset?: number;
    maximum: number;
}) {
    return (
        <div class="channel-ranking">
            {models.map((item, index) => (
                <div class="rank-row" key={`${offset + index}:${item.model}`}>
                    <div class="rank-head">
                        <span class="rank-index">
                            {String(index + offset + 1).padStart(2, "0")}
                        </span>
                        <span
                            class="rank-name"
                            title={item.model ?? "未指定模型"}
                        >
                            {item.model ?? "未指定模型"}
                        </span>
                        <span class="rank-value">
                            {count(item.requestCount)} 次
                        </span>
                    </div>
                    <div class="rank-bar" aria-hidden="true">
                        <div
                            class="rank-bar-fill"
                            style={`width:${
                                Math.max(item.requestCount / maximum * 100, 1)
                                    .toFixed(1)
                            }%`}
                        />
                    </div>
                </div>
            ))}
        </div>
    );
}

/** Static presentation shared by SSR and its island, with no browser clock. */
export function StatsPanels({ stats, loading = false }: {
    stats?: StatsView;
    loading?: boolean;
}) {
    const overview = stats?.overview;
    const series = stats?.series;
    const trend = stats?.trend;
    const mode = stats?.mode ?? "day";
    const today = overview?.today;
    const week = overview?.week;
    const ranking = overview?.models ?? [];
    const maximum = Math.max(1, ...ranking.map((item) => item.requestCount));
    const unavailable = loading ? "正在读取统计…" : "统计暂不可用";
    // Each endpoint can refresh independently. Keep the chart's total and
    // calendar label with its own series when another panel is stale.
    const activeSeries = mode === "day" ? series : trend;
    const trendTotal = activeSeries?.series.reduce(
        (total, point) => total + point.totalTokens,
        0,
    );
    // Cached tokens come out of the prompt, so they are the share worth surfacing.
    const cachedToday = today?.cachedInputTokens ?? 0;
    const cacheBase = (today?.inputTokens ?? 0) + cachedToday;
    const cacheShare = today && cachedToday > 0 && cacheBase > 0
        ? ` ${(cachedToday / cacheBase * 100).toFixed(1)}%`
        : "";
    const dayFirst = series?.series[0];
    const dayLast = series && series.series[series.series.length - 1];
    return (
        <div class="overview-statistics" aria-busy={loading ? "true" : "false"}>
            <section class="stats-grid" aria-label="用量概况">
                <article class="stat-card">
                    <h2>今日输入</h2>
                    <strong>{count(today?.inputTokens)}</strong>
                    <p>
                        {today
                            ? `缓存 ${count(cachedToday)}${cacheShare}`
                            : unavailable}
                    </p>
                </article>
                <article class="stat-card">
                    <h2>今日输出</h2>
                    <strong>{count(today?.outputTokens)}</strong>
                    <p>模型生成</p>
                </article>
                <article class="stat-card">
                    <h2>今日总 Token</h2>
                    <strong>{count(today?.totalTokens)}</strong>
                    <p>
                        {count(today?.requestCount)} 次请求
                        {today && today.failedCount > 0
                            ? ` · 失败 ${count(today.failedCount)}`
                            : ""}
                    </p>
                </article>
                <article class="stat-card">
                    <h2>近 7 天总 Token</h2>
                    <strong>{count(week?.totalTokens)}</strong>
                    <p>{count(week?.requestCount)} 次请求 · 含今日</p>
                </article>
            </section>
            {stats?.errors?.overview && (
                <p class="form-error" role="alert">
                    {stats.errors.overview}
                    {overview ? "；显示上次读取的统计。" : ""}
                </p>
            )}
            <div class="token-overview">
                <section
                    class="token-panel token-panel-hero"
                    aria-label="用量趋势"
                >
                    <div class="token-panel-head">
                        <div>
                            <p class="eyebrow">Usage Trend</p>
                            <h3>{TREND_TITLES[mode]}</h3>
                        </div>
                        <div class="trend-head-side">
                            <div
                                class="trend-modes"
                                role="tablist"
                                aria-label="趋势范围"
                            >
                                {TREND_MODES.map((item) => (
                                    <button
                                        key={item}
                                        type="button"
                                        role="tab"
                                        aria-selected={item === mode}
                                        class={`trend-mode${
                                            item === mode ? " is-active" : ""
                                        }`}
                                        disabled={
                                            !stats?.onModeChange || loading
                                        }
                                        onClick={() =>
                                            stats?.onModeChange?.(item)}
                                    >
                                        {TREND_MODE_LABELS[item]}
                                    </button>
                                ))}
                            </div>
                            <span class="token-total">
                                {count(trendTotal)}
                            </span>
                        </div>
                    </div>
                    {stats?.errors?.series && (
                        <p class="form-error" role="alert">
                            {stats.errors.series}
                            {activeSeries ? "；显示上次读取的趋势。" : ""}
                        </p>
                    )}
                    {mode === "day"
                        ? (
                            series && dayFirst && dayLast
                                ? (
                                    <>
                                        <TrendChart
                                            points={dayTrendPoints(series)}
                                            ariaLabel={`用量趋势折线图，按 ${series.timeZone} 自然日统计 ${dayFirst.date} 至 ${dayLast.date} 的输入与输出 Token。`}
                                        />
                                        <p class="ranking-note">
                                            {dayFirst.date} 至 {dayLast.date}{" "}
                                            · {series.timeZone}
                                        </p>
                                        <details class="usage-history">
                                            <summary>
                                                查看每日明细 · {series.days} 天
                                            </summary>
                                            <div class="table-wrap">
                                                <table class="request-table">
                                                    <thead>
                                                        <tr>
                                                            <th scope="col">
                                                                日期
                                                            </th>
                                                            <th scope="col">
                                                                请求
                                                            </th>
                                                            <th scope="col">
                                                                输入
                                                            </th>
                                                            <th scope="col">
                                                                输出
                                                            </th>
                                                            <th scope="col">
                                                                总 Token
                                                            </th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {series.series.map((
                                                            point,
                                                        ) => (
                                                            <tr
                                                                key={point.date}
                                                            >
                                                                <th scope="row">
                                                                    {point
                                                                        .date}
                                                                </th>
                                                                <td>
                                                                    {count(
                                                                        point
                                                                            .requestCount,
                                                                    )}
                                                                </td>
                                                                <td>
                                                                    {count(
                                                                        point
                                                                            .inputTokens,
                                                                    )}
                                                                </td>
                                                                <td>
                                                                    {count(
                                                                        point
                                                                            .outputTokens,
                                                                    )}
                                                                </td>
                                                                <td>
                                                                    {count(
                                                                        point
                                                                            .totalTokens,
                                                                    )}
                                                                </td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </details>
                                    </>
                                )
                                : (
                                    <p class="trend-empty">
                                        {loading
                                            ? "正在读取趋势…"
                                            : "用量趋势暂不可用。"}
                                    </p>
                                )
                        )
                        : (
                            trend
                                ? (
                                    <>
                                        <TrendChart
                                            points={intervalTrendPoints(trend)}
                                            ariaLabel={`用量趋势折线图，${bucketWord(trend.bucketMinutes)}统计 ${stamp(trend.series[0]!, trend.mode)} 至 ${stamp(trend.series[trend.series.length - 1]!, trend.mode)} 的输入与输出 Token。`}
                                        />
                                        <p class="ranking-note">
                                            {trendNote(trend)}
                                        </p>
                                    </>
                                )
                                : (
                                    <p class="trend-empty">
                                        {loading
                                            ? "正在读取趋势…"
                                            : "用量趋势暂不可用。"}
                                    </p>
                                )
                        )}
                </section>
                <section class="token-panel" aria-label="模型调用排行">
                    <div class="token-panel-head compact">
                        <div>
                            <p class="eyebrow">Models</p>
                            <h3>今日模型调用排行</h3>
                        </div>
                    </div>
                    {ranking.length > 0
                        ? (
                            <>
                                <ModelRows
                                    models={ranking.slice(0, 5)}
                                    maximum={maximum}
                                />
                                {ranking.length > 5 && (
                                    <details class="usage-history">
                                        <summary>
                                            展开其余 {ranking.length - 5} 个模型
                                        </summary>
                                        <ModelRows
                                            models={ranking.slice(5)}
                                            offset={5}
                                            maximum={maximum}
                                        />
                                    </details>
                                )}
                            </>
                        )
                        : (
                            <p class="trend-empty">
                                {overview
                                    ? "今日暂无模型调用记录。"
                                    : unavailable}
                            </p>
                        )}
                    {overview && (
                        <p class="ranking-note">
                            {overview.date} · {overview.timeZone} ·{" "}
                            {count(overview.today.requestCount)} 次请求
                            {overview.modelsTruncated &&
                                `；仅显示前 ${ranking.length} 个模型`}
                        </p>
                    )}
                </section>
            </div>
        </div>
    );
}
