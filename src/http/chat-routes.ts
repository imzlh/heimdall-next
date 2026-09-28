import { Hono } from "hono";
import type { Context } from "hono";
import { upgradeWebSocket } from "hono/deno";
import type { RequestContext } from "@heimdall/contracts";
import type { ChatAttachment } from "@heimdall/storage";
import type { ServerApp, ServerEnv } from "./app.ts";
import { chatSocketProtocol } from "./chat-auth.ts";
import { createChatAssetRoutes } from "./chat-asset-routes.ts";
import { ChatRouteError } from "../chat/errors.ts";
import { presentConversation } from "../chat/branches.ts";
import {
    type ChatRunCommand,
    type ChatServiceOptions,
    executeCommand,
    presentMessages,
    requireConversation,
    withChatConversation,
} from "../chat/service.ts";

export type ChatRouteOptions = ChatServiceOptions;
const REQUEST_ID = "x-heimdall-request-id";
const TEXT_LIMIT = 100_000;
const SYSTEM_PROMPT_LIMIT = 8_000;

/**
 * Single-tenant chat API. HTTP stores a full turn. `/regenerate` creates a sibling
 * reply and keeps the complete original branch. The WebSocket at `/socket`
 * streams deltas and accepts `stop` and `regenerate`. Registered tools execute
 * through the capability boundary; other calls return to the client. Image attachments
 * are stored with the user message and sent to the kernel as image parts.
 */
