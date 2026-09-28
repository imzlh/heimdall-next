import type {
    StatsOverviewDto,
    StatsSeriesDto,
    StatsTrendDto,
    StatsTrendMode,
} from "@heimdall/admin-contracts";
import {
    readStatsOverview,
    readStatsSeries,
    readStatsTrend,
} from "../../shared/stats.ts";
import { AdminApiError, request } from "./transport.ts";

export async function loadStatsOverview(): Promise<StatsOverviewDto> {
    const data = await request("/api/admin/stats");
    try {
        return readStatsOverview(data);
    } catch {
        throw new AdminApiError("统计响应格式无效。", {
            code: "invalid_response",
        });
    }
}

export async function loadStatsSeries(days = 7): Promise<StatsSeriesDto> {
    if (!Number.isInteger(days) || days < 1 || days > 90) {
        throw new RangeError("趋势天数必须是 1 至 90 的整数。");
    }
    const data = await request(`/api/admin/stats/series?days=${days}`);
    try {
        const series = readStatsSeries(data);
        if (series.days !== days) throw new TypeError("Unexpected date window");
        return series;
    } catch {
        throw new AdminApiError("用量趋势响应格式无效。", {
            code: "invalid_response",
        });
    }
}

export async function loadStatsTrend(
    mode: StatsTrendMode,
): Promise<StatsTrendDto> {
    if (mode !== "day" && mode !== "hour" && mode !== "recent") {
        throw new RangeError("趋势模式必须是 day、hour 或 recent。");
    }
    const data = await request(`/api/admin/stats/trend?mode=${mode}`);
    try {
        const trend = readStatsTrend(data);
        if (trend.mode !== mode) throw new TypeError("Unexpected trend mode");
        return trend;
    } catch {
        throw new AdminApiError("用量趋势响应格式无效。", {
            code: "invalid_response",
        });
    }
}
