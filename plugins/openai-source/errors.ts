import type { CanonicalError, JsonValue } from "@heimdall/contracts";
import { isJsonValue, isRecord, type WireObject } from "./types.ts";

/** Provider and transport failures normalized to the HIP error envelope. */
export class OpenAIUpstreamError extends Error {
    override readonly name = "OpenAIUpstreamError";

    constructor(readonly error: CanonicalError) {
        super(error.message);
    }
}

export function invalidUpstreamResponse(message: string): OpenAIUpstreamError {
    return new OpenAIUpstreamError({
        code: "upstream_invalid_response",
        message,
        retryable: false,
        status: 502,
    });
}

export function transportError(error: unknown): CanonicalError {
    return {
        code: "upstream_unreachable",
        message: errorMessage(error),
        retryable: true,
        status: 502,
    };
}

export function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

export function errorMessage(error: unknown): string {
    return error instanceof Error && error.message
        ? error.message
        : String(error);
}

export async function parseJsonResponse(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch (error) {
        throw invalidUpstreamResponse(
            `upstream returned invalid JSON: ${errorMessage(error)}`,
        );
    }
}

/** Preserve useful provider diagnostics while filtering credential-like fields. */
export async function responseError(
    response: Response,
): Promise<CanonicalError> {
    let body: unknown;
    try {
        const text = await response.text();
        try {
            body = JSON.parse(text);
        } catch {
            body = text.trim().length > 0
                ? { message: text.trim() }
                : undefined;
        }
    } catch {
        body = undefined;
    }
    const error = isRecord(body) && isRecord(body.error)
        ? body.error
        : isRecord(body)
        ? body
        : undefined;
    const providerCode = error && typeof error.code === "string"
        ? error.code
        : undefined;
    const message = error && typeof error.message === "string"
        ? error.message
        : `upstream returned HTTP ${response.status}`;
    return {
        code: providerCode ?? `upstream_http_${response.status}`,
        message,
        providerCode,
        status: response.status,
        retryable: isRetryableStatus(response.status),
        ...(error === undefined ? {} : { details: safeJson(error) }),
    };
}

export function canonicalUpstreamError(value: WireObject): CanonicalError {
    const status = typeof value.status === "number" &&
            Number.isSafeInteger(value.status)
        ? value.status
        : undefined;
    const code = typeof value.code === "string" ? value.code : "upstream_error";
    return {
        code,
        message: typeof value.message === "string"
            ? value.message
            : "upstream returned an error",
        providerCode: code,
        ...(status === undefined ? {} : { status }),
        retryable: status !== undefined && isRetryableStatus(status),
    };
}

export function isRetryableStatus(status: number): boolean {
    return status === 408 || status === 409 || status === 425 ||
        status === 429 ||
        status >= 500;
}

export function safeJson(value: unknown): JsonValue {
    if (!isRecord(value)) return String(value);
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
        const lower = key.toLowerCase();
        if (
            lower.includes("key") || lower.includes("token") ||
            lower.includes("secret")
        ) {
            continue;
        }
        if (isJsonValue(item)) result[key] = item;
    }
    return result;
}
