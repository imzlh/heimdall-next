import { useEffect, useState } from "hono/jsx/dom";
import type { ConsoleSnapshot } from "@heimdall/admin-contracts/console.ts";
import { loadStatsOverview, loadStatsSeries } from "./api/stats.ts";
import { describeError } from "./api/transport.ts";

export function useStats(revision: number, initial?: ConsoleSnapshot["stats"]) {
    const [overview, setOverview] = useState(initial?.overview ?? null);
    const [series, setSeries] = useState(initial?.series ?? null);
    const [errors, setErrors] = useState(
        initial?.errors ?? { overview: "", series: "" },
    );
    const [loading, setLoading] = useState(!initial);
    useEffect(() => {
        if (revision === 0 && initial) return;
        let active = true;
        setLoading(true);
        void Promise.allSettled([loadStatsOverview(), loadStatsSeries()]).then(
            ([summary, trend]) => {
                if (!active) return;
                if (summary.status === "fulfilled") setOverview(summary.value);
                if (trend.status === "fulfilled") setSeries(trend.value);
                setErrors({
                    overview: summary.status === "fulfilled"
                        ? ""
                        : `统计读取失败：${describeError(summary.reason)}`,
                    series: trend.status === "fulfilled"
                        ? ""
                        : `趋势读取失败：${describeError(trend.reason)}`,
                });
                setLoading(false);
            },
        );
        return () => {
            active = false;
        };
    }, [revision]);
    return { overview, series, errors, loading };
}