export function createChatRoutes(options: ChatRouteOptions): ServerApp {
    const now = options.now ?? (() => new Date());
    const app = new Hono<ServerEnv>();
    if (options.assets) {
        app.route("/", createChatAssetRoutes(options.assets, options.store));
    }

    app.post("/conversations", (context) => {
        const requestId = currentRequestId(context);
        const record = options.store.createConversation(
            "新对话",
            now().toISOString(),
        );
        return json(requestId, { conversation: record }, 201);
    });

    app.get("/conversations", (context) => {
        const requestId = currentRequestId(context);
        return json(requestId, {
            conversations: options.store.listConversations(),
        });
    });

    app.get("/conversation", async (context) => {
        const requestId = currentRequestId(context);
        const id = requiredQuery(context, "id");
        const conversation = options.store.getConversation(id);
        if (conversation === null) {
            return errorResponse(
                requestId,
                404,
                "not_found",
                `conversation not found: ${id}`,
            );
        }
        return json(requestId, {
            conversation: presentConversation(options.store, id),
            messages: await presentMessages(
                options,
                options.store.listMessages(id),
            ),
        });
    });

    app.patch("/conversation", async (context) => {
        const requestId = currentRequestId(context);
        const id = requiredQuery(context, "id");
        const body = await readJsonBody(context);
        const hasTitle = body.title !== undefined;
        const hasSystemPrompt = body.systemPrompt !== undefined;
        const hasEffort = body.reasoningEffort !== undefined;
        const hasDisabledTools = body.disabledTools !== undefined;
        if (!hasTitle && !hasSystemPrompt && !hasEffort && !hasDisabledTools) {
            throw new ChatRouteError(
                400,
                "invalid_request",
                "nothing to update",
            );
        }
        let title: string | undefined;
        if (hasTitle) {
            title = requiredString(body.title, "title");
            if (title.length > 120) {
                throw new ChatRouteError(
                    400,
                    "invalid_request",
                    "title must be at most 120 characters",
                );
            }
        }
        let systemPrompt: string | undefined;
        if (hasSystemPrompt) {
            if (typeof body.systemPrompt !== "string") {
                throw new ChatRouteError(
                    400,
                    "invalid_request",
                    "systemPrompt must be a string",
                );
            }
            systemPrompt = body.systemPrompt;
            if (systemPrompt.length > SYSTEM_PROMPT_LIMIT) {
                throw new ChatRouteError(
                    413,
                    "payload_too_large",
                    `systemPrompt must be at most ${SYSTEM_PROMPT_LIMIT} characters`,
                );
            }
        }
        let reasoningEffort: string | undefined;
        if (hasEffort) {
            if (body.reasoningEffort === null) reasoningEffort = "";
            else if (
                body.reasoningEffort === "low" ||
                body.reasoningEffort === "medium" ||
                body.reasoningEffort === "high"
            ) reasoningEffort = body.reasoningEffort;
            else {
                throw new ChatRouteError(
                    400,
                    "invalid_request",
                    "reasoningEffort must be low, medium, high or null",
                );
            }
        }
        let disabledTools: readonly string[] | undefined;
        if (hasDisabledTools) {
            if (
                !Array.isArray(body.disabledTools) ||
                body.disabledTools.length > 32 ||
                !body.disabledTools.every((item) =>
                    typeof item === "string" && item.length > 0 &&
                    item.length <= 128
                )
            ) {
                throw new ChatRouteError(
                    400,
                    "invalid_request",
                    "disabledTools must be an array of at most 32 plugin ids",
                );
            }
            disabledTools = [...new Set(body.disabledTools)];
        }
        return await withChatConversation(options.store, id, () => {
            const conversation = options.store.getConversation(id);
            if (conversation === null) {
                return errorResponse(
                    requestId,
                    404,
                    "not_found",
                    `conversation not found: ${id}`,
                );
            }
            const updatedAt = now().toISOString();
            options.store.updateConversation(id, {
                updatedAt,
                ...(title === undefined ? {} : { title }),
                ...(systemPrompt === undefined ? {} : { systemPrompt }),
                ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
                ...(disabledTools === undefined ? {} : { disabledTools }),
            });
            return json(requestId, {
                conversation: presentConversation(options.store, id),
            });
        });
    });

    app.delete("/conversation", async (context) => {
        const requestId = currentRequestId(context);
        const id = requiredQuery(context, "id");
        return await withChatConversation(options.store, id, () => {
            if (options.store.getConversation(id) === null) {
                return errorResponse(
                    requestId,
                    404,
                    "not_found",
                    `conversation not found: ${id}`,
                );
            }
            const assetIds = options.store.assetIdsForConversation(id);
            options.store.deleteConversation(id);
            options.assets?.reclaim(assetIds, options.store);
            return json(requestId, { deleted: true, id });
        });
    });

    app.delete("/message", async (context) => {
        const requestId = currentRequestId(context);
        const conversationId = requiredQuery(context, "conversationId");
        const id = requiredQuery(context, "id");
        return await withChatConversation(options.store, conversationId, () => {
            if (options.store.getConversation(conversationId) === null) {
                return errorResponse(
                    requestId,
                    404,
                    "not_found",
                    `conversation not found: ${conversationId}`,
                );
            }
            const messages = options.store.listMessages(conversationId);
            const index = messages.findIndex((message) => message.id === id);
            if (index === -1) {
                return errorResponse(
                    requestId,
                    404,
                    "not_found",
                    `message not found: ${id}`,
                );
            }
            // One Q&A turn: the user message plus every reply/tool message
            // after it. Deleting either side removes the whole turn.
            let start = index;
            if (messages[index]?.role !== "user") {
                while (start > 0 && messages[start]?.role !== "user") start--;
            }
            let end = start + 1;
            while (
                end < messages.length && messages[end]?.role !== "user"
            ) end++;
            const ids = messages.slice(start, end).map((message) => message.id);
            const assetIds = options.store.assetIdsForMessages(ids);
            options.store.deleteMessages(ids, now().toISOString());
            options.assets?.reclaim(assetIds, options.store);
            return json(requestId, { deleted: true, ids });
        });
    });

    const generate = async (
        context: Context<ServerEnv>,
        type: ChatRunCommand["type"],
    ) => {
        const requestId = currentRequestId(context);
        const body = await readJsonBody(context);
        const command = readCommand({ ...body, type });
        const outcome = await executeCommand(
            options,
            command,
            chatRequestContext(
                context.req.raw,
                command,
                requestId,
                context.req.raw.signal,
                "http",
            ),
        );
        return json(requestId, {
            conversation: presentConversation(
                options.store,
                command.conversationId,
            ),
            messages: await presentMessages(options, outcome.messages),
            toolCalls: outcome.toolCalls,
        });
    };
    app.post("/message", (context) => generate(context, "send"));
    app.post("/regenerate", (context) => generate(context, "regenerate"));
    app.post("/continue", (context) => generate(context, "continue"));
    app.patch("/message", (context) => generate(context, "edit"));

    app.post("/branch", async (context) => {
        const requestId = currentRequestId(context);
        const body = await readJsonBody(context);
        const id = requiredString(body.conversationId, "conversationId");
        const messageId = requiredString(body.messageId, "messageId");
        return await withChatConversation(options.store, id, async () => {
            requireConversation(options.store, id);
            options.store.selectBranch(id, messageId, now().toISOString());
            return json(requestId, {
                conversation: presentConversation(options.store, id),
                messages: await presentMessages(
                    options,
                    options.store.listMessages(id),
                ),
            });
        });
    });

    app.post("/fork", async (context) => {
        const requestId = currentRequestId(context);
        const body = await readJsonBody(context);
        const id = requiredString(body.conversationId, "conversationId");
        const messageId = requiredString(body.messageId, "messageId");
        const title = body.title === undefined
            ? undefined
            : requiredString(body.title, "title");
        if (title && title.length > 120) {
            throw new ChatRouteError(
                400,
                "invalid_request",
                "title must be at most 120 characters",
            );
        }
        return await withChatConversation(options.store, id, async () => {
            const conversation = options.store.forkConversation(
                id,
                messageId,
                now().toISOString(),
                title,
            );
            return json(requestId, {
                conversation: presentConversation(
                    options.store,
                    conversation.id,
                ),
                messages: await presentMessages(
                    options,
                    options.store.listMessages(conversation.id),
                ),
            }, 201);
        });
    });

    app.get(
        "/socket",
        (context, next) =>
            upgradeWebSocket(() => {
                // Deno closes the native request on upgrade, including its
                // lazy headers. Keep the real handshake data readable for all
                // later commands; each command supplies its own abort signal.
                const request = new Request(context.req.raw.url, {
                    method: context.req.raw.method,
                    headers: new Headers(context.req.raw.headers),
                });
                let active: AbortController | undefined;
                let busy = false;
                let closed = false;
                return {
                    onMessage(event, socket) {
                        const send = (payload: unknown): void => {
                            if (closed || socket.readyState !== 1) return;
                            try {
                                socket.send(socketJson(payload));
                            } catch {
                                closed = true;
                                active?.abort();
                            }
                        };
                        const parsed = parseSocketEvent(event.data);
                        if (parsed === undefined) {
                            send({
                                type: "error",
                                message: "invalid json",
                            });
                            return;
                        }
                        if (parsed.type === "stop") {
                            active?.abort();
                            return;
                        }
                        if (
                            parsed.type !== "send" &&
                            parsed.type !== "regenerate" &&
                            parsed.type !== "continue" &&
                            parsed.type !== "edit"
                        ) {
                            send({
                                type: "error",
                                message: "unsupported event",
                            });
                            return;
                        }
                        if (busy) {
                            send({
                                type: "error",
                                code: "run_in_progress",
                                status: 409,
                                message: "a run is already active",
                            });
                            return;
                        }
                        busy = true;
                        const controller = new AbortController();
                        active = controller;
                        const run = executeCommand(
                            options,
                            parsed,
                            chatRequestContext(
                                request,
                                parsed,
                                crypto.randomUUID(),
                                controller.signal,
                                "websocket",
                            ),
                            send,
                        );
                        void run.catch((error) => {
                            send(socketError(error));
                        }).finally(() => {
                            busy = false;
                            if (active === controller) active = undefined;
                        });
                    },
                    onClose() {
                        closed = true;
                        active?.abort();
                    },
                    onError() {
                        closed = true;
                        active?.abort();
                    },
                };
            }, { protocol: chatSocketProtocol(context.req.raw) })(
                context,
                next,
            ),
    );

    return app;
}

