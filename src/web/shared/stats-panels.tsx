import type { ConsoleSnapshot } from "@heimdall/admin-contracts/console.ts";
import type { ModelUsageDto } from "@heimdall/admin-contracts";
import { TrendChart } from "./trend-chart.tsx";

function count(value: number | undefined): string {
    return value === undefined ? "—" : value.toLocaleString("zh-CN");
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
    stats?: ConsoleSnapshot["stats"];
    loading?: boolean;
}) {
    const overview = stats?.overview;
    const series = stats?.series;
    const today = overview?.today;
    const week = overview?.week;
    const ranking = overview?.models ?? [];
    const maximum = Math.max(1, ...ranking.map((item) => item.requestCount));
    const unavailable = loading ? "正在读取统计…" : "统计暂不可用";
    const summaryDate = overview
        ? `${overview.date} · ${overview.timeZone}`
        : unavailable;
    return (
        <div class="overview-statistics" aria-busy={loading ? "true" : "false"}>
            <section class="stats-grid" aria-label="用量概况">
                <article class="stat-card">
                    <h2>今日输入</h2>
                    <strong>{count(today?.inputTokens)}</strong>
                    <p>{summaryDate}</p>
                </article>
                <article class="stat-card">
                    <h2>今日输出</h2>
                    <strong>{count(today?.outputTokens)}</strong>
                    <p>模型报告的输出 Token</p>
                </article>
                <article class="stat-card">
                    <h2>今日总 Token</h2>
                    <strong>{count(today?.totalTokens)}</strong>
                    <p>{count(today?.requestCount)} 次请求</p>
                </article>
                <article class="stat-card">
                    <h2>近 7 天总 Token</h2>
                    <strong>{count(week?.totalTokens)}</strong>
                    <p>{count(week?.requestCount)} 次请求 · 含今日</p>
                </article>
            </section>
            {stats?.errors.overview && (
                <p class="form-error" role="alert">
                    {stats.errors.overview}
                    {overview ? "；显示上次读取的统计。" : ""}
                </p>
            )}
            {today && (
                <div class="overview-chips" aria-label="今日请求状态">
                    <span class="overview-chip">
                        已完成 {count(today.completedCount)}
                    </span>
                    <span
                        class={`overview-chip ${
                            today.failedCount > 0 ? "chip-alert" : ""
                        }`}
                    >
                        失败 {count(today.failedCount)}
                    </span>
                    <span class="overview-chip">
                        已取消 {count(today.cancelledCount)}
                    </span>
                    <span class="overview-chip">
                        进行中 {count(
                            Math.max(
                                0,
                                today.requestCount - today.completedCount -
                                    today.failedCount - today.cancelledCount,
                            ),
                        )}
                    </span>
                </div>
            )}
            <div class="token-overview">
                <section
                    class="token-panel token-panel-hero"
                    aria-label="用量趋势"
                >
                    <div class="token-panel-head">
                        <div>
                            <p class="eyebrow">Usage Trend</p>
                            <h3>近 7 天用量趋势</h3>
                        </div>
                        <span class="token-total">
                            {count(week?.totalTokens)}
                        </span>
                    </div>
                    {stats?.errors.series && (
                        <p class="form-error" role="alert">
                            {stats.errors.series}
                            {series ? "；显示上次读取的趋势。" : ""}
                        </p>
                    )}
                    {series
                        ? (
                            <>
                                <TrendChart data={series} />
                                <p class="ranking-note">
                                    {series.series[0]?.date} 至{" "}
                                    {series.series.at(-1)?.date} ·{" "}
                                    {series.timeZone}
                                </p>
                                <details class="usage-history">
                                    <summary>
                                        查看每日明细 · {series.days} 天
                                    </summary>
                                    <div class="table-scroll">
                                        <table class="data-table">
                                            <thead>
                                                <tr>
                                                    <th scope="col">日期</th>
                                                    <th scope="col">请求</th>
                                                    <th scope="col">输入</th>
                                                    <th scope="col">输出</th>
                                                    <th scope="col">
                                                        总 Token
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {series.series.map((point) => (
                                                    <tr key={point.date}>
                                                        <th scope="row">
                                                            {point.date}
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
                            {overview.date} · {overview.timeZone} · 按当日{" "}
                            {count(overview.today.requestCount)} 次请求统计
                            {overview.modelsTruncated &&
                                `；仅显示前 ${ranking.length} 个模型。`}
                        </p>
                    )}
                </section>
            </div>
        </div>
    );
}
