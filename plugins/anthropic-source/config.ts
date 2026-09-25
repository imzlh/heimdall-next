import type {
    InferenceSource,
    PluginManifest,
    SourceCapability,
} from "@heimdall/contracts";
import manifest from "./manifest.json" with { type: "json" };
import type { FetchLike } from "./types.ts";

export interface AnthropicSourceConfig {
    /** Stable source id used by the kernel and persisted configuration. */
    readonly id?: string;
    /** Origin or path prefix; defaults to `https://api.anthropic.com`. */
    readonly baseUrl?: string;
    readonly apiKey?: string;
    /** Client model name -> upstream model name. */
    readonly modelMap?: Readonly<Record<string, string>>;
    /** Defaults to `/v1/messages`; must be an absolute path. */
    readonly endpoint?: string;
    /** Additional non-secret headers sent to the upstream. */
    readonly headers?: Readonly<Record<string, string>>;
    /** Value of the required `anthropic-version` header. */
    readonly anthropicVersion?: string;
}

export interface AnthropicSourceOptions {
    readonly fetch?: FetchLike;
    readonly now?: () => Date;
    readonly streamId?: (requestId: string) => string;
}

export const sourceManifest = manifest as unknown as PluginManifest;
export const DEFAULT_SOURCE_ID = "anthropic";
export const DEFAULT_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_ENDPOINT = "/v1/messages";
export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

/** Anthropic-native top-level fields that may cross the HIP escape hatch. */
export const SAFE_FORWARD_FIELDS = new Set([
    "thinking",
    "service_tier",
]);

/** Headers that are owned by the transport or must never be user supplied. */
const FORBIDDEN_HEADERS = new Set([
    "accept",
    "anthropic-version",
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
    "x-api-key",
]);

export function validateAnthropicSourceConfig(
    value: AnthropicSourceConfig,
): AnthropicSourceConfig {
    if (!isRecord(value)) {
        throw new TypeError("source config must be an object");
    }
    const rawBaseUrl = value.baseUrl;
    const baseUrl = typeof rawBaseUrl !== "string" || rawBaseUrl.trim() === ""
        ? DEFAULT_BASE_URL
        : normalizeBaseUrl(rawBaseUrl);
    const id = value.id === undefined
        ? DEFAULT_SOURCE_ID
        : nonEmpty(value.id, "id");
    const apiKey = value.apiKey === undefined
        ? undefined
        : nonEmpty(value.apiKey, "apiKey");
    const endpoint = value.endpoint === undefined
        ? DEFAULT_ENDPOINT
        : normalizeEndpoint(value.endpoint);
    const anthropicVersion = value.anthropicVersion === undefined
        ? DEFAULT_ANTHROPIC_VERSION
        : normalizeVersion(value.anthropicVersion);

    const modelMap: Record<string, string> = {};
    if (value.modelMap !== undefined) {
        if (!isPlainRecord(value.modelMap)) {
            throw new TypeError("modelMap must be an object");
        }
        for (
            const [clientModel, upstreamModel] of Object.entries(value.modelMap)
        ) {
            rejectReservedKey(clientModel, "modelMap key");
            modelMap[nonEmpty(clientModel, "modelMap key")] = nonEmpty(
                upstreamModel,
                `modelMap.${clientModel}`,
            );
        }
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

    return {
        id,
        baseUrl,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(Object.keys(modelMap).length === 0 ? {} : { modelMap }),
        endpoint,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        anthropicVersion,
    };
}

export function advertisedCapabilities(
    config: AnthropicSourceConfig,
): readonly SourceCapability[] {
    const models = Object.keys(config.modelMap ?? {}).sort();
    const shared = models.length === 0 ? {} : { models };
    return [
        {
            operation: "generation.create",
            ...shared,
            streaming: true,
            features: ["tools", "structured_output", "image.input"],
        },
    ];
}

export function upstreamModel(
    config: AnthropicSourceConfig,
    clientModel: string | undefined,
): string {
    return config.modelMap?.[clientModel ?? ""] ?? clientModel ?? "";
}

export function upstreamUrl(config: AnthropicSourceConfig): string {
    return `${config.baseUrl ?? DEFAULT_BASE_URL}${
        config.endpoint ?? DEFAULT_ENDPOINT
    }`;
}

export function upstreamHeaders(
    config: AnthropicSourceConfig,
    stream: boolean,
): Headers {
    const headers = new Headers(config.headers);
    headers.set("content-type", "application/json");
    headers.set("accept", stream ? "text/event-stream" : "application/json");
    headers.set(
        "anthropic-version",
        config.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
    );
    if (config.apiKey !== undefined) {
        headers.set("x-api-key", config.apiKey);
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

function normalizeVersion(value: unknown): string {
    const version = nonEmpty(value, "anthropicVersion");
    if (hasControlCharacter(version)) {
        throw new TypeError(
            "anthropicVersion cannot contain control characters",
        );
    }
    return version;
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

export type AnthropicSource = InferenceSource & {
    readonly config: AnthropicSourceConfig;
};
