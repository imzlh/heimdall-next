import type {
    ChatCommand,
    ChatConversation,
    ChatEvent,
    ChatMessage,
} from "@heimdall/admin-contracts/chat.ts";
import { AdminApiError, getAdminToken, request } from "./admin.ts";
import { payloadRecord } from "./transport.ts";

export type {
    ChatAttachment,
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
    return {
        id: text(body.id),
        title: text(body.title),
        createdAt: text(body.createdAt),
        updatedAt: text(body.updatedAt),
    };
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
    if (body.attachments !== undefined) {
        if (!Array.isArray(body.attachments)) return invalidResponse();
        message.attachments = body.attachments.map((item) => {
            const attachment = record(item);
            return {
                mediaType: text(attachment.mediaType),
                dataBase64: text(attachment.dataBase64),
            };
        });
    }
    return message;
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
    const init = {
        method,
        signal: options.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
            Accept: "application/json",
            ...(body === undefined
                ? {}
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
    return {
        conversation: readConversation(body.conversation),
        messages: body.messages.map(readMessage),
    };
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
