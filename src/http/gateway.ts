import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/deno";
import type { ServerEnv } from "./app.ts";

/** Optional proxy-key and per-peer limit for the public `/v1` surface. */
export interface GatewayOptions {
    /** When set, `/v1` requires this bearer token or `x-api-key`. */
    readonly proxyKey?: string;
    /**
     * Accepted requests per minute for one credential and peer address.
     * `0` disables the limit. The default used by the executable is 120.
     */
    readonly limitPerMinute?: number;
    /** Read on every request so operator settings apply without a restart. */
    readonly settings?: () => {
        readonly proxyKey?: string;
        readonly limitPerMinute?: number;
    };
    readonly now?: () => number;
}

interface Bucket {
    window: number;
    count: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Gate the public inference API. Admin routes keep their own bearer check.
 * The peer address comes from the connection, never from forwarded headers.
 */
export function createGatewayMiddleware(
    options: GatewayOptions,
): MiddlewareHandler<ServerEnv> {
    const read = options.settings;
    const now = options.now ?? Date.now;
    return async (context, next) => {
        const requestId = context.get("requestId");
        const current = read?.() ?? options;
        const proxyKey = current.proxyKey?.trim() ?? "";
        const limit = current.limitPerMinute ?? 0;
        if (limit < 0 || !Number.isInteger(limit)) {
            throw new TypeError(
                "limitPerMinute must be a non-negative integer",
            );
        }
        if (proxyKey.length > 0 && presentedKey(context) !== proxyKey) {
            context.res = jsonError(
                requestId,
                401,
                "unauthorized",
                "proxy key required",
            );
            return;
        }
        if (limit > 0 && !allow(proxyKey, peerAddress(context), limit, now())) {
            context.res = jsonError(
                requestId,
                429,
                "rate_limited",
                "rate limit exceeded",
            );
            return;
        }
        await next();
    };
}

function presentedKey(
    context: Parameters<MiddlewareHandler<ServerEnv>>[0],
): string {
    const authorization = context.req.header("authorization") ?? "";
    if (authorization.startsWith("Bearer ")) {
        return authorization.slice("Bearer ".length).trim();
    }
    return context.req.header("x-api-key")?.trim() ?? "";
}

function peerAddress(
    context: Parameters<MiddlewareHandler<ServerEnv>>[0],
): string {
    try {
        return getConnInfo(context).remote.address || "local";
    } catch {
        return "local";
    }
}

function allow(
    proxyKey: string,
    peer: string,
    limit: number,
    now: number,
): boolean {
    const window = Math.floor(now / 60_000);
    const id = `${proxyKey.length > 0 ? "key" : "open"}\0${peer}`;
    const current = buckets.get(id);
    const count = current !== undefined && current.window === window
        ? current.count + 1
        : 1;
    buckets.set(id, { window, count });
    if (buckets.size > 10_000) {
        for (const [key, bucket] of buckets) {
            if (bucket.window < window) buckets.delete(key);
        }
    }
    return count <= limit;
}

function jsonError(
    requestId: string,
    status: number,
    code: string,
    message: string,
): Response {
    return Response.json({
        error: { code, message, request_id: requestId },
    }, {
        status,
        headers: { "x-heimdall-request-id": requestId },
    });
}
