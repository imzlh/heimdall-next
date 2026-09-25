/** Digest and signature primitives shared by package verification and tools. */

import type { PluginSecurityPolicy, TrustedPluginSigner } from "./mod.ts";
import { PluginVerificationError } from "./mod.ts";
import { fail } from "./verification-errors.ts";

const encoder = new TextEncoder();
const SIGNATURE_DOMAIN = "heimdall.plugin.artifact.signature.v1\0";

export function encodeBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
        binary += String.fromCharCode(
            ...bytes.subarray(offset, offset + 0x8000),
        );
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
        /=+$/u,
        "",
    );
}

export function decodeBase64Url(value: string): Uint8Array {
    if (
        value.length === 0 ||
        ![...value].every((character) => /[A-Za-z0-9_-]/u.test(character))
    ) {
        fail("invalid_signature", "invalid base64url value");
    }
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
        "=".repeat((4 - value.length % 4) % 4);
    try {
        const binary = atob(padded);
        return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
        fail("invalid_signature", "invalid base64url value");
    }
}

export async function computePluginArtifactDigest(
    bytes: Uint8Array,
): Promise<string> {
    const result = await crypto.subtle.digest(
        "SHA-256",
        new Uint8Array(bytes) as BufferSource,
    );
    return "sha256-" + encodeBase64Url(new Uint8Array(result));
}

export function validDigest(value: string): boolean {
    if (!value.startsWith("sha256-")) return false;
    try {
        return decodeBase64Url(value.slice(7)).byteLength === 32;
    } catch {
        return false;
    }
}

export function createPluginSignaturePayload(value: string): Uint8Array {
    if (!validDigest(value)) {
        fail("invalid_artifact", "digest must be a sha256 base64url value");
    }
    const raw = decodeBase64Url(value.slice(7));
    const domain = encoder.encode(SIGNATURE_DOMAIN);
    const result = new Uint8Array(domain.byteLength + raw.byteLength);
    result.set(domain);
    result.set(raw, domain.byteLength);
    return result;
}

export async function importEd25519PublicKey(
    value: CryptoKey | Uint8Array | string,
): Promise<CryptoKey> {
    if (typeof value !== "string" && !(value instanceof Uint8Array)) {
        return value as CryptoKey;
    }
    const raw = typeof value === "string"
        ? decodeBase64Url(value)
        : new Uint8Array(value as Uint8Array);
    try {
        return await crypto.subtle.importKey(
            "raw",
            raw as BufferSource,
            { name: "Ed25519" },
            false,
            ["verify"],
        );
    } catch (error) {
        throw new PluginVerificationError(
            "invalid_signature",
            "invalid Ed25519 public key: " +
                (error instanceof Error ? error.message : String(error)),
        );
    }
}

export function findTrustedSigner(
    policy: PluginSecurityPolicy,
    keyId: string,
    pluginId: string,
): TrustedPluginSigner | undefined {
    const candidates = [
        ...(policy.trustedSigners ?? []),
        ...(policy.trustedPublishers ?? []),
    ];
    return candidates.find((candidate) =>
        candidate.keyId === keyId &&
        (candidate.pluginIds === undefined ||
            candidate.pluginIds.includes(pluginId))
    );
}