/** Each socket command has its own lifecycle; the handshake remains its origin. */
function chatRequestContext(
    request: Request,
    command: ChatRunCommand,
    requestId: string,
    signal: AbortSignal,
    transport: "http" | "websocket",
): RequestContext {
    return {
        requestId,
        request,
        signal,
        route: {
            method: request.method,
            path: new URL(request.url).pathname,
            operation: "generation.create",
        },
        metadata: {
            transport,
            conversationId: command.conversationId,
            command: command.type,
        },
    };
}

function readCommand(record: Record<string, unknown>): ChatRunCommand {
    const type = record.type;
    if (
        type !== "send" && type !== "regenerate" && type !== "continue" &&
        type !== "edit"
    ) {
        throw new ChatRouteError(400, "invalid_request", "unsupported event");
    }
    const conversationId = requiredString(
        record.conversationId,
        "conversationId",
    );
    const model = type === "edit" && record.model === undefined
        ? undefined
        : requiredString(record.model, "model");
    const messageId = type === "edit" || record.messageId !== undefined
        ? requiredString(record.messageId, "messageId")
        : undefined;
    const text = type === "send" || type === "edit"
        ? requiredString(record.text, "text")
        : undefined;
    if (text && text.length > TEXT_LIMIT) {
        throw new ChatRouteError(
            413,
            "payload_too_large",
            "message is too large",
        );
    }
    return {
        type,
        conversationId,
        model,
        messageId,
        text,
        ...(type === "send"
            ? { attachments: readAttachments(record.attachments) }
            : {}),
    };
}

