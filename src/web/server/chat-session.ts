import type { Handler } from "hono";
import type { ServerEnv } from "../../http/app.ts";
import type { WebSession } from "./session.ts";
import { assertSameOrigin, requestError, WebRequestError } from "./request.ts";

/** Authorize the original HTTP/upgrade request without copying its native handle. */
export function createChatWebSession(
    session: WebSession,
    handler: Handler<ServerEnv>,
): Handler<ServerEnv> {
    return async (context, next) => {
        const request = context.req.raw;
        const websocket =
            request.headers.get("upgrade")?.toLowerCase() === "websocket";
        try {
            assertSameOrigin(request);
            if (
                (websocket || !["GET", "HEAD"].includes(request.method)) &&
                request.headers.get("origin") !== new URL(request.url).origin
            ) {
                throw new WebRequestError(
                    403,
                    "cross_origin",
                    "请从当前聊天页面提交操作。",
                );
            }
            if (!await session.authorized(context)) {
                throw new WebRequestError(
                    401,
                    "unauthorized",
                    "请先登录后台。",
                );
            }
        } catch (error) {
            return requestError(error);
        }
        const response = await handler(context, next);
        if (!websocket) {
            if (response instanceof Response) context.res = response;
            context.header("cache-control", "no-store");
            return response instanceof Response ? context.res : response;
        }
        return response;
    };
}
