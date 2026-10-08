import type {
    ChatAttachment,
    ChatConversation,
    ChatInitial,
    ChatMessage,
} from "@heimdall/admin-contracts/chat.ts";
import { parseChatDisabledTools } from "@heimdall/admin-contracts/chat.ts";
import { projectChatTools } from "@heimdall/admin-contracts/chat-ui.ts";
import type { AdminDispatch } from "./bridge.ts";
import { readBoundedBody } from "./request.ts";
import { chatAttachmentUrl } from "../shared/chat-view.ts";
import { readChatBranches } from "../shared/chat-branches.ts";

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
        const branches = readChatBranches(input.branches);
        let disabledTools: string[] | undefined;
        if (input.disabledTools !== undefined) {
            try {
                disabledTools = parseChatDisabledTools(input.disabledTools);
            } catch {
                // Never project a partial selection as though every choice loaded.
                errors.push("无法读取会话插件设置，请刷新重试。");
                return null;
            }
        }
        return {
            id: string(input.id),
            title: string(input.title) || "新对话",
            createdAt: string(input.createdAt),
            updatedAt: string(input.updatedAt),
            ...(typeof input.activeMessageId === "string"
                ? { activeMessageId: string(input.activeMessageId) }
                : {}),
            ...(branches
                ? {
                    branches: branches.map((branch) => ({
                        messageId: string(branch.messageId),
                        label: string(branch.label),
                        selected: branch.selected,
                    })),
                }
                : {}),
            ...(typeof input.systemPrompt === "string" &&
                    input.systemPrompt.length > 0
                ? { systemPrompt: input.systemPrompt }
                : {}),
            ...(disabledTools ? { disabledTools } : {}),
            ...(input.reasoningEffort === "low" ||
                    input.reasoningEffort === "medium" ||
                    input.reasoningEffort === "high"
                ? { reasoningEffort: input.reasoningEffort }
                : {}),
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
                    image && typeof image.assetId === "string" &&
                    typeof image.mediaType === "string"
                ) {
                    const attachment: ChatAttachment = {
                        assetId: image.assetId,
                        mediaType: image.mediaType,
                    };
                    const url = chatAttachmentUrl(attachment);
                    if (url) {
                        attachments.push({
                            ...attachment,
                            url,
                            ...(typeof image.size === "number" &&
                                    Number.isSafeInteger(image.size) &&
                                    image.size > 0 &&
                                    image.size <= 5 * 1024 * 1024
                                ? { size: image.size }
                                : {}),
                            ...(typeof image.name === "string"
                                ? { name: string(image.name, 240) }
                                : {}),
                        });
                    }
                    continue;
                }
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
        const activity: { summary: string }[] = [];
        if (Array.isArray(input.activity)) {
            for (const value of input.activity.slice(0, 20)) {
                const item = record(value);
                if (item && typeof item.summary === "string" && item.summary) {
                    activity.push({ summary: string(item.summary, 400) });
                }
            }
        }
        const citations: { label?: string; url?: string; ref?: string }[] = [];
        if (Array.isArray(input.citations)) {
            for (const value of input.citations.slice(0, 50)) {
                const item = record(value);
                if (!item) continue;
                const citation: { label?: string; url?: string; ref?: string } =
                    {
                        ...(typeof item.label === "string" && item.label
                            ? { label: string(item.label, 400) }
                            : {}),
                        ...(typeof item.url === "string" && item.url
                            ? { url: string(item.url, 2048) }
                            : {}),
                        ...(typeof item.ref === "string" && item.ref
                            ? { ref: string(item.ref, 256) }
                            : {}),
                    };
                if (
                    citation.label !== undefined || citation.url !== undefined
                ) {
                    citations.push(citation);
                }
            }
        }
        const branch = record(input.branch);
        const branchIds = Array.isArray(branch?.messageIds) &&
                branch.messageIds.length <= 10_000 &&
                branch.messageIds.every((id) =>
                    typeof id === "string" && id.length > 0 && id.length <= 512
                )
            ? branch.messageIds as string[]
            : undefined;
        const validBranch = branch && branchIds &&
            typeof branch.index === "number" &&
            Number.isInteger(branch.index) && branch.index >= 0 &&
            branch.index < branchIds.length &&
            branch.count === branchIds.length &&
            new Set(branchIds).size === branchIds.length &&
            branchIds[branch.index] === input.id;
        return {
            id: string(input.id),
            conversationId: string(input.conversationId),
            role: input.role as ChatMessage["role"],
            text: string(input.text, MAX_TEXT),
            createdAt: string(input.createdAt),
            ...(input.parentId === null || typeof input.parentId === "string"
                ? {
                    parentId: input.parentId === null
                        ? null
                        : string(input.parentId),
                }
                : {}),
            ...(validBranch
                ? {
                    branch: {
                        index: branch.index as number,
                        count: branchIds.length,
                        messageIds: branchIds.map((id) => string(id)),
                    },
                }
                : {}),
            ...(input.status === "completed" || input.status === "failed" ||
                    input.status === "stopped"
                ? { status: input.status }
                : {}),
            ...(record(input.error)
                ? {
                    error: {
                        code: string(record(input.error)?.code),
                        message: string(record(input.error)?.message, 2048),
                    },
                }
                : {}),
            ...(typeof input.callId === "string"
                ? { callId: string(input.callId) }
                : {}),
            ...(typeof input.name === "string"
                ? { name: string(input.name) }
                : {}),
            ...(attachments.length ? { attachments } : {}),
            ...(typeof input.reasoning === "string" && input.reasoning
                ? { reasoning: string(input.reasoning, MAX_TEXT) }
                : {}),
            ...(activity.length ? { activity } : {}),
            ...(citations.length ? { citations } : {}),
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
    const [history, models, selected, plugins] = await Promise.all([
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
        read("/admin/plugins", "无法读取插件列表。"),
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
    const pluginDtos = Array.isArray(plugins.data)
        ? plugins.data
        : Array.isArray(plugins.plugins)
        ? plugins.plugins
        : [];
    if (pluginDtos.length) {
        initial.tools = projectChatTools(pluginDtos).map((tool) => ({
            id: string(tool.id, 80),
            name: string(tool.name, 128),
            ...(tool.description
                ? { description: string(tool.description, 512) }
                : {}),
        }));
    }
    if (
        options.selectedModel && initial.models.includes(options.selectedModel)
    ) {
        initial.selectedModel = options.selectedModel;
    }
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
