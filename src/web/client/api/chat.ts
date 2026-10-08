import type {
    ChatAttachment,
    ChatCommand,
    ChatConversation,
    ChatEvent,
    ChatMessage,
} from "@heimdall/admin-contracts/chat.ts";
import { parseChatDisabledTools } from "@heimdall/admin-contracts/chat.ts";
import { AdminApiError, getAdminToken, request } from "./admin.ts";
import { payloadRecord } from "./transport.ts";
import { readChatBranches } from "../../shared/chat-branches.ts";

export type {
    ChatActivity,
    ChatAttachment,
    ChatCitation,
    ChatCommand,
    ChatConversation,
    ChatEvent,
    ChatInitial,
    ChatMessage,
    ChatToolCall,
} from "@heimdall/admin-contracts/chat.ts";

export interface ChatStream {
    finished: Promise<"done" | "stopped">;
    stop(): void;
    close(): void;
}

export interface ChatStreamOptions {
    endpoint?: string;
    session?: boolean;
}

export interface ChatRequestOptions extends ChatStreamOptions {
    signal?: AbortSignal;
}

function invalidResponse(): never {
    throw new AdminApiError("聊天服务返回了无法识别的数据，请刷新重试", {
        code: "invalid_response",
    });
}

function record(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return invalidResponse();
    }
    return value as Record<string, unknown>;
}

function text(value: unknown): string {
    return typeof value === "string" ? value : invalidResponse();
}

function readConversation(value: unknown): ChatConversation {
    const body = record(value);
    const conversation: ChatConversation = {
        id: text(body.id),
        title: text(body.title),
        createdAt: text(body.createdAt),
        updatedAt: text(body.updatedAt),
    };
    if (typeof body.systemPrompt === "string" && body.systemPrompt.length > 0) {
        conversation.systemPrompt = body.systemPrompt;
    }
    if (
        body.reasoningEffort === "low" || body.reasoningEffort === "medium" ||
        body.reasoningEffort === "high"
    ) conversation.reasoningEffort = body.reasoningEffort;
    if (body.disabledTools !== undefined) {
        try {
            conversation.disabledTools = parseChatDisabledTools(
                body.disabledTools,
            );
        } catch {
            return invalidResponse();
        }
    }
    if (body.activeMessageId !== undefined) {
        conversation.activeMessageId = text(body.activeMessageId);
    }
    if (body.branches !== undefined) {
        const branches = readChatBranches(body.branches);
        if (!branches) return invalidResponse();
        conversation.branches = branches;
    }
    return conversation;
}

function readAttachment(value: unknown, draft = false): ChatAttachment {
    const body = record(value);
    const mediaType = text(body.mediaType);
    if (body.assetId !== undefined) {
        const assetId = text(body.assetId);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(assetId)) return invalidResponse();
        if (
            body.size !== undefined &&
            (typeof body.size !== "number" ||
                !Number.isSafeInteger(body.size) || body.size < 1)
        ) return invalidResponse();
        return {
            assetId,
            mediaType,
            ...(typeof body.size === "number" ? { size: body.size } : {}),
            ...(typeof body.name === "string" ? { name: body.name } : {}),
            ...(draft && typeof body.leaseId === "string" &&
                    /^[A-Za-z0-9_-]{1,128}$/.test(body.leaseId)
                ? { leaseId: body.leaseId }
                : {}),
            url: `/admin/chat/api/assets/${encodeURIComponent(assetId)}`,
        };
    }
    return { mediaType, dataBase64: text(body.dataBase64) };
}

