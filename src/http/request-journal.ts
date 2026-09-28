import { Hono } from "hono";
import type { Context } from "hono";
import type {
    FrameDto,
    RequestDetailDto,
    RequestSummaryDto,
    UsageDayDto,
    UsageDto,
    UsageTotalsDto,
} from "@heimdall/admin-contracts";
import type {
    RequestJournalDetailResponse,
    RequestJournalListResponse,
} from "@heimdall/admin-contracts/journal.ts";
import type {
    RequestRecord,
    RequestStore,
    StoredFrame,
    UsageRecord,
} from "@heimdall/storage";
import type { ServerApp, ServerEnv } from "./app.ts";
import { type StatsClock, statsSeries } from "../stats/report.ts";
import { exportRequestJournal } from "./request-journal-export.ts";
import {
    encodeCursor,
    queryAfterSeq,
    queryCursor,
    queryId,
    queryLimit,
    querySearch,
    queryStatus,
    queryTimestamp,
} from "./request-journal-query.ts";

const REQUEST_ID = "x-heimdall-request-id";

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
        const id = queryId(context);
        if (id !== undefined) {
            const afterSeq = queryAfterSeq(context);
            const limit = queryLimit(context, "frameLimit", 100, 200);
            const record = store.getRequest(id);
            if (record === null) {
                return errorResponse(
                    requestId,
                    404,
                    "not_found",
                    `request not found: ${id}`,
                );
            }
            const window = store.listFrames(id, afterSeq, limit + 1);
            const frames = window.slice(0, limit);
            const body: RequestJournalDetailResponse = {
                request: toDetail(record, store.getUsage(id)),
                frames: frames.map(toFrame),
                nextAfterSeq: window.length > limit ? frames.at(-1)!.seq : null,
            };
            return json(requestId, body);
        }
        const limit = queryLimit(context, "limit", 50, 100);
        const records = store.listRequests({
            status: queryStatus(context),
            q: querySearch(context),
            cursor: queryCursor(context),
            before: queryTimestamp(context, "before"),
            limit: limit + 1,
        });
        const page = records.slice(0, limit);
        const body: RequestJournalListResponse = {
            requests: page.map((record) =>
                // Omit the field for rows with no usage row; carry it otherwise.
                toSummary(record, store.getUsage(record.requestId) ?? undefined)
            ),
            nextCursor: records.length > limit
                ? encodeCursor(page.at(-1)!)
                : null,
        };
        return json(requestId, body);
    });

    app.get("/requests/export", (context) => {
        const requestId = currentRequestId(context);
        const id = queryId(context, true)!;
        const record = store.getRequest(id);
        if (record === null) {
            return errorResponse(
                requestId,
                404,
                "not_found",
                `request not found: ${id}`,
            );
        }
        return exportRequestJournal(
            store,
            toDetail(record, store.getUsage(id)),
            requestId,
        );
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

function toSummary(
    record: RequestRecord,
    usage?: UsageRecord | null,
): RequestSummaryDto {
    return {
        requestId: record.requestId,
        status: record.status,
        receivedAt: record.receivedAt,
        streamId: record.streamId,
        operation: record.operation,
        model: record.model,
        completedAt: record.completedAt,
        firstTokenAt: record.firstTokenAt,
        streaming: isStreaming(record),
        protocolPluginId: record.protocolPluginId,
        upstreamPluginId: record.upstreamPluginId,
        ...(usage === undefined
            ? {}
            : { usage: usage === null ? null : toUsage(usage) }),
    };
}

/** Read the streaming intent off the stored request without decoding a body. */
function isStreaming(record: RequestRecord): boolean | undefined {
    const request = record.request;
    if (request === null || typeof request !== "object") return undefined;
    const traits = (request as { traits?: unknown }).traits;
    if (
        traits !== null && typeof traits === "object" &&
        typeof (traits as { streaming?: unknown }).streaming === "boolean"
    ) {
        return (traits as { streaming: boolean }).streaming;
    }
    const payload = (request as { payload?: unknown }).payload;
    if (
        payload !== null && typeof payload === "object" &&
        typeof (payload as { stream?: unknown }).stream === "boolean"
    ) {
        return (payload as { stream: boolean }).stream;
    }
    return undefined;
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
        metadata: record.metadata,
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
        extensions: usage.extensions,
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
        extensions: frame.extensions,
    };
}

function currentRequestId(context: Context<ServerEnv>): string {
    return context.get("requestId") ||
        context.req.header("x-request-id")?.trim() || crypto.randomUUID();
}

function json(requestId: string, payload: unknown, status = 200): Response {
    return Response.json(payload, {
        status,
        headers: { [REQUEST_ID]: requestId, "cache-control": "no-store" },
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
