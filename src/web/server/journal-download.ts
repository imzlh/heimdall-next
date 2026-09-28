import type { Context } from "hono";
import type { UiBridgeOptions } from "./bridge.ts";
import {
    assertSameOrigin,
    readBoundedBody,
    requestError,
    WebRequestError,
} from "./request.ts";

const EXPORT_PATH = "/api/admin/requests/export";
const MAX_ERROR_BYTES = 65_536;

/** A read-only session route that streams the host's complete journal export. */
export function createJournalDownload(options: UiBridgeOptions) {
    return async (context: Context): Promise<Response> => {
        const requestId = context.get("requestId") ||
            context.req.header("x-request-id")?.trim() || crypto.randomUUID();
        try {
            // GET navigation does not normally include Origin. Fetch Metadata
            // and any supplied Origin still have to identify this console.
            assertSameOrigin(context.req.raw);
            const destination = context.req.header("sec-fetch-dest");
            if (
                destination && destination !== "document" &&
                destination !== "empty"
            ) {
                throw new WebRequestError(
                    403,
                    "invalid_destination",
                    "请从后台页面下载日志。",
                );
            }
            if (!await options.session.authorized(context)) {
                throw new WebRequestError(
                    401,
                    "unauthorized",
                    "请先登录后台。",
                );
            }
            if (context.req.method !== "GET") {
                throw new WebRequestError(
                    405,
                    "method_not_allowed",
                    "日志下载只支持读取请求。",
                );
            }
            const params = new URL(context.req.url).searchParams;
            const entries = [...params];
            const id = params.get("id");
            if (
                entries.length !== 1 || entries[0]?.[0] !== "id" ||
                id === null || id.length === 0 || id.length > 200 ||
                id !== id.trim() || /[\\/]/.test(id) ||
                [...id].some((character) => {
                    const code = character.charCodeAt(0);
                    return code < 32 || code === 127;
                })
            ) {
                throw new WebRequestError(
                    400,
                    "invalid_request",
                    "请提供一个有效的请求 ID。",
                );
            }
            // The caller can select a record, never a dispatch target or headers.
            const target = new URL(EXPORT_PATH, context.req.url);
            target.searchParams.set("id", id);
            const headers = new Headers({
                accept: "application/json",
                "x-request-id": requestId,
            });
            if (options.adminAuthToken !== undefined) {
                headers.set(
                    "authorization",
                    `Bearer ${options.adminAuthToken.trim()}`,
                );
            }
            const response = await options.dispatch(
                new Request(target, {
                    method: "GET",
                    headers,
                    redirect: "manual",
                    signal: context.req.raw.signal,
                }),
            );
            if (response.status >= 400) {
                return await exportError(response, requestId);
            }
            if (
                response.status !== 200 || response.body === null ||
                response.headers.get("content-type")?.split(";")[0]
                        ?.trim().toLowerCase() !== "application/json"
            ) {
                await response.body?.cancel();
                throw invalidResponse();
            }
            // Hand the original stream to the response: no JSON parse, body
            // buffer, or general bridge limit. Consumer cancellation reaches
            // the exporter; request aborts also reach its dispatch signal.
            return new Response(response.body, {
                status: 200,
                headers: {
                    ...downloadHeaders(requestId),
                    "content-disposition":
                        'attachment; filename="heimdall-request.json"',
                },
            });
        } catch (error) {
            const response = requestError(error, requestId);
            for (
                const [name, value] of Object.entries(
                    downloadHeaders(requestId),
                )
            ) {
                response.headers.set(name, value);
            }
            if (response.status === 405) response.headers.set("allow", "GET");
            return response;
        }
    };
}

async function exportError(
    response: Response,
    requestId: string,
): Promise<Response> {
    try {
        const text = await readBoundedBody(
            response.body,
            MAX_ERROR_BYTES,
            response.headers.get("content-length"),
        );
        const result: unknown = JSON.parse(text);
        if (
            result === null || typeof result !== "object" ||
            !("error" in result) || result.error === null ||
            typeof result.error !== "object" ||
            !("code" in result.error) ||
            typeof result.error.code !== "string" ||
            !("message" in result.error) ||
            typeof result.error.message !== "string"
        ) throw invalidResponse();
        return Response.json({
            error: {
                code: result.error.code,
                message: result.error.message,
                request_id: requestId,
            },
        }, {
            status: response.status,
            headers: downloadHeaders(requestId),
        });
    } catch {
        // Even an invalid Content-Length or malformed UTF-8 must not leave
        // an upstream error body open after the bounded read fails.
        await response.body?.cancel().catch(() => {});
        throw invalidResponse();
    }
}

function invalidResponse(): WebRequestError {
    return new WebRequestError(
        502,
        "invalid_response",
        "管理服务未返回有效的日志导出。",
    );
}

function downloadHeaders(requestId: string): Record<string, string> {
    return {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        "x-heimdall-request-id": requestId,
    };
}