function readMessage(value: unknown): ChatMessage {
    const body = record(value);
    const role = body.role;
    if (
        role !== "user" && role !== "assistant" && role !== "tool" &&
        role !== "system"
    ) return invalidResponse();
    const message: ChatMessage = {
        id: text(body.id),
        conversationId: text(body.conversationId),
        role,
        text: text(body.text),
        createdAt: text(body.createdAt),
    };
    if (body.callId !== undefined) message.callId = text(body.callId);
    if (body.name !== undefined) message.name = text(body.name);
    if (body.parentId !== undefined) {
        message.parentId = body.parentId === null ? null : text(body.parentId);
    }
    if (body.branch !== undefined) {
        const branch = record(body.branch);
        if (
            !Array.isArray(branch.messageIds) ||
            !Number.isSafeInteger(branch.index) ||
            !Number.isSafeInteger(branch.count)
        ) return invalidResponse();
        const messageIds = branch.messageIds.map(text);
        const index = branch.index as number;
        const count = branch.count as number;
        if (
            count !== messageIds.length || index < 0 || index >= count ||
            messageIds[index] !== message.id ||
            new Set(messageIds).size !== count
        ) return invalidResponse();
        message.branch = { index, count, messageIds };
    }
    if (body.status !== undefined) {
        if (
            body.status !== "completed" && body.status !== "failed" &&
            body.status !== "stopped"
        ) return invalidResponse();
        message.status = body.status;
    }
    if (body.error !== undefined) {
        const error = record(body.error);
        message.error = {
            code: text(error.code),
            message: text(error.message),
        };
    }
    if (body.attachments !== undefined) {
        if (!Array.isArray(body.attachments)) return invalidResponse();
        message.attachments = body.attachments.map((item) =>
            readAttachment(item)
        );
    }
    if (typeof body.reasoning === "string") message.reasoning = body.reasoning;
    if (Array.isArray(body.activity)) {
        message.activity = readActivity(body.activity);
    }
    if (Array.isArray(body.citations)) {
        message.citations = readCitations(body.citations);
    }
    return message;
}

/** Cloud-activity status lines attached to a stored assistant message. */
function readActivity(value: readonly unknown[]): { summary: string }[] {
    return value
        .map((item) => record(item))
        .filter((item) => typeof item.summary === "string")
        .map((item) => ({ summary: item.summary as string }));
}

/** Citations attached to a stored assistant message. */
function readCitations(
    value: readonly unknown[],
): { label?: string; url?: string; ref?: string }[] {
    return value
        .map((item) => record(item))
        .map((item) => ({
            ...(typeof item.label === "string" ? { label: item.label } : {}),
            ...(typeof item.url === "string" ? { url: item.url } : {}),
            ...(typeof item.ref === "string" ? { ref: item.ref } : {}),
        }))
        .filter((item) => item.label !== undefined || item.url !== undefined);
}

/** Session chat uses its own route, independent of the management API bridge. */
async function chatRequest(
    path: string,
    options: ChatRequestOptions,
    method = "GET",
    body?: unknown,
): Promise<unknown> {
    const endpoint = (options.endpoint ?? "/api/chat").replace(/\/+$/, "");
    const url = `${endpoint}/${path}`;
    const upload = body instanceof File;
    const init = {
        method,
        signal: options.signal,
        ...(body === undefined
            ? {}
            : { body: upload ? body : JSON.stringify(body) }),
        headers: {
            Accept: "application/json",
            ...(body === undefined ? {} : upload
                ? {
                    "Content-Type": body.type,
                    "x-file-name": encodeURIComponent(body.name),
                }
                : { "Content-Type": "application/json" }),
        },
    };
    if (!options.session) return await request(url, init);

    let response: Response;
    try {
        response = await globalThis.fetch(url, {
            ...init,
            credentials: "same-origin",
        });
    } catch (error) {
        if (options.signal?.aborted) throw error;
        throw new AdminApiError(
            error instanceof Error ? error.message : "无法连接到聊天服务",
            { code: "network_error" },
        );
    }

    let payload: unknown = null;
    try {
        payload = await response.json();
    } catch {
        if (options.signal?.aborted) options.signal.throwIfAborted();
    }
    if (!response.ok) {
        const apiError = payloadRecord(payloadRecord(payload)?.error);
        throw new AdminApiError(
            typeof apiError?.message === "string"
                ? apiError.message
                : `${response.status} ${response.statusText}`.trim(),
            {
                status: response.status,
                code: typeof apiError?.code === "string"
                    ? apiError.code
                    : "request_failed",
                requestId: response.headers.get("x-heimdall-request-id") || "",
                details: payload,
            },
        );
    }
    return payload;
}

