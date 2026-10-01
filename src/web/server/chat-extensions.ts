import type { Context } from "hono";
import {
    buildChatExtensions,
    type ChatExtensions,
    projectChatTools,
} from "@heimdall/admin-contracts/chat-ui.ts";
import type { ChatToolInfo } from "@heimdall/admin-contracts/chat.ts";
import type { UiContribution, UiPolicy } from "@heimdall/admin-contracts/ui.ts";
import type { AdminDispatch } from "./bridge.ts";
import type { WebSession } from "./session.ts";
import {
    assertSameOrigin,
    readBoundedBody,
    requestError,
    WebRequestError,
} from "./request.ts";

export function createChatExtensionLoader(options: {
    readonly dispatch: AdminDispatch;
    readonly adminAuthToken?: string;
    readonly policy?: UiPolicy;
    readonly contributions: () => Promise<readonly UiContribution[]>;
}) {
    async function tools(): Promise<readonly ChatToolInfo[]> {
        const headers = new Headers({ accept: "application/json" });
        if (options.adminAuthToken) {
            headers.set(
                "authorization",
                `Bearer ${options.adminAuthToken.trim()}`,
            );
        }
        const response = await options.dispatch(
            new Request("http://localhost/admin/plugins", {
                headers,
                redirect: "manual",
            }),
        );
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error("Plugin catalog unavailable");
        }
        const value = JSON.parse(
            await readBoundedBody(
                response.body,
                1_048_576,
                response.headers.get("content-length"),
            ),
        );
        return projectChatTools(value?.data ?? value?.plugins);
    }
    return async (
        initialTools?: readonly ChatToolInfo[],
    ): Promise<ChatExtensions> => {
        const [declarations, currentTools] = await Promise.all([
            options.contributions(),
            initialTools ?? tools(),
        ]);
        return buildChatExtensions(declarations, currentTools, options.policy);
    };
}

export function createChatExtensionsRoute(
    session: WebSession,
    load: () => Promise<ChatExtensions>,
) {
    return async (context: Context): Promise<Response> => {
        try {
            assertSameOrigin(context.req.raw);
            if (!await session.authorized(context)) {
                throw new WebRequestError(
                    401,
                    "unauthorized",
                    "请先登录后台。",
                );
            }
            return Response.json(await load(), {
                headers: {
                    "cache-control": "no-store",
                    "x-content-type-options": "nosniff",
                },
            });
        } catch (error) {
            return requestError(error);
        }
    };
}
