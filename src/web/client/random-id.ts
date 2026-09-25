/** Cryptographic UUID v4 for browser identifiers and unguessable frame nonces. */
export function randomUuid(): string {
    const cryptography = globalThis.crypto;
    if (typeof cryptography.randomUUID === "function") {
        return cryptography.randomUUID();
    }
    // randomUUID requires a secure context, but getRandomValues also works on
    // ordinary HTTP LAN origins. Never fall back to a predictable random source.
    const bytes = cryptography.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
        hex.slice(16, 20)
    }-${hex.slice(20)}`;
}
