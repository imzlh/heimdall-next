import type { Context, MiddlewareHandler } from "hono";
import type { ServerEnv } from "./app.ts";

const CHAT_PROTOCOL = "heimdall-chat";
const AUTH_PROTOCOL_PREFIX = "heimdall-auth.";
const REQUEST_ID = "x-heimdall-request-id";

/** Protect the single-tenant chat with the same token as the management API. */
export function createChatAuthMiddleware(
    token?: string,
): MiddlewareHandler<ServerEnv> {
    const expected = token?.trim();
    return async (context, next) => {
        const request = context.req.raw;
        const websocket = request.headers.get("upgrade")?.toLowerCase() ===
            "websocket";
        if (websocket && !hasSameOrigin(request)) {
            return reject(
                context,
                403,
                "forbidden_origin",
                "websocket origin is not allowed",
            );
        }
        if (expected !== undefined) {
            const authorization = request.headers.get("authorization");
            const supplied = authorization === null
                ? websocket ? socketToken(request) : undefined
                : authorization.startsWith("Bearer ")
                ? authorization.slice("Bearer ".length).trim()
                : undefined;
            if (expected.length === 0 || supplied !== expected) {
                return reject(
                    context,
                    401,
                    "unauthorized",
                    "admin bearer token required",
                );
            }
        }
        await next();
    };
}

/** Select only the application protocol; never echo the credential protocol. */
export function chatSocketProtocol(request: Request): string | undefined {
    return socketProtocols(request).includes(CHAT_PROTOCOL)
        ? CHAT_PROTOCOL
        : undefined;
}

function socketProtocols(request: Request): string[] {
    return (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((protocol) => protocol.trim());
}

function socketToken(request: Request): string | undefined {
    const protocols = socketProtocols(request);
    if (!protocols.includes(CHAT_PROTOCOL)) return undefined;
    const credentials = protocols.filter((protocol) =>
        protocol.startsWith(AUTH_PROTOCOL_PREFIX)
    );
    if (credentials.length !== 1) return undefined;
    const encoded = credentials[0]!.slice(AUTH_PROTOCOL_PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
    try {
        const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
        const bytes = Uint8Array.from(
            binary,
            (character) => character.charCodeAt(0),
        );
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    } catch {
        return undefined;
    }
}

function hasSameOrigin(request: Request): boolean {
    const supplied = request.headers.get("origin");
    // Tools outside a browser need not supply Origin. Browser WebSockets do.
    if (supplied === null) return true;
    let origin: URL;
    try {
        origin = new URL(supplied);
    } catch {
        return false;
    }
    if (
        (origin.protocol !== "http:" && origin.protocol !== "https:") ||
        origin.username !== "" || origin.password !== "" ||
        origin.pathname !== "/" || origin.search !== "" || origin.hash !== ""
    ) return false;

    const destination = new URL(request.url);
    if (origin.origin === destination.origin) return true;

    // A local development proxy can preserve the browser's Host while changing
    // the request URL to its upstream. Forwarded headers are not trusted here.
    const host = request.headers.get("host");
    if (host === null || /[\s,/@\\?#]/.test(host)) return false;
    try {
        return origin.origin ===
            new URL(`${destination.protocol}//${host}`).origin;
    } catch {
        return false;
    }
}

function reject(
    context: Context<ServerEnv>,
    status: 401 | 403,
    code: string,
    message: string,
): Response {
    const requestId = context.get("requestId") || crypto.randomUUID();
    return Response.json({
        error: { code, message, request_id: requestId },
    }, {
        status,
        headers: { [REQUEST_ID]: requestId },
    });
}
