/**
 * Pure package verification. The verifier validates metadata and signatures
 * without importing an entrypoint or depending on a host runtime.
 */

import type {
    PluginArtifact,
    PluginArtifactInput,
    PluginSecurityPolicy,
    PluginVerification,
    PluginVerifier,
    TrustedPluginSigner,
} from "./mod.ts";
import { PluginVerificationError } from "./mod.ts";
import { validatePluginManifest } from "./manifest.ts";
import {
    computePluginArtifactDigest,
    createPluginSignaturePayload,
    findTrustedSigner,
    importEd25519PublicKey,
    validDigest,
} from "./verification-crypto.ts";
import type { PluginPermissions } from "../contracts/mod.ts";
import { fail } from "./verification-errors.ts";

export type { PluginVerificationErrorCode } from "./verification-errors.ts";
export {
    computePluginArtifactDigest,
    createPluginSignaturePayload,
    encodeBase64Url,
} from "./verification-crypto.ts";
export { validatePluginManifest } from "./manifest.ts";

const FILESYSTEM_LEVEL: Readonly<
    Record<"none" | "read" | "read-write", number>
> = {
    none: 0,
    read: 1,
    "read-write": 2,
};

function normalizePolicySet(
    first: Iterable<string> | undefined,
    second: Iterable<string> | undefined,
): Set<string> {
    return new Set([...(first ?? []), ...(second ?? [])]);
}

function trustedDigests(
    policy: PluginSecurityPolicy,
): Readonly<Record<string, string>> | undefined {
    if (policy.trustedPluginDigests === undefined) {
        return policy.trustedBuiltinDigests;
    }
    if (policy.trustedBuiltinDigests === undefined) {
        return policy.trustedPluginDigests;
    }
    return { ...policy.trustedBuiltinDigests, ...policy.trustedPluginDigests };
}

function safeEntrypoint(entrypoint: string): void {
    if (
        entrypoint.length === 0 || entrypoint.length > 512 ||
        entrypoint.startsWith("/") || entrypoint.includes("\\")
    ) {
        fail("unsafe_entrypoint", "unsafe plugin entrypoint: " + entrypoint);
    }
    if (
        entrypoint.split("/").some((segment) =>
            segment.length === 0 || segment === "." || segment === ".."
        )
    ) {
        fail("unsafe_entrypoint", "unsafe plugin entrypoint: " + entrypoint);
    }
}

function permissionAllowed(
    requested: PluginPermissions,
    allowed: PluginPermissions,
): boolean {
    return (!requested.network || allowed.network === true) &&
        (!requested.subprocess || allowed.subprocess === true) &&
        FILESYSTEM_LEVEL[requested.filesystem ?? "none"] <=
            FILESYSTEM_LEVEL[allowed.filesystem ?? "none"];
}

function artifactInput(value: PluginArtifactInput): PluginArtifact {
    const manifest = validatePluginManifest(value.manifest);
    if (typeof value.entrypoint !== "string") {
        fail("invalid_artifact", "entrypoint must be a string");
    }
    safeEntrypoint(value.entrypoint);
    if (value.bytes !== undefined && !(value.bytes instanceof Uint8Array)) {
        fail("invalid_artifact", "bytes must be Uint8Array");
    }
    if (value.digest !== undefined && !validDigest(value.digest)) {
        fail("invalid_artifact", "digest must be a sha256 base64url value");
    }
    if (
        value.signature !== undefined &&
        !(value.signature instanceof Uint8Array)
    ) {
        fail("invalid_artifact", "signature must be Uint8Array");
    }
    if (
        value.signerKeyId !== undefined &&
        (value.signerKeyId.length === 0 || value.signerKeyId.length > 128)
    ) {
        fail("invalid_artifact", "invalid signer key id");
    }
    return { ...value, manifest };
}

function defaultPermissions(
    source: "builtin" | "third-party",
): PluginPermissions {
    return source === "builtin"
        ? { network: true, filesystem: "read-write", subprocess: true }
        : { network: false, filesystem: "none", subprocess: false };
}

function verifyTrust(
    manifestId: string,
    trust: string,
    source: "builtin" | "third-party",
    trustedIds: Set<string>,
): void {
    if (source === "builtin" && !trustedIds.has(manifestId)) {
        fail(
            "trust_violation",
            "built-in package is not allowlisted: " + manifestId,
        );
    }
    if (source === "third-party" && trustedIds.has(manifestId)) {
        fail(
            "trust_violation",
            "third-party package uses reserved id: " + manifestId,
        );
    }
    if (
        trust === "trusted" &&
        (source !== "builtin" || !trustedIds.has(manifestId))
    ) {
        fail(
            "trust_violation",
            "trusted plugin is not allowlisted: " + manifestId,
        );
    }
}