export async function listChatConversations(
    options: ChatRequestOptions = {},
): Promise<ChatConversation[]> {
    const body = record(await chatRequest("conversations", options));
    if (!Array.isArray(body.conversations)) return invalidResponse();
    return body.conversations.map(readConversation);
}

export async function createConversation(
    options: ChatRequestOptions = {},
): Promise<ChatConversation> {
    const body = record(
        await chatRequest("conversations", options, "POST"),
    );
    return readConversation(body.conversation);
}

export async function loadChatConversation(
    id: string,
    options: ChatRequestOptions = {},
): Promise<{
    conversation: ChatConversation;
    messages: ChatMessage[];
}> {
    const body = record(
        await chatRequest(
            `conversation?id=${encodeURIComponent(id)}`,
            options,
        ),
    );
    if (!Array.isArray(body.messages)) return invalidResponse();
    const conversation = readConversation(body.conversation);
    const messages = body.messages.map(readMessage);
    if (
        conversation.id !== id ||
        messages.some((message) => message.conversationId !== id)
    ) return invalidResponse();
    return { conversation, messages };
}

async function changeChatBranch(
    action: "branch" | "fork",
    conversationId: string,
    messageId: string,
    options: ChatRequestOptions,
): Promise<{ conversation: ChatConversation; messages: ChatMessage[] }> {
    const body = record(
        await chatRequest(action, options, "POST", {
            conversationId,
            messageId,
        }),
    );
    if (!Array.isArray(body.messages)) return invalidResponse();
    const conversation = readConversation(body.conversation);
    if (action === "branch" && conversation.id !== conversationId) {
        return invalidResponse();
    }
    const messages = body.messages.map(readMessage);
    if (
        messages.some((message) => message.conversationId !== conversation.id)
    ) return invalidResponse();
    return { conversation, messages };
}

export function switchChatBranch(
    conversationId: string,
    messageId: string,
    options: ChatRequestOptions = {},
) {
    return changeChatBranch("branch", conversationId, messageId, options);
}

export function forkChatConversation(
    conversationId: string,
    messageId: string,
    options: ChatRequestOptions = {},
) {
    return changeChatBranch("fork", conversationId, messageId, options);
}

export async function uploadChatAttachment(
    file: File,
    options: ChatRequestOptions = {},
): Promise<ChatAttachment> {
    const body = record(await chatRequest("assets", options, "POST", file));
    const attachment = readAttachment(body.attachment, true);
    if (!attachment.assetId) return invalidResponse();
    return attachment;
}

export async function acquireChatAttachment(
    assetId: string,
    options: ChatRequestOptions = {},
): Promise<ChatAttachment> {
    const body = record(
        await chatRequest(
            `assets/${encodeURIComponent(assetId)}/lease`,
            options,
            "POST",
        ),
    );
    const attachment = readAttachment(body.attachment, true);
    if (attachment.assetId !== assetId || !attachment.leaseId) {
        return invalidResponse();
    }
    return attachment;
}

export async function releaseChatAttachment(
    assetId: string,
    leaseId: string,
    options: ChatRequestOptions = {},
): Promise<void> {
    const body = record(
        await chatRequest(
            `assets/${encodeURIComponent(assetId)}/lease?leaseId=${
                encodeURIComponent(leaseId)
            }`,
            options,
            "DELETE",
        ),
    );
    if (body.released !== true) return invalidResponse();
}

