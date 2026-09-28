import type {
    ChatAssetAttachment,
    ChatAssetRecord,
    ChatAssetStore,
    ChatAttachment,
    ChatMessageRecord,
    ChatStore,
} from "@heimdall/storage";
import type { ImagePart } from "@heimdall/hip";
import type { ChatAssetAttachment as PresentedAttachment } from "@heimdall/admin-contracts/chat.ts";
import {
    CHAT_ASSET_ID,
    ChatAssetLinks,
    chatAssetPublicOrigin,
} from "./asset-links.ts";

export const CHAT_ASSET_MEDIA_TYPES = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
] as const;
export const CHAT_ASSET_MAX_BYTES = 5 * 1024 * 1024;
export const CHAT_ASSET_LEASE_TTL_MS = 24 * 60 * 60_000;
const LEGACY_MAX_BASE64_CHARS = 1_400_000;

export interface ChatAssetReferences {
    referencedAssetIds(ids: readonly string[]): readonly string[];
}

export class ChatAssetError extends Error {
    constructor(
        readonly status: 400 | 403 | 404 | 413 | 415,
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "ChatAssetError";
    }
}

interface AttachmentMigrationStore {
    replaceMessageAttachments?(
        messageId: string,
        attachments: readonly ChatAttachment[],
    ): void;
    listLegacyAttachments?(limit?: number): readonly {
        readonly messageId: string;
        readonly attachments: readonly ChatAttachment[];
    }[];
    quarantineLegacyAttachments?(
        messageId: string,
        indices: readonly number[],
        reason: string,
    ): void;
}

/** Asset bytes are resolved solely by local IDs; this service never fetches URLs. */
export class ChatAssetService {
    readonly links: ChatAssetLinks;
    readonly #origin: string | undefined;
    readonly #now: () => Date;
    #quarantinedAttachments = 0;

    get quarantinedAttachments(): number {
        return this.#quarantinedAttachments;
    }