async function verifySignature(
    artifact: PluginArtifact,
    digest: string,
    policy: PluginSecurityPolicy,
): Promise<string> {
    if (artifact.signerKeyId === undefined) {
        fail(
            "invalid_signature",
            "signed artifact has no signer key id: " + artifact.manifest.id,
        );
    }
    const signer: TrustedPluginSigner | undefined = findTrustedSigner(
        policy,
        artifact.signerKeyId,
        artifact.manifest.id,
    );
    if (signer === undefined) {
        fail("untrusted_signer", "untrusted signer: " + artifact.signerKeyId);
    }
    if (
        artifact.signature === undefined || artifact.signature.byteLength !== 64
    ) {
        fail("invalid_signature", "Ed25519 signature must contain 64 bytes");
    }
    const key = await importEd25519PublicKey(signer.publicKey);
    const valid = await crypto.subtle.verify(
        "Ed25519",
        key,
        new Uint8Array(artifact.signature) as BufferSource,
        createPluginSignaturePayload(digest) as BufferSource,
    );
    if (!valid) {
        fail(
            "invalid_signature",
            "invalid package signature: " + artifact.manifest.id,
        );
    }
    return artifact.signerKeyId;
}

/** Verify a package artifact using only Web Crypto and host policy. */
export async function verifyPluginArtifact(
    input: PluginArtifactInput,
    policy: PluginSecurityPolicy = {},
): Promise<PluginVerification> {
    const artifact = artifactInput(input);
    const manifest = artifact.manifest;
    const source = policy.source ?? "third-party";
    const trustedIds = normalizePolicySet(
        policy.trustedPluginIds,
        policy.trustedBuiltinIds,
    );
    verifyTrust(manifest.id, manifest.trust, source, trustedIds);

    const requested = manifest.permissions ?? {
        network: false,
        filesystem: "none",
        subprocess: false,
    };
    if (
        !permissionAllowed(
            requested,
            policy.allowedPermissions ?? defaultPermissions(source),
        )
    ) {
        fail(
            "permission_denied",
            "plugin permissions exceed host policy: " + manifest.id,
        );
    }
    if (
        artifact.bytes !== undefined && policy.maxBytes !== undefined &&
        artifact.bytes.byteLength > policy.maxBytes
    ) {
        fail(
            "package_too_large",
            "plugin package exceeds " + policy.maxBytes + " bytes",
        );
    }

    const computedDigest = artifact.bytes === undefined
        ? undefined
        : await computePluginArtifactDigest(artifact.bytes);
    const artifactDigest = artifact.digest ?? computedDigest;
    const expectedDigest = trustedDigests(policy)?.[manifest.id];
    if (expectedDigest !== undefined && artifactDigest !== expectedDigest) {
        fail(
            "digest_mismatch",
            "digest does not match trusted package: " + manifest.id,
        );
    }
    if (
        artifact.digest !== undefined && computedDigest !== undefined &&
        artifact.digest !== computedDigest
    ) {
        fail(
            "digest_mismatch",
            "artifact bytes do not match digest: " + manifest.id,
        );
    }

    let status: "verified" | "unverified" = "verified";
    let signerKeyId: string | undefined;
    if (source === "third-party" && artifact.signature === undefined) {
        if (policy.allowUnsigned !== true) {
            fail(
                "unsigned_package",
                "third-party plugin must be signed: " + manifest.id,
            );
        }
        status = "unverified";
    }
    if (artifact.signature !== undefined) {
        if (artifactDigest === undefined) {
            fail(
                "missing_digest",
                "signed artifact has no digest: " + manifest.id,
            );
        }
        signerKeyId = await verifySignature(artifact, artifactDigest, policy);
    } else if (source === "builtin" && artifactDigest === undefined) {
        status = "unverified";
    }
    return Object.freeze({
        status,
        manifest,
        ...(artifactDigest === undefined ? {} : { digest: artifactDigest }),
        ...(signerKeyId === undefined ? {} : { signerKeyId }),
        ...(status === "unverified"
            ? { reason: "package has no trusted signature or byte digest" }
            : {}),
    });
}

/** Default verifier bound to an immutable policy. */
export class DefaultPluginVerifier implements PluginVerifier {
    constructor(readonly policy: PluginSecurityPolicy = {}) {}

    async verify(artifact: PluginArtifact): Promise<PluginVerification> {
        try {
            return await verifyPluginArtifact(artifact, this.policy);
        } catch (error) {
            if (error instanceof PluginVerificationError) {
                return Object.freeze({
                    status: "rejected",
                    manifest: artifact.manifest,
                    reason: String(error.code) + ": " + error.message,
                });
            }
            throw error;
        }
    }
}
