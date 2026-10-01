import type {
    InferenceSource,
    PluginManifest,
    SourceCapability,
    SourceFactoryOptions,
} from "@heimdall/contracts";
import manifest from "./manifest.json" with { type: "json" };
import type { FetchLike } from "./types.ts";

export interface OpenAICompatibleSourceConfig {
    /** Stable source id used by the kernel and persisted configuration. */
    readonly id?: string;
    /** Origin or path prefix, for example `https://api.openai.com/v1`. */
    readonly baseUrl: string;
    readonly apiKey?: string;
    /** Defaults to `/chat/completions`; must be an absolute path. */
    readonly endpoint?: string;
    /** Additional non-secret headers sent to the upstream. */
    readonly headers?: Readonly<Record<string, string>>;
    /**
     * Which upstream operations this source advertises.
     * Defaults to `full` when omitted.
     */
    readonly compat?: "full" | "chat" | "embeddings" | "images";
}

export interface OpenAICompatibleSourceOptions
    extends SourceFactoryOptions<OpenAICompatibleSourceConfig> {
    readonly fetch?: FetchLike;
    readonly now?: () => Date;
    readonly streamId?: (requestId: string) => string;
}

// JSON field unions include optional undefined at type level; the host validates metadata.
export const sourceManifest = manifest as unknown as PluginManifest;
export const DEFAULT_SOURCE_ID = "openai-compatible";
export const DEFAULT_ENDPOINT = "/chat/completions";

const SOURCE_COMPAT = ["full", "chat", "embeddings", "images"] as const;

const COMPAT_OPERATIONS: Record<
    (typeof SOURCE_COMPAT)[number],
    readonly string[]
> = {
    full: [
        "generation.create",
        "completion.create",
        "embedding.create",
        "image.generate",
        "image.edit",
    ],
    chat: ["generation.create", "completion.create"],
    embeddings: ["embedding.create"],
    images: ["image.generate", "image.edit"],
};

/** Fields that may cross the HIP escape hatch without becoming arbitrary HTTP. */
export const SAFE_FORWARD_FIELDS = new Set([
    "stream_options",
    "user",
    "logprobs",
    "top_logprobs",
    "parallel_tool_calls",
    "service_tier",
    "reasoning_effort",
]);

