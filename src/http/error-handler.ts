import type { ErrorHandler, NotFoundHandler } from "hono";
import type { ServerEnv } from "./app.ts";

interface ErrorBody {
    readonly error: {
        readonly code: string;
        readonly message: string;
        readonly request_id: string;
    };
}

const requestIdHeader = "x-heimdall-request-id";

export const errorHandler: ErrorHandler<ServerEnv> = (error, context) => {
    const requestId = getRequestId(context);
    const status = errorStatus(error);
    const exposed = status < 500;
    const code = errorCode(error, exposed);
    const body: ErrorBody = {
        error: {
            code,
            message: exposed ? errorMessage(error) : "internal server error",
            request_id: requestId,
        },
    };
    return Response.json(body, {
        status,
        headers: { [requestIdHeader]: requestId },
    });
};

function errorCode(error: unknown, exposed: boolean): string {
    if (typeof error === "object" && error !== null) {
        const candidate = (error as { code?: unknown }).code;
        if (
            typeof candidate === "string" && /^[a-zA-Z0-9_.-]+$/.test(candidate)
        ) {
            return candidate;
        }
    }
    return exposed ? "request_error" : "internal_error";
}

function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) {
        return error.message;
    }
    if (typeof error === "string" && error.length > 0) return error;
    return "request failed";
}

function errorStatus(error: unknown): number {
    if (typeof error !== "object" || error === null) return 500;
    const candidate = (error as { status?: unknown }).status;
    return typeof candidate === "number" &&
            Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
        ? candidate
        : 500;
}

export const notFoundHandler: NotFoundHandler<ServerEnv> = (context) => {
    const requestId = getRequestId(context);
    const body: ErrorBody = {
        error: {
            code: "route_not_found",
            message: "route not found",
            request_id: requestId,
        },
    };
    return Response.json(body, {
        status: 404,
        headers: { [requestIdHeader]: requestId },
    });
};

function getRequestId(
    context: Parameters<NotFoundHandler<ServerEnv>>[0],
): string {
    return context.get("requestId") ||
        context.req.header("x-request-id")?.trim() || crypto.randomUUID();
}
