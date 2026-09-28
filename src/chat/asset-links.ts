/** Per-process links authorize a single image for a bounded upstream fetch. */
export const CHAT_ASSET_LINK_TTL_MS = 10 * 60_000;
export const CHAT_ASSET_ID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class ChatAssetLinks {
    readonly #key = crypto.subtle.generateKey(
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
    );

    constructor(readonly now: () => number = Date.now) {}

    async path(assetId: string): Promise<string> {
        if (!CHAT_ASSET_ID.test(assetId)) {
            throw new TypeError("invalid asset id");
        }
        const expiry = this.now() + CHAT_ASSET_LINK_TTL_MS;
        const signature = new Uint8Array(
            await crypto.subtle.sign(
                "HMAC",
                await this.#key,
                payload(assetId, String(expiry)),
            ),
        );
        const encoded = btoa(String.fromCharCode(...signature)).replaceAll(
            "+",
            "-",
        )
            .replaceAll("/", "_").replaceAll("=", "");
        return `/api/chat/asset-links/${assetId}?exp=${expiry}&sig=${encoded}`;
    }

    async verify(
        assetId: string,
        expiry: string | null,
        signature: string | null,
    ): Promise<boolean> {
        if (!CHAT_ASSET_ID.test(assetId) || !expiry || !signature) return false;
        if (
            !/^\d{1,16}$/.test(expiry) || !/^[A-Za-z0-9_-]{43}$/.test(signature)
        ) return false;
        const expiresAt = Number(expiry);
        const now = this.now();
        if (
            !Number.isSafeInteger(expiresAt) || expiresAt <= now ||
            expiresAt > now + CHAT_ASSET_LINK_TTL_MS
        ) return false;
        const bytes = Uint8Array.from(
            atob(signature.replaceAll("-", "+").replaceAll("_", "/")),
            (character) => character.charCodeAt(0),
        );
        return await crypto.subtle.verify(
            "HMAC",
            await this.#key,
            bytes,
            payload(assetId, expiry),
        );
    }
}

function payload(assetId: string, expiry: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(
        `heimdall-chat-asset\n${assetId}\n${expiry}`,
    );
}

/** Only an explicit, credential-free HTTP(S) origin may be handed to upstreams. */
export function chatAssetPublicOrigin(
    value: string | undefined,
): string | undefined {
    if (!value?.trim()) return;
    const base = new URL(value.trim());
    if (
        (base.protocol !== "https:" && base.protocol !== "http:") ||
        base.username || base.password ||
        base.pathname !== "/" || base.search || base.hash
    ) {
        throw new TypeError(
            "HEIMDALL_PUBLIC_BASE_URL must be an HTTP(S) origin without credentials, path, query or fragment",
        );
    }
    return base.origin;
}