/** Headers that are owned by the transport or must never be user supplied. */
const FORBIDDEN_HEADERS = new Set([
    "accept",
    "authorization",
    "connection",
    "content-length",
    "content-type",
    "cookie",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "set-cookie",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);

export function validateOpenAICompatibleSourceConfig(
    value: OpenAICompatibleSourceConfig,
): OpenAICompatibleSourceConfig {
    if (!isRecord(value)) {
        throw new TypeError("source config must be an object");
    }
    const baseUrl = normalizeBaseUrl(value.baseUrl);
    const id = value.id === undefined
        ? DEFAULT_SOURCE_ID
        : nonEmpty(value.id, "id");
    const apiKey = value.apiKey === undefined
        ? undefined
        : nonEmpty(value.apiKey, "apiKey");
    const endpoint = value.endpoint === undefined
        ? DEFAULT_ENDPOINT
        : normalizeEndpoint(value.endpoint);

    if (Object.hasOwn(value, "modelMap")) {
        throw new TypeError("modelMap belongs to host source settings");
    }

    const headers: Record<string, string> = {};
    if (value.headers !== undefined) {
        if (!isPlainRecord(value.headers)) {
            throw new TypeError("headers must be an object");
        }
        const names = new Set<string>();
        for (const [name, headerValue] of Object.entries(value.headers)) {
            rejectReservedKey(name, "header name");
            if (!name.trim() || typeof headerValue !== "string") {
                throw new TypeError("headers must contain string values");
            }
            const lower = name.toLowerCase();
            if (names.has(lower)) {
                throw new TypeError(`duplicate header name: ${name}`);
            }
            names.add(lower);
            if (FORBIDDEN_HEADERS.has(lower) || isSensitiveHeaderName(lower)) {
                throw new TypeError(`header ${name} cannot be configured`);
            }
            try {
                const parsed = new Headers([[name, headerValue]]);
                headers[name] = parsed.get(name) ?? "";
            } catch {
                throw new TypeError(`header ${name} is invalid`);
            }
        }
    }

    const compat = sourceCompat((value as { compat?: unknown }).compat);

    return {
        id,
        baseUrl,
        ...(apiKey === undefined ? {} : { apiKey }),
        endpoint,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        compat,
    };
}

export function advertisedCapabilities(
    config: OpenAICompatibleSourceConfig,
): readonly SourceCapability[] {
    const profile = config.compat ?? "full";
    const allowed = COMPAT_OPERATIONS[profile];
    if (allowed === undefined || allowed.length === 0) {
        throw new TypeError("compat profile must advertise a capability");
    }
    const capabilities: SourceCapability[] = [
        {
            operation: "generation.create",
            streaming: true,
            features: ["tools", "structured_output", "image.input"],
        },
        { operation: "completion.create", streaming: true },
        { operation: "embedding.create", streaming: false },
        { operation: "image.generate", streaming: false },
        { operation: "image.edit", streaming: false },
    ];
    return capabilities.filter((capability) =>
        allowed.includes(capability.operation)
    );
}

export function upstreamUrl(config: OpenAICompatibleSourceConfig): string {
    return `${config.baseUrl}${config.endpoint ?? DEFAULT_ENDPOINT}`;
}

export function upstreamHeaders(
    config: OpenAICompatibleSourceConfig,
    stream: boolean,
): Headers {
    const headers = new Headers(config.headers);
    headers.set("content-type", "application/json");
    headers.set("accept", stream ? "text/event-stream" : "application/json");
    if (config.apiKey !== undefined) {
        headers.set("authorization", `Bearer ${config.apiKey}`);
    }
    return headers;
}

function normalizeBaseUrl(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError("baseUrl is required");
    }
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new TypeError("baseUrl must be a valid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new TypeError("baseUrl must use http or https");
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new TypeError(
            "baseUrl cannot contain credentials, query, or fragment",
        );
    }
    if (hasUnsafeEncodedPath(url.pathname)) {
        throw new TypeError("baseUrl cannot contain encoded path traversal");
    }
    while (url.pathname.length > 1 && url.pathname.endsWith("/")) {
        url.pathname = url.pathname.slice(0, -1);
    }
    const normalized = url.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function normalizeEndpoint(value: unknown): string {
    if (
        typeof value !== "string" || !value.startsWith("/") ||
        value.includes("?") || value.includes("#") ||
        value.includes("\\") || hasControlCharacter(value) ||
        hasUnsafeEncodedPath(value)
    ) {
        throw new TypeError(
            "endpoint must be an absolute path without query or fragment",
        );
    }
    const segments = value.split("/").filter((segment) => segment.length > 0);
    if (segments.some((segment) => segment === "." || segment === "..")) {
        throw new TypeError("endpoint cannot contain path traversal segments");
    }
    return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function sourceCompat(
    value: unknown,
): (typeof SOURCE_COMPAT)[number] {
    if (value === undefined) return "full";
    if (
        typeof value === "string" &&
        (SOURCE_COMPAT as readonly string[]).includes(value)
    ) {
        return value as (typeof SOURCE_COMPAT)[number];
    }
    throw new TypeError(
        "compat must be full, chat, embeddings, or images",
    );
}

function nonEmpty(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(`${field} must be a non-empty string`);
    }
    return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return isRecord(value) &&
        (Object.getPrototypeOf(value) === Object.prototype ||
            Object.getPrototypeOf(value) === null);
}

function rejectReservedKey(value: string, field: string): void {
    if (
        value === "__proto__" || value === "constructor" ||
        value === "prototype"
    ) {
        throw new TypeError(`${field} uses a reserved key`);
    }
}

function isSensitiveHeaderName(value: string): boolean {
    return value.includes("token") || value.includes("secret") ||
        value.includes("password") || value.includes("credential") ||
        value.includes("api-key") || value.includes("api_key") ||
        value.includes("apikey");
}

function hasControlCharacter(value: string): boolean {
    for (const character of value) {
        const code = character.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
}

function hasUnsafeEncodedPath(value: string): boolean {
    const lower = value.toLowerCase();
    return lower.includes("%2e") || lower.includes("%2f") ||
        lower.includes("%5c");
}

export type OpenAICompatibleSource = InferenceSource & {
    readonly config: OpenAICompatibleSourceConfig;
};
