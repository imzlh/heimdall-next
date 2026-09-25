/**
 * Host-side plugin lifecycle and isolation ports.
 *
 * Verification and execution are intentionally separate. A host can verify a
 * package and persist its snapshot without importing or evaluating it, then
 * choose an in-process or isolated runtime according to trust policy.
 */

import type {
    JsonValue,
    PluginManifest,
    PluginPermissions,
} from "../contracts/mod.ts";

export interface PluginArtifact {
    readonly manifest: PluginManifest;
    readonly entrypoint: string;
    readonly bytes?: Uint8Array;
    readonly digest?: string;
    readonly signature?: Uint8Array;
    readonly signerKeyId?: string;
}

/** Input accepted by the default verifier before manifest normalization. */
export interface PluginArtifactInput extends Omit<PluginArtifact, "manifest"> {
    readonly manifest: unknown;
}

export type PluginVerificationStatus =
    | "verified"
    | "unverified"
    | "rejected";

export interface PluginVerification {
    readonly status: PluginVerificationStatus;
    /** Normalized manifest returned by a verifier that performs validation. */
    readonly manifest?: PluginManifest;
    readonly digest?: string;
    readonly signerKeyId?: string;
    readonly reason?: string;
}

export interface PluginVerifier {
    verify(artifact: PluginArtifact): Promise<PluginVerification>;
}

/** Public-key identity trusted to sign third-party plugin artifacts. */
export interface TrustedPluginSigner {
    readonly keyId: string;
    readonly publicKey: CryptoKey | Uint8Array | string;
    readonly pluginIds?: readonly string[];
}

/** Host policy applied before a package is persisted or activated. */
export interface PluginSecurityPolicy {
    /** Defaults to third-party, which requires isolated execution. */
    readonly source?: "builtin" | "third-party";
    /** IDs allowed to use trusted in-process execution. */
    readonly trustedPluginIds?: Iterable<string>;
    /** Backwards-compatible name used by host composition code. */
    readonly trustedBuiltinIds?: Iterable<string>;
    /** Expected digests for built-in packages. */
    readonly trustedPluginDigests?: Readonly<Record<string, string>>;
    readonly trustedBuiltinDigests?: Readonly<Record<string, string>>;
    readonly trustedSigners?: readonly TrustedPluginSigner[];
    /** Alias accepted by callers migrating from the legacy host. */
    readonly trustedPublishers?: readonly TrustedPluginSigner[];
    /** Permit unsigned third-party packages to be installed as unverified. */
    readonly allowUnsigned?: boolean;
    /** Host-level permission ceiling. Omitted means built-ins are unrestricted
     * and third-party packages are denied network/filesystem/subprocess access. */
    readonly allowedPermissions?: PluginPermissions;
    readonly maxBytes?: number;
}

export interface PluginInvocation {
    readonly method: string;
    readonly payload?: JsonValue;
    /** Cancels admission and the caller's wait even if a runtime ignores abort.
     * Use AbortSignal.timeout() (or a combined signal) for a caller deadline. */
    readonly signal?: AbortSignal;
}

export interface PluginRuntime {
    start(artifact: PluginArtifact): Promise<void>;
    invoke(invocation: PluginInvocation): Promise<JsonValue | undefined>;
    /** Release all resources, including active invocations. Must allow retry
     * after a partial failure; rejection prevents a replacement from starting.
     * The host can cancel waits but cannot forcibly terminate in-process code. */
    stop(): Promise<void>;
}

export interface PluginRecord {
    readonly manifest: PluginManifest;
    readonly digest?: string;
    readonly signerKeyId?: string;
    readonly enabled: boolean;
    readonly isolated: boolean;
    readonly updatedAt: string;
    readonly lastError?: string;
}

/** Runtime-neutral persistence port for installed plugin metadata. */
export interface PluginRecordStore {
    get(id: string): Promise<PluginRecord | undefined>;
    put(record: PluginRecord): Promise<void>;
    delete(id: string): Promise<void>;
    list(): Promise<readonly PluginRecord[]>;
}

export interface PluginHostOptions {
    readonly verifier?: PluginVerifier;
    readonly policy?: PluginSecurityPolicy;
    readonly store?: PluginRecordStore;
    readonly runtimeFactory?: (
        artifact: PluginArtifact,
    ) => PluginRuntime | Promise<PluginRuntime>;
    readonly now?: () => string;
    /** Require a runtime factory before enabling any plugin. */
    readonly requireRuntimeOnEnable?: boolean;
}

export interface PluginHost {
    install(artifact: PluginArtifact): Promise<PluginRecord>;
    enable(id: string): Promise<PluginRecord>;
    disable(id: string): Promise<PluginRecord>;
    uninstall(id: string): Promise<boolean>;
    get(id: string): Promise<PluginRecord | undefined>;
    list(): Promise<readonly PluginRecord[]>;
    /** Invoke only an enabled plugin through its host-managed runtime.
     * Successful durable disable/uninstall cancels active invocation waits. */
    invoke(
        id: string,
        invocation: PluginInvocation,
    ): Promise<JsonValue | undefined>;
}

export class PluginVerificationError extends Error {
    override readonly name = "PluginVerificationError";

    constructor(
        public readonly code: string = "verification_failed",
        message = code,
    ) {
        super(message);
    }
}

export type PluginLifecycleErrorCode =
    | "already_installed"
    | "not_installed"
    | "already_enabled"
    | "already_disabled"
    | "runtime_required"
    | "runtime_failed"
    | "policy_denied";

export class PluginLifecycleError extends Error {
    override readonly name = "PluginLifecycleError";

    constructor(
        public readonly code: PluginLifecycleErrorCode,
        message: string,
        options?: { readonly cause?: unknown },
    ) {
        super(message, options);
    }
}

export {
    computePluginArtifactDigest,
    createPluginSignaturePayload,
    DefaultPluginVerifier,
    encodeBase64Url,
    validatePluginManifest,
    verifyPluginArtifact,
} from "./verification.ts";
export {
    createPluginHost,
    InMemoryPluginHost,
    InMemoryPluginRecordStore,
} from "./runtime.ts";
