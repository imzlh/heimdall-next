import { Hono } from "hono";
import type { Context } from "hono";
import type {
    FrameDto,
    RequestDetailDto,
    RequestStatusDto,
    RequestSummaryDto,
    UsageDayDto,
    UsageDto,
    UsageTotalsDto,
} from "@heimdall/admin-contracts";
import type {
    RequestRecord,
    RequestStatus,
    RequestStore,
    StoredFrame,
    UsageRecord,
} from "@heimdall/storage";
import type { ServerApp, ServerEnv } from "./app.ts";
import { type StatsClock, statsSeries } from "../stats/report.ts";

const REQUEST_ID = "x-heimdall-request-id";
const STATUSES = new Set<RequestStatus>([
    "pending",
    "running",
    "completed",
    "error",
    "cancelled",
]);

/**
 * Read-only operator routes for the request journal.
 *
 * Paths stay exact. Identifiers are query parameters, matching the rest of
 * the management API except the single `/plugin/:id` route.
 */
export function createRequestJournalRoutes(
    store: RequestStore,
    clock: StatsClock,
): ServerApp {
    const app = new Hono<ServerEnv>();

    app.get("/requests", (context) => {
        const requestId = currentRequestId(context);
        const id = context.req.query("id")?.trim();
        if (id !== undefined && id.length > 0) {
            assertId(id);
            const record = store.getRequest(id);
            if (record === null) {
                return errorResponse(
                    requestId,
                    404,
                    "not_found",
                    `request not found: ${id}`,
                );
            }
            const frames = store.listFrames(
                id,
                -1,
                queryLimit(context, "frameLimit", 100, 200),
            );
            const body: {
                request: RequestDetailDto;
                frames: FrameDto[];
            } = {
                request: toDetail(record, store.getUsage(id)),
                frames: frames.map(toFrame),
            };
            return json(requestId, body);
        }
        const records = store.listRequests({
            status: queryStatus(context),
            before: queryTimestamp(context, "before"),
            limit: queryLimit(context, "limit", 50, 100),
        });
        return json(requestId, { requests: records.map(toSummary) });
    });

    app.get("/usage", (context) => {
        const requestId = currentRequestId(context);
        const from = queryTimestamp(context, "from");
        const until = queryTimestamp(context, "until");
        const totals = store.usageTotals(from, until);
        const body: { usage: UsageTotalsDto; days?: UsageDayDto[] } = {
            usage: totals,
        };
        if (from === undefined && until === undefined) {
            body.days = recentUsageDays(store, clock);
        }
        return json(requestId, body);
    });

    return app;
}

/** The last seven natural days, oldest first, in the statistics zone. */
function recentUsageDays(
    store: RequestStore,
    clock: StatsClock,
): UsageDayDto[] {
    return statsSeries(store, clock, 7).series.map((point) => ({
        day: point.date,
        requestCount: point.requestCount,
        inputTokens: point.inputTokens,
        outputTokens: point.outputTokens,
        totalTokens: point.totalTokens,
    }));
}

function toSummary(record: RequestRecord): RequestSummaryDto {
    return {
        requestId: record.requestId,
        status: record.status,
        receivedAt: record.receivedAt,
        streamId: record.streamId,
        operation: record.operation,
        model: record.model,
        completedAt: record.completedAt,
        protocolPluginId: record.protocolPluginId,
        upstreamPluginId: record.upstreamPluginId,
    };
}

function toDetail(
    record: RequestRecord,
    usage: UsageRecord | null,
): RequestDetailDto {
    return {
        ...toSummary(record),
        request: record.request,
        response: record.response,
        error: record.error,
        usage: usage === null ? null : toUsage(usage),
    };
}

function toUsage(usage: UsageRecord): UsageDto {
    return {
        requestId: usage.requestId,
        updatedAt: usage.updatedAt,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        totalTokens: usage.totalTokens,
        cost: usage.cost,
        currency: usage.currency,
    };
}

function toFrame(frame: StoredFrame): FrameDto {
    return {
        version: frame.version,
        streamId: frame.streamId,
        requestId: frame.requestId,
        seq: frame.seq,
        eventId: frame.eventId,
        timestamp: frame.timestamp,
        event: frame.event,
        causationId: frame.causationId,
    };
}

function queryStatus(context: Context<ServerEnv>): RequestStatus | undefined {
    const value = context.req.query("status")?.trim();
    if (value === undefined || value.length === 0) return undefined;
    if (!STATUSES.has(value as RequestStatus)) {
        throw new JournalRouteError(
            400,
            "invalid_request",
            "status is not a known request status",
        );
    }
    return value as RequestStatusDto;
}

function queryTimestamp(
    context: Context<ServerEnv>,
    name: string,
): string | undefined {
    const value = context.req.query(name)?.trim();
    if (value === undefined || value.length === 0) return undefined;
    if (
        !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+\-Z]+$/.test(value) ||
        value.length > 40
    ) {
        throw new JournalRouteError(
            400,
            "invalid_request",
            `${name} must be an ISO-8601 timestamp`,
        );
    }
    return value;
}

function queryLimit(
    context: Context<ServerEnv>,
    name: string,
    fallback: number,
    max: number,
): number {
    const raw = context.req.query(name)?.trim();
    if (raw === undefined || raw.length === 0) return fallback;
    if (!/^[1-9][0-9]*$/.test(raw)) {
        throw new JournalRouteError(
            400,
            "invalid_request",
            `${name} must be a positive integer`,
        );
    }
    return Math.min(Number(raw), max);
}

function assertId(id: string): void {
    if (id.length > 200 || id.includes("/") || id.includes("\\")) {
        throw new JournalRouteError(
            400,
            "invalid_request",
            "request id is invalid",
        );
    }
}

function currentRequestId(context: Context<ServerEnv>): string {
    return context.get("requestId") ||
        context.req.header("x-request-id")?.trim() || crypto.randomUUID();
}

function json(requestId: string, payload: unknown, status = 200): Response {
    return Response.json(payload, {
        status,
        headers: { [REQUEST_ID]: requestId },
    });
}

function errorResponse(
    requestId: string,
    status: number,
    code: string,
    message: string,
): Response {
    return json(requestId, {
        error: { code, message, request_id: requestId },
    }, status);
}

class JournalRouteError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.name = "JournalRouteError";
        this.status = status;
        this.code = code;
    }
}
