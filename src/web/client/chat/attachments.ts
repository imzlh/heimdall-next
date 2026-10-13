import type { ChatAttachment } from "../api/chat.ts";

const MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_ATTACHMENTS = 4;
const MAX_BASE64_CHARS = 1_400_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export const CHAT_ATTACHMENT_ACCEPT = MEDIA_TYPES.join(",");

/** Files only: pasted HTML and remote image URLs never trigger an upload. */
export function transferredChatFiles(
    transfer: DataTransfer | null,
): File[] {
    if (!transfer) return [];
    const files = Array.from(transfer.files);
    if (files.length) return files;
    return Array.from(transfer.items).flatMap((item) => {
        const file = item.kind === "file" ? item.getAsFile() : null;
        return file ? [file] : [];
    });
}

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
        if (attachment.assetId !== undefined) {
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(attachment.assetId)) {
                throw new Error("图片引用无效，请重新选择");
            }
            continue;
        }
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

/** Check every file before uploading any; drafts only retain asset references. */
export async function uploadChatAttachments(
    files: readonly File[],
    upload: (file: File) => Promise<ChatAttachment>,
    existing: readonly ChatAttachment[] = [],
): Promise<ChatAttachment[]> {
    if (existing.length + files.length > MAX_ATTACHMENTS) {
        throw new Error("每条消息最多添加 4 张图片");
    }
    validateChatAttachments(existing);
    for (const file of files) {
        validateMediaType(file.type);
        if (file.size === 0 || file.size > MAX_FILE_BYTES) {
            throw new Error("图片不能为空，且每张图片最多 5 MiB");
        }
    }
    const results = await Promise.allSettled(files.map(upload));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const added = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []
    );
    if (added.some((attachment) => !attachment.assetId)) {
        throw new Error("图片未保存为资产，请重试上传");
    }
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