function parseSocketEvent(
    data: unknown,
): ChatRunCommand | { type: "stop" } | { type: "ignored" } | undefined {
    try {
        const parsed: unknown = JSON.parse(
            typeof data === "string" ? data : "",
        );
        if (
            parsed === null || typeof parsed !== "object" ||
            Array.isArray(parsed)
        ) return undefined;
        const record = parsed as Record<string, unknown>;
        if (record.type === "stop") return { type: "stop" };
        if (
            record.type !== "send" && record.type !== "regenerate" &&
            record.type !== "continue" && record.type !== "edit"
        ) return { type: "ignored" };
        return readCommand(record);
    } catch {
        return undefined;
    }
}

function socketJson(payload: unknown): string {
    return JSON.stringify(payload);
}

function socketError(error: unknown): {
    type: "error";
    message: string;
    code?: string;
    status?: number;
} {
    const detail = typeof error === "object" && error !== null
        ? error as { code?: unknown; status?: unknown }
        : undefined;
    return {
        type: "error",
        message: error instanceof Error ? error.message : "chat failed",
        ...(typeof detail?.code === "string" ? { code: detail.code } : {}),
        ...(typeof detail?.status === "number"
            ? { status: detail.status }
            : {}),
    };
}

function readAttachments(value: unknown): ChatAttachment[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 4) {
        throw new ChatRouteError(
            400,
            "invalid_request",
            "attachments must be an array of at most 4 images",
        );
    }
    return value.map((item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
            throw new ChatRouteError(
                400,
                "invalid_request",
                "attachment must be an object",
            );
        }
        const record = item as Record<string, unknown>;
        const mediaType = requiredString(record.mediaType, "mediaType");
        if (record.assetId !== undefined) {
            return {
                mediaType,
                assetId: requiredString(record.assetId, "assetId"),
                ...(record.leaseId === undefined
                    ? {}
                    : { leaseId: requiredString(record.leaseId, "leaseId") }),
            };
        }
        const dataBase64 = requiredString(record.dataBase64, "dataBase64");
        if (!/^image\/[a-z0-9.+-]+$/.test(mediaType)) {
            throw new ChatRouteError(
                400,
                "invalid_request",
                "attachment mediaType must be an image",
            );
        }
        if (
            dataBase64.length > 1_400_000 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)
        ) {
            throw new ChatRouteError(
                400,
                "invalid_request",
                "attachment dataBase64 is invalid",
            );
        }
        return { mediaType, dataBase64 };
    });
}

function currentRequestId(context: Context<ServerEnv>): string {
    return context.get("requestId") ||
        context.req.header("x-request-id")?.trim() || crypto.randomUUID();
}

function requiredQuery(context: Context<ServerEnv>, name: string): string {
    return requiredString(context.req.query(name), name);
}

function requiredString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new ChatRouteError(400, "invalid_request", `${name} is required`);
    }
    return value.trim();
}

async function readJsonBody(
    context: Context<ServerEnv>,
): Promise<Record<string, unknown>> {
    const bytes = new Uint8Array(await context.req.raw.arrayBuffer());
    if (bytes.byteLength > 1_048_576) {
        throw new ChatRouteError(
            413,
            "payload_too_large",
            "request body is too large",
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new ChatRouteError(
            400,
            "invalid_json",
            "request body must be JSON",
        );
    }
    if (
        parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    ) {
        throw new ChatRouteError(
            400,
            "invalid_request",
            "request body must be an object",
        );
    }
    return parsed as Record<string, unknown>;
}

function json(requestId: string, payload: unknown, status = 200): Response {
    return Response.json(payload, {
        status,
        headers: { [REQUEST_ID]: requestId },
    });
}

function errorResponse(
    requestId: string,
    status: number,
    code: string,
    message: string,
): Response {
    return json(requestId, {
        error: { code, message, request_id: requestId },
    }, status);
}
