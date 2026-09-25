import type { Context } from "hono";
import {
    isUiJsonObject,
    uiActionAllowed,
    uiContributionKey,
} from "@heimdall/admin-contracts/ui.ts";
import type {
    UiAction,
    UiContext,
    UiContribution,
    UiJsonObject,
    UiPolicy,
} from "@heimdall/admin-contracts/ui.ts";
import type { WebSession } from "./session.ts";
import {
    assertSameOrigin,
    readBoundedBody,
    requestError,
    WebRequestError,
} from "./request.ts";

export interface UiActionInput {
    readonly contribution: UiContribution;
    readonly action: UiAction;
    readonly context: UiContext;
    readonly requestId: string;
}

/** Registered by the host. Handlers validate their own operation-specific payload. */
export type UiActionRegistry = Readonly<
    Record<
        string,
        (input: UiActionInput) => UiJsonObject | Promise<UiJsonObject>
    >
>;

export interface UiActionsOptions {
    readonly session: WebSession;
    readonly policy?: UiPolicy;
    readonly actions?: UiActionRegistry;
    readonly contributions: () => Promise<readonly UiContribution[]>;
    readonly sourcePlugins: () => Promise<Readonly<Record<string, string>>>;
}

/** Narrow web action port. Plugin JSON cannot select a URL or runtime function. */
export function createUiActions(options: UiActionsOptions) {
    return async (context: Context): Promise<Response> => {
        try {
            assertSameOrigin(context.req.raw);
            if (!await options.session.authorized(context)) {
                throw new WebRequestError(
                    401,
                    "unauthorized",
                    "请先登录后台。",
                );
            }
            if (
                context.req.header("content-type")?.split(";")[0]?.trim() !==
                    "application/json"
            ) {
                throw new WebRequestError(
                    415,
                    "invalid_content_type",
                    "请求必须使用 JSON。",
                );
            }
            const text = await readBoundedBody(
                context.req.raw.body,
                32_768,
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
            if (
                !isUiJsonObject(input) ||
                typeof input.contributionId !== "string" ||
                Object.keys(input).some((key) =>
                    !["contributionId", "action", "sourceId", "theme"].includes(
                        key,
                    )
                )
            ) {
                throw new WebRequestError(
                    400,
                    "invalid_action",
                    "插件动作无效。",
                );
            }
            const contribution = (await options.contributions()).find((item) =>
                uiContributionKey(item) === input.contributionId
            );
            if (
                !contribution ||
                !uiActionAllowed(
                    contribution,
                    input.action,
                    options.policy ?? {},
                )
            ) {
                throw new WebRequestError(
                    403,
                    "action_not_allowed",
                    "宿主未允许此插件动作。",
                );
            }
            const action = input.action as unknown as UiAction;
            const handler = Object.hasOwn(options.actions ?? {}, action.id)
                ? options.actions?.[action.id]
                : undefined;
            if (!handler) {
                throw new WebRequestError(
                    503,
                    "action_unavailable",
                    "当前实例未安装此动作处理器。",
                );
            }
            if (
                input.theme !== undefined &&
                (typeof input.theme !== "string" ||
                    !["light", "dark", "system"].includes(input.theme))
            ) {
                throw new WebRequestError(400, "invalid_context", "主题无效。");
            }
            const hostContext: UiContext = {
                locale: "zh",
                theme: (input.theme ?? "system") as UiContext["theme"],
                data: {},
            };
            let sourceId: string | undefined;
            let sourcePluginId: string | undefined;
            if (contribution.slot === "source.status") {
                if (typeof input.sourceId !== "string") {
                    throw new WebRequestError(
                        400,
                        "invalid_source",
                        "缺少渠道标识。",
                    );
                }
                sourceId = input.sourceId;
                const sources = await options.sourcePlugins();
                sourcePluginId = Object.hasOwn(sources, sourceId)
                    ? sources[sourceId]
                    : undefined;
                if (
                    !sourcePluginId ||
                    sourcePluginId !== contribution.sourcePluginId
                ) {
                    throw new WebRequestError(
                        403,
                        "source_not_allowed",
                        "该插件动作不属于此渠道。",
                    );
                }
            } else if (input.sourceId !== undefined) {
                throw new WebRequestError(
                    400,
                    "invalid_source",
                    "此动作不接受渠道标识。",
                );
            }
            const result = await handler({
                contribution,
                action,
                context: {
                    ...hostContext,
                    ...(sourceId ? { sourceId, sourcePluginId } : {}),
                },
                requestId: context.get("requestId") ?? crypto.randomUUID(),
            });
            if (!isUiJsonObject(result)) {
                throw new WebRequestError(
                    502,
                    "invalid_result",
                    "插件动作未返回有效 JSON。",
                );
            }
            return Response.json({ data: result }, {
                headers: { "cache-control": "no-store" },
            });
        } catch (error) {
            return requestError(error);
        }
    };
}
