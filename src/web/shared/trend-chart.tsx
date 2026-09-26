import type { StatsSeriesDto } from "@heimdall/admin-contracts";

/**
 * The original console's "近 7 天用量趋势" panel: smooth daily input/output
 * token lines over the trailing seven days, drawn as inline SVG so the
 * console keeps its zero-dependency browser bundle.
 */
export interface TrendPoint {
    readonly day: string;
    readonly label: string;
    readonly input: number;
    readonly output: number;
}

const SERIES = [
    { key: "input", label: "输入", className: "trend-line-input" },
    { key: "output", label: "输出", className: "trend-line-output" },
] as const;

export function trendSeries(data: StatsSeriesDto): TrendPoint[] {
    return data.series.map((point) => ({
        day: point.date,
        label: point.date.slice(5),
        input: point.inputTokens,
        output: point.outputTokens,
    }));
}

interface Coord {
    readonly x: number;
    readonly y: number;
}

const WIDTH = 560;
const HEIGHT = 240;
const PADDING = { top: 18, right: 14, bottom: 26, left: 14 };

function scale(points: readonly TrendPoint[]) {
    const max = Math.max(
        ...points.flatMap((point) => [point.input, point.output]),
        1,
    );
    const niceMax = max <= 1 ? 1 : Math.ceil(max * 1.15);
    const innerW = WIDTH - PADDING.left - PADDING.right;
    const innerH = HEIGHT - PADDING.top - PADDING.bottom;
    const step = innerW / Math.max(points.length - 1, 1);
    const x = (index: number) => PADDING.left + index * step;
    const y = (value: number) => PADDING.top + innerH * (1 - value / niceMax);
    const input = points.map((point, index) => ({
        x: x(index),
        y: y(point.input),
    }));
    const output = points.map((point, index) => ({
        x: x(index),
        y: y(point.output),
    }));
    return { input, output, niceMax };
}

/** Straight segments do not invent negative values or overshoot daily totals. */
function smoothPath(coords: readonly Coord[]): string {
    const first = coords[0];
    if (!first || coords.length < 2) return "";
    let path = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;
    for (let index = 1; index < coords.length; index++) {
        const current = coords[index];
        if (!current) break;
        path += ` L ${current.x.toFixed(2)} ${current.y.toFixed(2)}`;
    }
    return path;
}

function formatTokens(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return String(value);
}

function areaPath(coords: readonly Coord[], line: string): string {
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (!first || !last || !line) return "";
    const baseline = PADDING.top + (HEIGHT - PADDING.top - PADDING.bottom);
    return `${line} L ${last.x.toFixed(2)} ${baseline} L ${
        first.x.toFixed(2)
    } ${baseline} Z`;
}

export function TrendChart({ data }: { data: StatsSeriesDto }) {
    const points = trendSeries(data);
    const hasData = points.some((point) => point.input > 0 || point.output > 0);
    if (!hasData) {
        return (
            <p class="trend-empty">
                {data.series.some((point) => point.requestCount > 0)
                    ? "已有请求，尚未报告输入与输出 Token 用量。"
                    : "这段时间暂无请求，产生用量后会显示趋势。"}
            </p>
        );
    }
    const { input, output, niceMax } = scale(points);
    const inputLine = smoothPath(input);
    const outputLine = smoothPath(output);
    const gridLines = [0, 1 / 3, 2 / 3, 1].map((ratio) =>
        PADDING.top + (HEIGHT - PADDING.top - PADDING.bottom) * ratio
    );
    return (
        <div class="trend-chart-wrap">
            <div class="trend-legend" aria-hidden="true">
                {SERIES.map((series) => (
                    <span key={series.key} class={`trend-${series.key}`}>
                        {series.label}
                    </span>
                ))}
            </div>
            <svg
                class="trend-canvas"
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                role="img"
                aria-label={`用量趋势折线图，按 ${data.timeZone} 自然日统计 ${
                    data.series[0]?.date
                } 至 ${data.series.at(-1)?.date} 的输入与输出 Token。`}
            >
                <defs>
                    <linearGradient
                        id="trend-fill-input"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                    >
                        <stop
                            offset="0%"
                            stop-color="var(--accent)"
                            stop-opacity="0.16"
                        />
                        <stop
                            offset="100%"
                            stop-color="var(--accent)"
                            stop-opacity="0"
                        />
                    </linearGradient>
                    <linearGradient
                        id="trend-fill-output"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                    >
                        <stop
                            offset="0%"
                            stop-color="var(--success)"
                            stop-opacity="0.16"
                        />
                        <stop
                            offset="100%"
                            stop-color="var(--success)"
                            stop-opacity="0"
                        />
                    </linearGradient>
                </defs>
                {gridLines.map((y, index) => (
                    <line
                        key={index}
                        x1={PADDING.left}
                        x2={WIDTH - PADDING.right}
                        y1={y}
                        y2={y}
                        class="trend-grid"
                    />
                ))}
                <text
                    x={PADDING.left}
                    y={PADDING.top - 6}
                    class="trend-max-label"
                >
                    {formatTokens(niceMax)}
                </text>
                <path
                    d={areaPath(input, inputLine)}
                    fill="url(#trend-fill-input)"
                />
                <path
                    d={areaPath(output, outputLine)}
                    fill="url(#trend-fill-output)"
                />
                {inputLine && (
                    <path d={inputLine} class="trend-line trend-line-input" />
                )}
                {outputLine && (
                    <path
                        d={outputLine}
                        class="trend-line trend-line-output"
                    />
                )}
                {points.map((point, index) => {
                    const inCoord = input[index];
                    const outCoord = output[index];
                    if (!inCoord || !outCoord) return null;
                    return (
                        <g key={point.day}>
                            <circle
                                cx={inCoord.x}
                                cy={inCoord.y}
                                r={3.5}
                                class="trend-dot trend-dot-input"
                            >
                                <title>
                                    {`${point.day} 输入 · ${
                                        formatTokens(point.input)
                                    } tokens`}
                                </title>
                            </circle>
                            <circle
                                cx={outCoord.x}
                                cy={outCoord.y}
                                r={3.5}
                                class="trend-dot trend-dot-output"
                            >
                                <title>
                                    {`${point.day} 输出 · ${
                                        formatTokens(point.output)
                                    } tokens`}
                                </title>
                            </circle>
                            <text
                                x={inCoord.x}
                                y={HEIGHT - 8}
                                text-anchor="middle"
                                class="trend-day-label"
                            >
                                {point.label}
                            </text>
                        </g>
                    );
                })}
            </svg>
        </div>
    );
}
