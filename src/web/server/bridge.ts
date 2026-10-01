import type { Context } from "hono";
import type { WebSession } from "./session.ts";
import {
    assertSameOrigin,
    readBoundedBody,
    requestError,
    WebRequestError,
} from "./request.ts";

export type AdminDispatch = (request: Request) => Response | Promise<Response>;

export interface UiBridgeOptions {
    readonly session: WebSession;
    readonly dispatch: AdminDispatch;
    readonly adminAuthToken?: string;
}

const MAX_REQUEST_BYTES = 1_048_576;
// Installation carries up to 2 MiB of package JSON plus the bridge envelope.
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_ENVELOPE_BYTES = MAX_PACKAGE_BYTES + 16_384;
const MAX_RESPONSE_BYTES = 4_194_304;
const ROUTES: Readonly<Record<string, readonly string[]>> = {
    "/api/admin/plugins/chathub/auth": ["POST"],
    "/api/admin/models": ["GET"],
    "/api/admin/status": ["GET"],
    "/api/admin/plugins": ["GET"],
    "/api/admin/plugins/installed": ["GET"],
    "/api/admin/sources": ["GET", "POST", "PATCH", "DELETE"],
    "/api/admin/presets": ["GET"],
    "/api/admin/source-config": ["GET", "PUT"],
    "/api/admin/source-config/validate": ["POST"],
    "/api/admin/preset-preview": ["POST"],
    "/api/admin/preset-apply": ["POST"],
    "/api/admin/plugin-state": ["POST"],
    "/api/admin/plugin-package": ["POST"],
    "/api/admin/plugin": ["DELETE"],
    "/api/admin/source-probe": ["POST"],
    "/api/admin/source-health/reset": ["POST"],
    "/api/admin/source-draft-probe": ["POST"],
    "/api/admin/settings": ["GET", "PUT"],
    "/api/admin/proxies": ["GET", "PUT"],
    "/api/admin/requests": ["GET"],
    "/api/admin/usage": ["GET"],
    "/api/admin/stats": ["GET"],
    "/api/admin/stats/series": ["GET"],
    "/api/admin/stats/trend": ["GET"],
    "/api/admin/stats/models": ["GET"],
    "/api/admin/system-logs": ["GET"],
};

