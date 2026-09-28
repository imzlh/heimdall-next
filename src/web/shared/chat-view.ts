import type {
    ChatAttachment,
    ChatMessage,
} from "@heimdall/admin-contracts/chat.ts";

export function chatRoleLabel(
    message: Pick<ChatMessage, "role" | "name" | "callId">,
): string {
    if (message.role === "user") return "你";
    if (message.role === "assistant" && message.callId) {
        return message.name ? `插件调用 · ${message.name}` : "插件调用";
    }
    if (message.role === "assistant") return "Heimdall";
    if (message.role === "tool") {
        return message.name ? `插件 · ${message.name}` : "插件结果";
    }
    return "系统";
}

export function chatMessageStatus(
    message: Pick<ChatMessage, "status" | "text">,
): string {
    if (message.status === "failed") {
        return message.text ? "生成失败，已保留收到的内容。" : "回复生成失败。";
    }
    if (message.status === "stopped") {
        return message.text ? "已停止生成，已保留收到的内容。" : "已停止生成。";
    }
    return "";
}

/** Images use the authenticated local asset route; legacy inline previews still work. */
export function chatAttachmentUrl(
    attachment: ChatAttachment,
): string | undefined {
    if (
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
            attachment.mediaType,
        )
    ) return;
    if (attachment.assetId !== undefined) {
        if (
            !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
                .test(attachment.assetId)
        ) return;
        return `/admin/chat/api/assets/${attachment.assetId}`;
    }
    if (
        !attachment.dataBase64 || attachment.dataBase64.length > 1_400_000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.dataBase64)
    ) return;
    return `data:${attachment.mediaType};base64,${attachment.dataBase64}`;
}