export async function renameChatConversation(
    id: string,
    title: string,
    options: ChatRequestOptions = {},
): Promise<ChatConversation> {
    const body = record(
        await chatRequest(
            `conversation?id=${encodeURIComponent(id)}`,
            options,
            "PATCH",
            { title },
        ),
    );
    const conversation = readConversation(body.conversation);
    if (conversation.id !== id) invalidResponse();
    return conversation;
}

export interface ChatSettingsPatch {
    readonly systemPrompt?: string;
    readonly reasoningEffort?: "low" | "medium" | "high" | null;
    readonly disabledTools?: readonly string[];
}

/** Partial conversation settings update; omitted fields stay untouched. */
export async function updateChatConversationSettings(
    id: string,
    patch: ChatSettingsPatch,
    options: ChatRequestOptions = {},
): Promise<ChatConversation> {
    const body: Record<string, unknown> = {};
    if (patch.systemPrompt !== undefined) {
        body.systemPrompt = patch.systemPrompt;
    }
    if (patch.reasoningEffort !== undefined) {
        body.reasoningEffort = patch.reasoningEffort;
    }
    if (patch.disabledTools !== undefined) {
        body.disabledTools = parseChatDisabledTools(patch.disabledTools);
    }
    const payload = record(
        await chatRequest(
            `conversation?id=${encodeURIComponent(id)}`,
            options,
            "PATCH",
            body,
        ),
    );
    const conversation = readConversation(payload.conversation);
    if (conversation.id !== id) invalidResponse();
    return conversation;
}

export async function deleteChatConversation(
    id: string,
    options: ChatRequestOptions = {},
): Promise<void> {
    const body = record(
        await chatRequest(
            `conversation?id=${encodeURIComponent(id)}`,
            options,
            "DELETE",
        ),
    );
    if (body.deleted !== true || body.id !== id) invalidResponse();
}

export async function deleteChatMessage(
    conversationId: string,
    messageId: string,
    options: ChatRequestOptions = {},
): Promise<readonly string[]> {
    const body = record(
        await chatRequest(
            `message?conversationId=${encodeURIComponent(conversationId)}&id=${
                encodeURIComponent(messageId)
            }`,
            options,
            "DELETE",
        ),
    );
    const ids = Array.isArray(body.ids)
        ? body.ids.filter((item): item is string => typeof item === "string")
        : [];
    if (body.deleted !== true || !ids.includes(messageId)) invalidResponse();
    return ids;
}

/** Credentials stay out of URLs and support non-ASCII administration tokens. */
export function chatSocketProtocols(token: string): string[] {
    if (!token) return ["heimdall-chat"];
    let binary = "";
    for (const byte of new TextEncoder().encode(token)) {
        binary += String.fromCharCode(byte);
    }
    const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_")
        .replace(/=+$/, "");
    return ["heimdall-chat", `heimdall-auth.${encoded}`];
}

export function chatSocketUrl(baseUrl: string, endpoint = "/api/chat"): string {
    const url = new URL(endpoint, baseUrl);
    const path = url.pathname.replace(/\/+$/, "");
    url.pathname = path.endsWith("/socket") ? path : `${path}/socket`;
    url.search = "";
    url.hash = "";
    url.protocol = url.protocol === "https:" || url.protocol === "wss:"
        ? "wss:"
        : "ws:";
    return url.href;
}

