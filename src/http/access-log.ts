import type { MiddlewareHandler } from "hono";
import type { ServerEnv } from "./app.ts";

/** Options for the console access log. */
export interface AccessLogOptions {
    /** Sink for one formatted line per request. Defaults to `console.log`. */
    readonly log?: (line: string) => void;
    /** Colorize output. Defaults to whether stdout is a terminal. */
    readonly color?: boolean;
    /** Clock, injectable for tests. Defaults to the current time. */
    readonly now?: () => Date;
}

const RESET = "\x1b[0m";

/** Status buckets by foreground color: 2xx green, 3xx cyan, 4xx yellow, 5xx red. */
function statusColor(status: number): string {
    if (status >= 500) return "\x1b[31m";
    if (status >= 400) return "\x1b[33m";
    if (status >= 300) return "\x1b[36m";
    return "\x1b[32m";
}

function methodColor(method: string): string {
    switch (method) {
        case "GET":
            return "\x1b[34m";
        case "POST":
            return "\x1b[32m";
        case "PUT":
            return "\x1b[33m";
        case "DELETE":
            return "\x1b[31m";
        case "PATCH":
            return "\x1b[36m";
        default:
            return "\x1b[35m";
    }
}

function paint(color: boolean, code: string, text: string): string {
    return color ? `${code}${text}${RESET}` : text;
}

/** Human-friendly latency, mirroring Go's duration scaling. */
function formatLatency(ms: number): string {
    if (ms < 1) return `${Math.round(ms * 1000)}us`;
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function clock(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${
        pad(date.getSeconds())
    }`;
}

function clientIp(
    context: Parameters<MiddlewareHandler<ServerEnv>>[0],
): string {
    const env = context.env as
        | { remoteAddr?: { hostname?: string } }
        | undefined;
    const direct = env?.remoteAddr?.hostname;
    if (direct) return direct;
    const forwarded = context.req.header("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0]!.trim();
    return context.req.header("x-real-ip")?.trim() || "-";
}

/**
 * A compact, Gin-inspired access log: `time status method path latency ip`,
 * one line per request. Status and method are foreground-colored; it never
 * reads the response body, so streaming responses are untouched.
 */
export function createAccessLog(
    options: AccessLogOptions = {},
): MiddlewareHandler<ServerEnv> {
    const log = options.log ?? ((line: string) => console.log(line));
    const color = options.color ??
        (typeof Deno !== "undefined" && Deno.stdout.isTerminal());
    const now = options.now ?? (() => new Date());
    return async (context, next) => {
        const started = performance.now();
        // A WebSocket upgrade yields a native response Deno must return
        // untouched; running post-`next()` logic around it discards the upgrade
        // and crashes the handshake ("Upgrade response was not returned from
        // callback"). Log the 101 up front and hand the response straight back.
        if (context.req.header("upgrade")?.toLowerCase() === "websocket") {
            const method = context.req.method;
            const path = new URL(context.req.url).pathname;
            log(
                `${clock(now())} ${paint(color, statusColor(101), "101")} ${
                    paint(color, methodColor(method), method.padEnd(6))
                } ${path} ${"-".padStart(7)} ${clientIp(context)}`,
            );
            return await next();
        }
        try {
            await next();
        } finally {
            const status = context.res.status;
            // A proxy/bridge endpoint may name the target it dispatched to; show
            // that as `PROXY → GET /api/admin/...` instead of the opaque bridge
            // method and path (`POST /admin/ui/request`), which say nothing.
            const proxied = context.get("accessLogTarget");
            const method = proxied ? "PROXY" : context.req.method;
            const path = proxied
                ? `→ ${proxied}`
                : new URL(context.req.url).pathname;
            const latency = formatLatency(performance.now() - started);
            log(
                `${clock(now())} ${
                    paint(color, statusColor(status), String(status))
                } ${
                    paint(color, methodColor(method), method.padEnd(6))
                } ${path} ${latency.padStart(7)} ${clientIp(context)}`,
            );
        }
    };
}
