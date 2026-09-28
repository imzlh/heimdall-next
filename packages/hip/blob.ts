/**
 * Binary <-> base64 helpers for {@link BlobRef}. The kernel carries raw bytes
 * (`BlobRef.data`); protocol adapters use these only at their HTTP boundary,
 * where the OpenAI/Anthropic wire formats require base64.
 */

/** Encode bytes as a standard base64 string (no data: prefix). */
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
}

/** Decode a standard base64 string (data: prefix must be stripped first). */
export function base64ToBytes(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

/** Encode UTF-8 text as bytes, for inline text documents. */
export function utf8ToBytes(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}