function readEvent(value: unknown): ChatEvent {
    const body = record(value);
    switch (body.type) {
        case "user":
            return { type: "user", message: readMessage(body.message) };
        case "delta":
            return { type: "delta", text: text(body.text) };
        case "reasoning":
            return { type: "reasoning", text: text(body.text) };
        case "activity":
            if (!Array.isArray(body.items)) return invalidResponse();
            return { type: "activity", items: readActivity(body.items) };
        case "citations":
            if (!Array.isArray(body.items)) return invalidResponse();
            return { type: "citations", items: readCitations(body.items) };
        case "tool":
            if (!Array.isArray(body.calls)) return invalidResponse();
            return {
                type: "tool",
                calls: body.calls.map((value) => {
                    const call = record(value);
                    return {
                        callId: text(call.callId),
                        name: text(call.name),
                        argumentsText: text(call.argumentsText),
                    };
                }),
            };
        case "suggestions":
            if (
                !Array.isArray(body.items) ||
                !body.items.every((item) => typeof item === "string")
            ) return invalidResponse();
            return { type: "suggestions", items: body.items };
        case "done":
            return {
                type: "done",
                ...(body.conversation === undefined ? {} : {
                    conversation: readConversation(body.conversation),
                }),
            };
        case "stopped":
            return { type: "stopped" };
        case "error":
            return { type: "error", message: text(body.message) };
        default:
            return invalidResponse();
    }
}

/** One socket owns one generation; it never replays a send after reconnecting. */
export function openChatStream(
    command: ChatCommand,
    listeners: {
        onOpen?: () => void;
        onEvent?: (event: ChatEvent) => void;
    } = {},
    baseUrl = globalThis.location.href,
    options: ChatStreamOptions = {},
): ChatStream {
    const socket = new WebSocket(
        chatSocketUrl(baseUrl, options.endpoint),
        options.session
            ? ["heimdall-chat"]
            : chatSocketProtocols(getAdminToken()),
    );
    let settled = false;
    let stopping = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let resolve!: (value: "done" | "stopped") => void;
    let reject!: (error: Error) => void;
    const finished = new Promise<"done" | "stopped">((yes, no) => {
        resolve = yes;
        reject = no;
    });
    const openTimer = setTimeout(() => {
        settle(new Error("连接聊天服务超时，请检查网络后重试"));
    }, 15_000);

    function settle(result: "done" | "stopped" | Error): void {
        if (settled) return;
        settled = true;
        clearTimeout(openTimer);
        clearTimeout(stopTimer);
        socket.close();
        if (result instanceof Error) reject(result);
        else resolve(result);
    }

    socket.addEventListener("open", () => {
        if (settled) return;
        clearTimeout(openTimer);
        try {
            socket.send(JSON.stringify(command));
            listeners.onOpen?.();
        } catch (error) {
            settle(error instanceof Error ? error : new Error(String(error)));
        }
    });
    socket.addEventListener("message", (event) => {
        if (settled) return;
        try {
            const incoming = readEvent(JSON.parse(String(event.data)));
            listeners.onEvent?.(incoming);
            if (incoming.type === "done" || incoming.type === "stopped") {
                settle(incoming.type);
            } else if (incoming.type === "error") {
                settle(new Error(incoming.message));
            }
        } catch (error) {
            settle(error instanceof Error ? error : new Error(String(error)));
        }
    });
    socket.addEventListener("error", () => {
        settle(
            new Error(
                options.session
                    ? "无法连接聊天服务，请检查登录状态与网络连接"
                    : "无法连接聊天服务，请检查管理令牌与网络连接",
            ),
        );
    });
    socket.addEventListener("close", () => {
        settle(new Error("聊天连接已断开，正在重新读取已保存的消息"));
    });

    return {
        finished,
        stop() {
            if (settled || stopping) return;
            stopping = true;
            if (socket.readyState !== WebSocket.OPEN) {
                settle("stopped");
                return;
            }
            try {
                socket.send(JSON.stringify({ type: "stop" }));
                stopTimer = setTimeout(() => {
                    settle(
                        new Error(
                            "停止请求超时，连接已关闭，请刷新会话确认结果",
                        ),
                    );
                }, 10_000);
            } catch (error) {
                settle(
                    error instanceof Error ? error : new Error(String(error)),
                );
            }
        },
        close() {
            if (settled) return;
            if (socket.readyState === WebSocket.OPEN) {
                try {
                    socket.send(JSON.stringify({ type: "stop" }));
                } catch {
                    // Closing the socket also aborts the server-side run.
                }
            }
            settle(new Error("对话已关闭"));
        },
    };
}
