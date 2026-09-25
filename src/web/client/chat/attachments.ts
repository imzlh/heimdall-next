import type { ChatAttachment } from "../api/chat.ts";

const MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_ATTACHMENTS = 4;
const MAX_BASE64_CHARS = 1_400_000;
const MAX_FILE_BYTES = Math.floor(MAX_BASE64_CHARS / 4) * 3;

export const CHAT_ATTACHMENT_ACCEPT = MEDIA_TYPES.join(",");

/** Validate the complete draft, including images retained from earlier picks. */
export function validateChatAttachments(
    attachments: readonly ChatAttachment[],
): void {
    if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) {
        throw new Error("每条消息最多添加 4 张图片");
    }
    for (const attachment of attachments) {
        if (
            attachment === null || typeof attachment !== "object" ||
            Array.isArray(attachment)
        ) {
            throw new Error("图片附件无效，请重新选择");
        }
        validateMediaType(attachment.mediaType);
        const data = typeof attachment.dataBase64 === "string"
            ? attachment.dataBase64.trim()
            : "";
        if (
            data.length === 0 || data.length > MAX_BASE64_CHARS ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
        ) {
            throw new Error("图片数据无效或超过大小限制，请重新选择");
        }
    }
}

/** Check every file before reading any, and return a new combined draft. */
export async function readChatAttachments(
    files: readonly File[],
    existing: readonly ChatAttachment[] = [],
): Promise<ChatAttachment[]> {
    if (existing.length + files.length > MAX_ATTACHMENTS) {
        throw new Error("每条消息最多添加 4 张图片");
    }
    validateChatAttachments(existing);
    for (const file of files) {
        validateMediaType(file.type);
        if (file.size === 0 || file.size > MAX_FILE_BYTES) {
            throw new Error("图片不能为空，且每张图片最多 1,050,000 字节");
        }
    }
    const added = await Promise.all(files.map(async (file) => ({
        mediaType: file.type,
        dataBase64: encodeBase64(new Uint8Array(await file.arrayBuffer())),
    })));
    const attachments = [...existing, ...added];
    validateChatAttachments(attachments);
    return attachments;
}

function validateMediaType(mediaType: string): void {
    if (
        typeof mediaType !== "string" || !MEDIA_TYPES.includes(mediaType.trim())
    ) {
        throw new Error("仅支持 PNG、JPEG、GIF 和 WebP 图片");
    }
}

function encodeBase64(bytes: Uint8Array): string {
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
        chunks.push(
            String.fromCharCode(...bytes.subarray(offset, offset + 32_768)),
        );
    }
    return btoa(chunks.join(""));
}
