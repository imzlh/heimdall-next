import { Hono } from "hono";
import type { Context } from "hono";
import type {
    SystemLogLevel,
    SystemLogListResponse,
} from "@heimdall/admin-contracts/system-log.ts";
import { SYSTEM_LOG_LEVELS } from "@heimdall/admin-contracts/system-log.ts";
import type { ServerApp, ServerEnv } from "./app.ts";
import {
    MAX_SYSTEM_LOG_LIMIT,
    type SystemLog,
} from "@heimdall/core/observability/system-log.ts";

const REQUEST_ID = "x-heimdall-request-id";

/**
 * Read-only operator route for the in-memory system log. The buffer holds the
 * service's own operational events and is cleared on restart; the route only
 * ever reads it.
 */
export function createSystemLogRoutes(log: SystemLog): ServerApp {
    const app = new Hono<ServerEnv>();

    app.get("/system-logs", (context) => {
        const requestId = currentRequestId(context);
        const level = context.req.query("level");
        if (level !== undefined && !isLevel(level)) {
            return errorResponse(
                requestId,
                400,
                "invalid_request",
                "level must be debug, info, warn or error",
            );
        }
        const afterSeq = numeric(context.req.query("afterSeq"));
        if (afterSeq === "invalid") {
            return errorResponse(
                requestId,
                400,
                "invalid_request",
                "afterSeq must be a non-negative integer",
            );
        }
        const limit = numeric(context.req.query("limit"));
        if (limit === "invalid" || limit === 0) {
            return errorResponse(
                requestId,
                400,
                "invalid_request",
                `limit must be between 1 and ${MAX_SYSTEM_LOG_LIMIT}`,
            );
        }
        const payload: SystemLogListResponse = log.list({
            level: level as SystemLogLevel | undefined,
            afterSeq: afterSeq === undefined ? undefined : afterSeq,
            limit: limit === undefined ? undefined : limit,
        });
        return json(payload, requestId);
    });

    return app;
}

function isLevel(value: string): value is SystemLogLevel {
    return (SYSTEM_LOG_LEVELS as readonly string[]).includes(value);
}

/** undefined when absent, "invalid" when present but not a non-negative int. */
function numeric(value: string | undefined): number | undefined | "invalid" {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : "invalid";
}

function currentRequestId(context: Context<ServerEnv>): string {
    return context.get("requestId") ||
        context.req.header("x-request-id")?.trim() || crypto.randomUUID();
}

function json(payload: unknown, requestId: string): Response {
    return Response.json(payload, {
        status: 200,
        headers: { [REQUEST_ID]: requestId },
    });
}

function errorResponse(
    requestId: string,
    status: number,
    code: string,
    message: string,
): Response {
    return Response.json({
        error: { code, message, request_id: requestId },
    }, { status, headers: { [REQUEST_ID]: requestId } });
}