/** A cookie-authenticated adapter for exact host-owned management operations. */
export function createUiBridge(options: UiBridgeOptions) {
    return async (context: Context): Promise<Response> => {
        // The outer HTTP request owns the trace. A nested management dispatch
        // is part of that same operation; envelope and plugin response headers
        // cannot replace the ID already accepted by the host middleware.
        const requestId = context.get("requestId") ||
            context.req.header("x-request-id")?.trim() || crypto.randomUUID();
        try {
            assertSameOrigin(context.req.raw);
            if (!await options.session.authorized(context)) {
                throw new WebRequestError(
                    401,
                    "unauthorized",
                    "请先登录后台。",
                );
            }
            const contentType = context.req.header("content-type")
                ?.split(";")[0]?.trim().toLowerCase();
            if (contentType !== "application/json") {
                throw new WebRequestError(
                    415,
                    "invalid_content_type",
                    "请求必须使用 JSON。",
                );
            }
            const text = await readBoundedBody(
                context.req.raw.body,
                MAX_PACKAGE_ENVELOPE_BYTES,
                context.req.header("content-length"),
            );
            let input: unknown;
            try {
                input = JSON.parse(text);
            } catch {
                throw new WebRequestError(
                    400,
                    "invalid_json",
                    "请求必须是有效的 JSON。",
                );
            }
            if (!isRecord(input)) {
                throw new WebRequestError(
                    400,
                    "invalid_request",
                    "请求必须是 JSON 对象。",
                );
            }
            const { path, method } = input;
            if (
                typeof path !== "string" || typeof method !== "string" ||
                path.length > 2048 || !path.startsWith("/api/admin/") ||
                /[\\#\s]/.test(path) || hasControlCharacter(path)
            ) {
                throw new WebRequestError(
                    400,
                    "invalid_target",
                    "管理请求地址无效。",
                );
            }
            const url = new URL(path, context.req.url);
            const literalPath = path.split("?")[0];
            if (
                url.pathname !== literalPath ||
                !ROUTES[url.pathname]?.includes(method)
            ) {
                throw new WebRequestError(
                    403,
                    "target_not_allowed",
                    "后台不能执行此管理请求。",
                );
            }
            const packageInstall = url.pathname === "/api/admin/plugin-package";
            if (
                !packageInstall &&
                new TextEncoder().encode(text).length > MAX_REQUEST_BYTES
            ) {
                throw new WebRequestError(
                    413,
                    "payload_too_large",
                    "管理请求不能超过 1 MiB。",
                );
            }
            // Surface the resolved target in the access log; the bridge path
            // itself (`POST /admin/ui/request`) says nothing about the op.
            context.set("accessLogTarget", `${method} ${url.pathname}`);
            if (method === "GET" && input.body !== undefined) {
                throw new WebRequestError(
                    400,
                    "invalid_request",
                    "读取请求不能携带请求体。",
                );
            }
            const headers = forwardingHeaders(input.headers);
            headers.set("x-request-id", requestId);
            if (options.adminAuthToken !== undefined) {
                headers.set(
                    "authorization",
                    `Bearer ${options.adminAuthToken.trim()}`,
                );
            }
            let body: string | undefined;
            if (input.body !== undefined) {
                body = JSON.stringify(input.body);
                if (
                    packageInstall &&
                    new TextEncoder().encode(body).length > MAX_PACKAGE_BYTES
                ) {
                    throw new WebRequestError(
                        413,
                        "payload_too_large",
                        "插件包不能超过 2 MiB。",
                    );
                }
                headers.set("content-type", "application/json");
            }
            headers.set("accept", "application/json");
            const response = await options.dispatch(
                new Request(url, {
                    method,
                    headers,
                    body,
                    redirect: "manual",
                    signal: context.req.raw.signal,
                }),
            );
            const outgoing = new Headers({
                "cache-control": "no-store",
                "content-type": "application/json; charset=utf-8",
                "x-content-type-options": "nosniff",
                "x-heimdall-request-id": requestId,
            });
            const etag = response.headers.get("etag");
            if (etag !== null) outgoing.set("etag", etag);
            if (response.status === 204 || response.status === 304) {
                return new Response(null, {
                    status: response.status,
                    headers: outgoing,
                });
            }
            let responseBody = await readBoundedBody(
                response.body,
                MAX_RESPONSE_BYTES,
                response.headers.get("content-length"),
            );
            try {
                const result: unknown = JSON.parse(responseBody);
                if (
                    response.status >= 400 && isRecord(result) &&
                    isRecord(result.error)
                ) {
                    result.error.request_id = requestId;
                    responseBody = JSON.stringify(result);
                }
            } catch {
                throw new WebRequestError(
                    502,
                    "invalid_response",
                    "管理服务返回了无效的 JSON。",
                );
            }
            return new Response(responseBody, {
                status: response.status,
                headers: outgoing,
            });
        } catch (error) {
            return requestError(error, requestId);
        }
    };
}

function forwardingHeaders(input: unknown): Headers {
    const headers = new Headers();
    if (input === undefined) return headers;
    if (!isRecord(input)) {
        throw new WebRequestError(400, "invalid_headers", "管理请求头无效。");
    }
    for (const [key, value] of Object.entries(input)) {
        const name = key.toLowerCase();
        if (name !== "if-match" && name !== "x-request-id") continue;
        if (
            typeof value !== "string" || value.length > 512 ||
            !/^[ -~]*$/.test(value)
        ) {
            throw new WebRequestError(
                400,
                "invalid_headers",
                "管理请求头无效。",
            );
        }
        headers.set(name, value);
    }
    return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code < 32 || code === 127) return true;
    }
    return false;
}
