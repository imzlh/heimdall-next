import { PluginVerificationError } from "./mod.ts";

export type PluginVerificationErrorCode =
    | "invalid_manifest"
    | "invalid_permissions"
    | "invalid_artifact"
    | "unsafe_entrypoint"
    | "package_too_large"
    | "trust_violation"
    | "permission_denied"
    | "unsigned_package"
    | "invalid_signature"
    | "untrusted_signer"
    | "digest_mismatch"
    | "missing_digest";

export function fail(
    code: PluginVerificationErrorCode,
    message: string,
): never {
    throw new PluginVerificationError(code, message);
}

export function record(
    value: unknown,
    label: string,
    code: PluginVerificationErrorCode,
): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(code, `${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

export function stringValue(
    value: unknown,
    label: string,
    code: PluginVerificationErrorCode,
): string {
    if (typeof value !== "string") fail(code, `${label} must be a string`);
    return value;
}

export function rejectUnknown(
    value: Record<string, unknown>,
    allowed: ReadonlySet<string>,
    label: string,
    code: PluginVerificationErrorCode,
): void {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            fail(code, `${label} contains unknown field: ${key}`);
        }
    }
}
