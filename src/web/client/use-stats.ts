import { useEffect, useState } from "hono/jsx/dom";
import type { StatsTrendDto, StatsTrendMode } from "@heimdall/admin-contracts";
import type { ConsoleSnapshot } from "@heimdall/admin-contracts/console.ts";
import { loadStatsOverview, loadStatsSeries, loadStatsTrend } from "./api/stats.ts";
import { describeError } from "./api/transport.ts";

export type { StatsTrendMode };
export const TREND_MODES: readonly StatsTrendMode[] = [
    "day",
    "hour",
    "recent",
];

/**
 * Overview and trend load per endpoint so one failing panel keeps the other's
 * figures. Overview tracks only the revision; the trend also tracks its mode
 * (`day` reuses the SSR series) and caches non-day windows, so switching back
 * is instant and the next revision refreshes whichever mode is on screen.
 */
export function useStats(revision: number, initial?: ConsoleSnapshot["stats"]) {
    const [overview, setOverview] = useState(initial?.overview ?? null);
    const [series, setSeries] = useState(initial?.series ?? null);
    const [mode, setMode] = useState<StatsTrendMode>("day");
    const [trends, setTrends] = useState<
        Partial<Record<Exclude<StatsTrendMode, "day">, StatsTrendDto>>
    >({});
    const [errors, setErrors] = useState(
        initial?.errors ?? { overview: "", series: "" },
    );
    const [loading, setLoading] = useState(!initial);
    useEffect(() => {
        if (revision === 0 && initial) return;
        let active = true;
        void loadStatsOverview().then(
            (value) => {
                if (!active) return;
                setOverview(value);
                setErrors((current) => ({ ...current, overview: "" }));
            },
            (cause) => {
                if (!active) return;
                setErrors((current) => ({
                    ...current,
                    overview: `统计读取失败：${describeError(cause)}`,
                }));
            },
        );
        return () => {
            active = false;
        };
    }, [revision]);
    useEffect(() => {
        // The SSR snapshot only covers the day mode; other modes must fetch.
        if (revision === 0 && initial && mode === "day") return;
        let active = true;
        setLoading(true);
        // Tagged so the settled union narrows back to the mode's own DTO.
        const trend = mode === "day"
            ? loadStatsSeries().then((value) => ({
                kind: "day" as const,
                value,
              }))
            : loadStatsTrend(mode).then((value) => ({
                kind: "interval" as const,
                value,
              }));
        trend.then(
            (result) => {
                if (!active) return;
                if (result.kind === "day") {
                    setSeries(result.value);
                } else {
                    const fresh = result.value;
                    setTrends((current) => ({ ...current, [mode]: fresh }));
                }
                setErrors((current) => ({ ...current, series: "" }));
                setLoading(false);
            },
            (cause) => {
                if (!active) return;
                setErrors((current) => ({
                    ...current,
                    series: `趋势读取失败：${describeError(cause)}`,
                }));
                setLoading(false);
            },
        );
        return () => {
            active = false;
        };
    }, [revision, mode]);
    const trend = mode === "day" ? null : trends[mode] ?? null;
    return { overview, series, trend, mode, setMode, errors, loading };
}
