import { Hono } from "hono";
import type { Context } from "hono";
import type { StatsTrendMode } from "@heimdall/admin-contracts";
import type { ServerApp, ServerEnv } from "./app.ts";
import { isCivilDate } from "../stats/calendar.ts";
import {
    modelRanking,
    type StatsClock,
    statsOverview,
    type StatsReader,
    statsSeries,
    statsToday,
    statsTrend,
} from "../stats/report.ts";

const REQUEST_ID = "x-heimdall-request-id";
const DEFAULT_SERIES_DAYS = 7;
const MAX_SERIES_DAYS = 90;
const TREND_MODES: readonly StatsTrendMode[] = ["day", "hour", "recent"];
/** The journal cannot hold data from before this date. */
const MIN_DATE = "2020-01-01";

/**
 * Read-only usage statistics in natural days of `clock.timeZone`.
 *
 * Parameters are validated strictly. Coercing a bad `date` or clamping `days`
 * would answer a different question than the one asked while looking
 * authoritative.
 */
export function createStatsRoutes(
    reader: StatsReader,
    clock: StatsClock,
): ServerApp {
    const app = new Hono<ServerEnv>();

    app.get("/stats", (context) => json(context, statsOverview(reader, clock)));

    app.get(
        "/stats/series",
        (context) =>
            json(context, statsSeries(reader, clock, queryDays(context))),
    );

    app.get(
        "/stats/trend",
        (context) =>
            json(context, statsTrend(reader, clock, queryTrendMode(context))),
    );

    app.get("/stats/models", (context) =>
        json(
            context,
            modelRanking(reader, clock, queryDate(context, clock)),
        ));

    return app;
}

function queryDays(context: Context<ServerEnv>): number {
    const raw = context.req.query("days")?.trim();
    if (raw === undefined || raw.length === 0) return DEFAULT_SERIES_DAYS;
    const days = /^[0-9]{1,3}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!(days >= 1 && days <= MAX_SERIES_DAYS)) {
        throw new StatsRouteError(
            `days must be an integer from 1 to ${MAX_SERIES_DAYS}`,
        );
    }
    return days;
}

function queryTrendMode(context: Context<ServerEnv>): StatsTrendMode {
    const raw = context.req.query("mode")?.trim();
    if (raw === undefined || raw.length === 0) return "day";
    if (!(TREND_MODES as readonly string[]).includes(raw)) {
        throw new StatsRouteError("mode must be one of day, hour, recent");
    }
    return raw as StatsTrendMode;
}

function queryDate(context: Context<ServerEnv>, clock: StatsClock): string {
    const today = statsToday(clock);
    const raw = context.req.query("date")?.trim();
    if (raw === undefined || raw.length === 0) return today;
    if (!isCivilDate(raw)) {
        throw new StatsRouteError(
            "date must be a calendar date formatted as YYYY-MM-DD",
        );
    }
    if (raw > today) {
        throw new StatsRouteError("date must not be in the future");
    }
    if (raw < MIN_DATE) {
        throw new StatsRouteError(`date must not be earlier than ${MIN_DATE}`);
    }
    return raw;
}

function json(context: Context<ServerEnv>, payload: unknown): Response {
    const requestId = context.get("requestId") ||
        context.req.header("x-request-id")?.trim() || crypto.randomUUID();
    return Response.json(payload, { headers: { [REQUEST_ID]: requestId } });
}

class StatsRouteError extends Error {
    readonly status = 400;
    readonly code = "invalid_request";

    constructor(message: string) {
        super(message);
        this.name = "StatsRouteError";
    }
}