    constructor(readonly store: ChatAssetStore, options: {
        readonly publicBaseUrl?: string;
        readonly now?: () => Date;
    } = {}) {
        this.#origin = chatAssetPublicOrigin(options.publicBaseUrl);
        this.#now = options.now ?? (() => new Date());
        this.links = new ChatAssetLinks(() => this.#now().getTime());
    }

    async upload(
        bytes: Uint8Array,
        mediaType: string,
        name?: string,
    ): Promise<PresentedAttachment> {
        return await this.#storeImage(bytes, mediaType, name, true);
    }

    async #storeImage(
        bytes: Uint8Array,
        mediaType: string,
        name?: string,
        reserve = false,
    ): Promise<PresentedAttachment> {
        assertMediaType(mediaType);
        if (!bytes.length || bytes.length > CHAT_ASSET_MAX_BYTES) {
            throw new ChatAssetError(
                413,
                "payload_too_large",
                "图片不能为空，且每张图片最多 5 MB。",
            );
        }
        const digest = new Uint8Array(
            await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
        );
        const sha256 = Array.from(
            digest,
            (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        const safeName = name && Array.from(name).filter((character) => {
            const code = character.charCodeAt(0);
            return code >= 32 && code !== 127;
        }).join("").replaceAll("\\", "/")
            .split("/").pop()?.trim().slice(0, 240);
        const lease = reserve
            ? { id: crypto.randomUUID(), expiresAt: this.#leaseExpiry() }
            : undefined;
        const asset = this.store.put(
            {
                id: crypto.randomUUID(),
                mediaType,
                sha256,
                size: bytes.length,
                createdAt: this.#now().toISOString(),
                ...(safeName ? { name: safeName } : {}),
            },
            bytes,
            lease,
        );
        return {
            ...presentAsset(asset),
            ...(lease ? { leaseId: lease.id } : {}),
        };
    }

    /** Each draft reserves its own lease, even when the binary asset is shared. */
    lease(assetId: string): PresentedAttachment {
        const asset = this.get(assetId);
        const leaseId = crypto.randomUUID();
        if (!this.store.createLease(assetId, leaseId, this.#leaseExpiry())) {
            throw new Error("asset lease id is already in use");
        }
        return { ...presentAsset(asset), leaseId };
    }

    releaseLease(
        assetId: string,
        leaseId: string,
        chat?: ChatAssetReferences,
    ): boolean {
        if (!CHAT_ASSET_ID.test(assetId) || !CHAT_ASSET_ID.test(leaseId)) {
            throw new ChatAssetError(
                400,
                "invalid_asset_lease",
                "图片草稿引用无效。",
            );
        }
        const released = this.store.deleteLease(assetId, leaseId);
        if (released) {
            this.store.markForReclaim([assetId], this.#now().toISOString());
        }
        if (chat) this.sweep(chat);
        return released;
    }

    /** Call only after the user message has been durably appended. */
    consumeLeases(
        attachments: readonly ChatAttachment[],
        chat: ChatAssetReferences,
    ): void {
        for (const attachment of attachments) {
            if (attachment.assetId && attachment.leaseId) {
                this.store.deleteLease(attachment.assetId, attachment.leaseId);
            }
        }
        this.sweep(chat);
    }

    #leaseExpiry(): string {
        return new Date(this.#now().getTime() + CHAT_ASSET_LEASE_TTL_MS)
            .toISOString();
    }

    /** Validate IDs against storage and canonicalize metadata; never trust a supplied URL. */
    async normalizeAttachments(
        input: readonly ChatAttachment[],
    ): Promise<readonly ChatAssetAttachment[]> {
        if (!Array.isArray(input) || input.length > 4) {
            throw new ChatAssetError(
                400,
                "invalid_attachment",
                "每条消息最多添加 4 张图片。",
            );
        }
        const result: ChatAssetAttachment[] = [];
        for (const attachment of input) {
            if (!attachment || typeof attachment !== "object") {
                throw new ChatAssetError(
                    400,
                    "invalid_attachment",
                    "图片附件无效。",
                );
            }
            if (attachment.assetId !== undefined) {
                if (
                    attachment.leaseId !== undefined &&
                    !CHAT_ASSET_ID.test(attachment.leaseId)
                ) {
                    throw new ChatAssetError(
                        400,
                        "invalid_asset_lease",
                        "图片草稿引用无效。",
                    );
                }
                const asset = this.get(attachment.assetId);
                // Renew before returning to the async command, so cleanup cannot
                // race a long-lived draft between normalization and durable append.
                if (
                    attachment.leaseId &&
                    !this.store.createLease(
                        asset.id,
                        attachment.leaseId,
                        this.#leaseExpiry(),
                    )
                ) {
                    throw new ChatAssetError(
                        400,
                        "invalid_asset_lease",
                        "图片草稿引用不匹配。",
                    );
                }
                result.push({ assetId: asset.id, mediaType: asset.mediaType });
            } else {
                const bytes = legacyBytes(attachment);
                const asset = await this.#storeImage(
                    bytes,
                    attachment.mediaType,
                );
                result.push({
                    assetId: asset.assetId,
                    mediaType: asset.mediaType,
                });
            }
        }
        return result;
    }

    get(id: string): ChatAssetRecord {
        if (typeof id !== "string" || !CHAT_ASSET_ID.test(id)) {
            throw new ChatAssetError(400, "invalid_asset_id", "图片引用无效。");
        }
        const asset = this.store.get(id);
        if (!asset) {
            throw new ChatAssetError(
                404,
                "asset_not_found",
                "图片不存在或已删除，请重新上传。",
            );
        }
        return asset;
    }

    /** Startup migrates every branch in bounded batches, then clears legacy bytes. */
    async migrateHistory(store: AttachmentMigrationStore): Promise<number> {
        if (!store.listLegacyAttachments || !store.replaceMessageAttachments) {
            return 0;
        }
        let migrated = 0;
        while (true) {
            const batch = store.listLegacyAttachments(16);
            if (!batch.length) return migrated;
            for (const item of batch) {
                const references: ChatAssetAttachment[] = [];
                const damaged: number[] = [];
                for (const [index, attachment] of item.attachments.entries()) {
                    try {
                        references.push(
                            ...await this.normalizeAttachments([attachment]),
                        );
                    } catch (error) {
                        // Old writers accepted syntactically shaped but undecodable base64.
                        // Preserve those bytes for recovery without making startup depend on them.
                        if (
                            attachment.assetId === undefined &&
                            error instanceof ChatAssetError &&
                            store.quarantineLegacyAttachments
                        ) {
                            damaged.push(index);
                        } else throw error;
                    }
                }
                if (damaged.length) {
                    store.quarantineLegacyAttachments!(
                        item.messageId,
                        damaged,
                        "Legacy image cannot be decoded or has an unsupported media type",
                    );
                    this.#quarantinedAttachments += damaged.length;
                }
                store.replaceMessageAttachments(item.messageId, references);
                migrated++;
            }
        }
    }

    /** Reclaim only deletion candidates that have no references in any branch or fork. */
    reclaim(
        candidates: readonly string[],
        chat: ChatAssetReferences,
    ): number {
        const unique = [...new Set(candidates)].filter((id) =>
            CHAT_ASSET_ID.test(id)
        );
        this.store.markForReclaim(unique, this.#now().toISOString());
        return this.sweep(chat);
    }

    /** Bounded opportunistic cleanup; no scheduler or scan of unrelated assets. */
    sweep(chat: ChatAssetReferences): number {
        const now = this.#now().toISOString();
        this.store.pruneExpiredLeases(now, 100);
        const candidates = this.store.listReclaimable(now, 100);
        const used = new Set(chat.referencedAssetIds(candidates));
        this.store.clearReclaim([...used]);
        let removed = 0;
        for (const id of candidates) {
            if (used.has(id)) continue;
            if (this.store.deleteIfUnleased(id, now)) removed++;
        }
        return removed;
    }

    /** Browser snapshots contain only IDs, metadata and the authenticated local route. */
    async presentMessages<T extends ChatMessageRecord>(
        messages: readonly T[],
        chat?: ChatStore & AttachmentMigrationStore,
    ): Promise<T[]> {
        const output: T[] = [];
        for (const message of messages) {
            if (!message.attachments?.length) {
                output.push(message);
                continue;
            }
            const references = await this.normalizeAttachments(
                message.attachments,
            );
            if (
                message.attachments.some((item) => item.assetId === undefined)
            ) {
                chat?.replaceMessageAttachments?.(message.id, references);
            }
            output.push({
                ...message,
                attachments: references.map((item) =>
                    presentAsset(this.get(item.assetId))
                ),
            });
        }
        return output;
    }

    /** Fresh short links per run; local/offline hosts inline only at the upstream boundary. */
    async imageParts(
        messageId: string,
        attachments: readonly ChatAttachment[],
    ): Promise<ImagePart[]> {
        const references = await this.normalizeAttachments(attachments);
        return await Promise.all(references.map(async (reference, index) => {
            const asset = this.get(reference.assetId);
            const source = this.#origin
                ? {
                    uri: new URL(await this.links.path(asset.id), this.#origin)
                        .href,
                }
                : {
                    data: this.store.read(asset.id)!.bytes,
                };
            return {
                id: `${messageId}:image:${index}`,
                type: "image" as const,
                source: {
                    mediaType: asset.mediaType,
                    bytes: asset.size,
                    sha256: asset.sha256,
                    ...source,
                },
            };
        }));
    }
}

function presentAsset(asset: ChatAssetRecord): PresentedAttachment {
    return {
        assetId: asset.id,
        mediaType: asset.mediaType,
        size: asset.size,
        url: `/admin/chat/api/assets/${asset.id}`,
        ...(asset.name ? { name: asset.name } : {}),
    };
}

export function assertMediaType(mediaType: string): void {
    if (!(CHAT_ASSET_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
        throw new ChatAssetError(
            415,
            "unsupported_media_type",
            "仅支持 PNG、JPEG、GIF 和 WebP 图片。",
        );
    }
}

function legacyBytes(attachment: ChatAttachment): Uint8Array {
    assertMediaType(attachment.mediaType);
    const data = attachment.dataBase64;
    if (
        typeof data !== "string" || !data.length ||
        data.length > LEGACY_MAX_BASE64_CHARS ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
    ) {
        throw new ChatAssetError(
            400,
            "invalid_attachment",
            "旧版图片数据无效，请重新上传。",
        );
    }
    try {
        return Uint8Array.from(
            atob(data),
            (character) => character.charCodeAt(0),
        );
    } catch {
        throw new ChatAssetError(
            400,
            "invalid_attachment",
            "旧版图片数据无效，请重新上传。",
        );
    }
}
