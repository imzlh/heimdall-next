import type {
    ChatAttachment,
    ChatConversation,
    ChatInitial,
    ChatMessage,
} from "@heimdall/admin-contracts/chat.ts";
import type { AdminDispatch } from "./bridge.ts";
import { readBoundedBody } from "./request.ts";

export interface ChatSnapshotOptions {
    readonly dispatch: AdminDispatch;
    readonly authorized: boolean;
    readonly available: boolean;
    readonly adminAuthToken?: string;
    readonly origin?: string;
    readonly conversationId?: string;
    readonly selectedModel?: string;
}

const MAX_SNAPSHOT_BYTES = 8_388_608;
const MAX_CONVERSATIONS = 200;
const MAX_MESSAGES = 200;
const MAX_TEXT = 100_000;

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

/** Read only the existing chat/model APIs and project the fields the page displays. */
export async function loadChatSnapshot(
    options: ChatSnapshotOptions,
): Promise<ChatInitial> {
    const initial: ChatInitial = {
        conversations: [],
        conversation: null,
        messages: [],
        models: [],
        authenticated: options.authorized,
        available: options.available,
    };
    if (!options.authorized || !options.available) return initial;
    const origin = options.origin ?? "http://localhost";
    const errors: string[] = [];
    let truncated = false;
    const string = (value: unknown, max = 512): string => {
        if (typeof value !== "string") return "";
        if (value.length > max) truncated = true;
        const secret = options.adminAuthToken?.trim();
        const safe = secret ? value.replaceAll(secret, "[已隐藏]") : value;
        return safe.slice(0, max);
    };
    const conversation = (value: unknown): ChatConversation | null => {
        const input = record(value);
        if (!input || typeof input.id !== "string") return null;
        return {
            id: string(input.id),
            title: string(input.title) || "新对话",
            createdAt: string(input.createdAt),
            updatedAt: string(input.updatedAt),
        };
    };
    const message = (value: unknown): ChatMessage | undefined => {
        const input = record(value);
        if (
            !input || typeof input.id !== "string" ||
            typeof input.conversationId !== "string" ||
            !["system", "user", "assistant", "tool"].includes(
                String(input.role),
            )
        ) return;
        const attachments: ChatAttachment[] = [];
        if (Array.isArray(input.attachments)) {
            for (const value of input.attachments.slice(0, 4)) {
                const image = record(value);
                if (
                    image && typeof image.mediaType === "string" &&
                    /^image\/[a-z0-9.+-]+$/.test(image.mediaType) &&
                    typeof image.dataBase64 === "string" &&
                    image.dataBase64.length <= 1_400_000 &&
                    /^[A-Za-z0-9+/]+={0,2}$/.test(image.dataBase64)
                ) {
                    attachments.push({
                        mediaType: image.mediaType,
                        dataBase64: image.dataBase64,
                    });
                }
            }
        }
        return {
            id: string(input.id),
            conversationId: string(input.conversationId),
            role: input.role as ChatMessage["role"],
            text: string(input.text, MAX_TEXT),
            createdAt: string(input.createdAt),
            ...(typeof input.callId === "string"
                ? { callId: string(input.callId) }
                : {}),
            ...(typeof input.name === "string"
                ? { name: string(input.name) }
                : {}),
            ...(attachments.length ? { attachments } : {}),
        };
    };
    const read = async (
        path: string,
        failure: string,
    ): Promise<Record<string, unknown>> => {
        try {
            const headers = new Headers({ accept: "application/json" });
            if (options.adminAuthToken !== undefined) {
                headers.set(
                    "authorization",
                    `Bearer ${options.adminAuthToken.trim()}`,
                );
            }
            const response = await options.dispatch(
                new Request(new URL(path, origin), {
                    headers,
                    redirect: "manual",
                }),
            );
            if (!response.ok) {
                if (response.status === 401) initial.authenticated = false;
                await response.body?.cancel();
                throw new Error("snapshot read failed");
            }
            const value = record(
                JSON.parse(
                    await readBoundedBody(
                        response.body,
                        MAX_SNAPSHOT_BYTES,
                        response.headers.get("content-length"),
                    ),
                ),
            );
            if (!value) throw new Error("invalid snapshot response");
            return value;
        } catch {
            errors.push(failure);
            return {};
        }
    };
    const [history, models, selected] = await Promise.all([
        read("/api/chat/conversations", "无法读取会话列表。"),
        read("/admin/models", "无法读取模型列表。"),
        options.conversationId
            ? read(
                `/api/chat/conversation?id=${
                    encodeURIComponent(options.conversationId)
                }`,
                "无法读取此对话，请从历史记录中重新选择。",
            )
            : undefined,
    ]);
    if (!initial.authenticated) return initial;
    if (Array.isArray(history.conversations)) {
        if (history.conversations.length > MAX_CONVERSATIONS) truncated = true;
        initial.conversations = history.conversations.slice(
            0,
            MAX_CONVERSATIONS,
        ).map(conversation).filter((value): value is ChatConversation =>
            value !== null
        );
    }
    if (Array.isArray(models.data)) {
        initial.models = [
            ...new Set(
                models.data.slice(0, 1024).map((value) =>
                    string(record(value)?.id)
                ).filter(Boolean),
            ),
        ];
    }
    initial.selectedModel =
        options.selectedModel && initial.models.includes(options.selectedModel)
            ? options.selectedModel
            : initial.models[0];
    if (selected) {
        initial.conversation = conversation(selected.conversation);
        if (Array.isArray(selected.messages)) {
            if (selected.messages.length > MAX_MESSAGES) truncated = true;
            initial.messages = selected.messages.slice(-MAX_MESSAGES).map(
                message,
            ).filter((value): value is ChatMessage =>
                value !== undefined &&
                value.conversationId === initial.conversation?.id
            );
        }
    }
    if (truncated) {
        errors.push("当前快照仅显示部分历史内容，完整记录仍保存在服务端。");
    }
    if (errors.length) initial.error = errors.join(" ");
    return initial;
}
