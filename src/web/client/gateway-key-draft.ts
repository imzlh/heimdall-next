/** A gateway credential contains 256 random bits, including on HTTP LAN origins. */
export function generateGatewayKey(
    cryptography: Pick<Crypto, "getRandomValues"> = globalThis.crypto,
): string {
    if (typeof cryptography?.getRandomValues !== "function") {
        throw new Error("当前浏览器不支持安全随机数，请手动填写密钥");
    }
    const bytes = cryptography.getRandomValues(new Uint8Array(32));
    return "hd_" +
        Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
            .join("");
}

/** Empty drafts preserve the stored credential; only explicit clearing removes it. */
export function gatewayKeyPatch(
    draft: string,
    clearRequested: boolean,
): { proxyKey?: string } {
    if (clearRequested) return { proxyKey: "" };
    const proxyKey = draft.trim();
    return proxyKey ? { proxyKey } : {};
}

export const GATEWAY_KEY_REVEAL_MS = 60_000;
