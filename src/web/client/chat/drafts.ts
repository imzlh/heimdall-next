import type { ChatAttachment } from "../api/chat.ts";
import { validateChatAttachments } from "./attachments.ts";

export interface ChatDraft {
    readonly text: string;
    readonly attachments: readonly ChatAttachment[];
}

const PREFIX = "heimdall.chat.draft.";

/** Persist small references only; a stored lease never confers tab ownership. */
export function writeStoredDraft(id: string, draft: ChatDraft): void {
    try {
        const attachments = draft.attachments.filter((item) => item.assetId)
            .map(reference);
        if (draft.text || attachments.length) {
            globalThis.localStorage?.setItem(
                PREFIX + id,
                JSON.stringify({ text: draft.text, attachments }),
            );
        } else globalThis.localStorage?.removeItem(PREFIX + id);
    } catch {
        /* Private browsing or quota limits must not block the in-memory draft. */
    }
}

export function readStoredDraft(id: string): ChatDraft {
    try {
        const raw = globalThis.localStorage?.getItem(PREFIX + id);
        if (!raw || raw.length > 200_000) return { text: "", attachments: [] };
        const parsed = JSON.parse(raw) as {
            text?: unknown;
            attachments?: unknown;
        };
        const text = typeof parsed?.text === "string"
            ? parsed.text.slice(0, 100_000)
            : "";
        let attachments: ChatAttachment[] = [];
        try {
            if (Array.isArray(parsed.attachments)) {
                attachments = parsed.attachments.map(reference);
                validateChatAttachments(attachments);
            }
        } catch {
            attachments = [];
        }
        return { text, attachments };
    } catch {
        return { text: "", attachments: [] };
    }
}

function reference(value: ChatAttachment): ChatAttachment {
    if (
        !value || typeof value.assetId !== "string" ||
        typeof value.mediaType !== "string"
    ) throw new TypeError("invalid saved image reference");
    return {
        assetId: value.assetId,
        mediaType: value.mediaType,
        ...(typeof value.leaseId === "string"
            ? { leaseId: value.leaseId }
            : {}),
        ...(typeof value.size === "number" ? { size: value.size } : {}),
        ...(typeof value.name === "string"
            ? { name: value.name.slice(0, 240) }
            : {}),
    };
}
