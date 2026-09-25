/** Runtime schema and normalization for the NewAPI preset. */

export const NEW_API_SOURCE_PLUGIN_ID = "heimdall.source.openai-compatible";
export const DEFAULT_SOURCE_ID = "newapi";
export const DEFAULT_ENDPOINT = "/chat/completions";

/**
 * Input accepted by the preset. `baseUrl` is the only required field. The
 * runtime validator below still accepts `unknown` because values usually come
 * from an admin request or a persisted JSON document.
 */
export interface NewApiPresetConfig {
    readonly id?: string;
    readonly baseUrl: string;
    /** Secret; never returned by the redaction functions. */
    readonly apiKey?: string;
    /** Client model name -> upstream model name. */
    readonly modelMap?: Readonly<Record<string, string>>;
    /** Absolute path below `baseUrl`. */
    readonly endpoint?: string;
    /** Additional non-secret headers. */
    readonly headers?: Readonly<Record<string, string>>;
}

/** Compatibility spelling for callers that capitalize API. */
export type NewAPIPresetConfig = NewApiPresetConfig;

/** Shape emitted for the OpenAI-compatible source plugin. */
export interface OpenAICompatibleSourceConfig {
    readonly id: string;
    readonly baseUrl: string;
    readonly apiKey?: string;
    readonly modelMap?: Readonly<Record<string, string>>;
    readonly endpoint: string;
    readonly headers?: Readonly<Record<string, string>>;
}

/**
 * A JSON-schema description for hosts that render a preset form. Runtime
 * validation remains authoritative; this schema deliberately marks apiKey as
 * write-only so generic admin UIs do not accidentally display it.
 */
export const newApiPresetSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["baseUrl"],
    properties: {
        id: {
            type: "string",
            minLength: 1,
            default: DEFAULT_SOURCE_ID,
        },
        baseUrl: {
            type: "string",
            minLength: 1,
            format: "uri",
        },
        apiKey: {
            type: "string",
            minLength: 1,
            writeOnly: true,
            "x-sensitive": true,
        },
        endpoint: {
            type: "string",
            minLength: 1,
            default: DEFAULT_ENDPOINT,
        },
        modelMap: {
            type: "object",
            additionalProperties: {
                type: "string",
                minLength: 1,
            },
        },
        headers: {
            type: "object",
            additionalProperties: {
                type: "string",
            },
        },
    },
} as const;

/** Uppercase alias used by hosts that conventionally export schemas this way. */
export const NEW_API_PRESET_SCHEMA = newApiPresetSchema;

const ALLOWED_FIELDS = new Set([
    "id",
    "baseUrl",
    "apiKey",
    "modelMap",
    "endpoint",
    "headers",
]);

/** Headers controlled by the source transport or carrying credentials. */
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

/**
 * Validate and normalize a preset document. This function intentionally does
 * not perform I/O or resolve secrets from the environment.
 */
export function validateNewApiPresetConfig(
    value: unknown,
): NewApiPresetConfig {
    const record = asPlainRecord(value, "NewAPI preset config");
    for (const key of Object.keys(record)) {
        if (!ALLOWED_FIELDS.has(key)) {
            throw new TypeError(`unknown NewAPI preset field: ${key}`);
        }
    }

    const baseUrl = normalizeBaseUrl(record.baseUrl);
    const id = record.id === undefined
        ? DEFAULT_SOURCE_ID
        : nonEmptyString(record.id, "id");
    const apiKey = record.apiKey === undefined
        ? undefined
        : nonEmptyString(record.apiKey, "apiKey");
    const endpoint = record.endpoint === undefined
        ? DEFAULT_ENDPOINT
        : normalizeEndpoint(record.endpoint);
    const modelMap = normalizeModelMap(record.modelMap);
    const headers = normalizeHeaders(record.headers);

    return {
        id,
        baseUrl,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(modelMap === undefined ? {} : { modelMap }),
        endpoint,
        ...(headers === undefined ? {} : { headers }),
    };
}

export function isSensitiveHeaderName(name: string): boolean {
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower)) return true;
    // Provider credential headers are not a safe escape hatch for a preset.
    return lower.includes("token") || lower.includes("secret") ||
        lower.includes("password") || lower.includes("credential") ||
        lower.includes("api-key") || lower.includes("api_key") ||
        lower.includes("apikey");
}

function normalizeBaseUrl(value: unknown): string {
    const input = nonEmptyString(value, "baseUrl");
    let url: URL;
    try {
        url = new URL(input);
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
    while (url.pathname.length > 1 && url.pathname.endsWith("/")) {
        url.pathname = url.pathname.slice(0, -1);
    }
    const normalized = url.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function normalizeEndpoint(value: unknown): string {
    const input = nonEmptyString(value, "endpoint");
    if (
        !input.startsWith("/") || input.includes("?") || input.includes("#") ||
        input.includes("\\") || hasControlCharacter(input)
    ) {
        throw new TypeError(
            "endpoint must be an absolute path without query or fragment",
        );
    }
    const segments = input.split("/").filter((segment) => segment.length > 0);
    if (
        segments.some((segment) => segment === "." || segment === "..") ||
        segments.some((segment) => segment.toLowerCase().includes("%2e"))
    ) {
        throw new TypeError("endpoint cannot contain path traversal segments");
    }
    return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function normalizeModelMap(
    value: unknown,
): Readonly<Record<string, string>> | undefined {
    if (value === undefined) return undefined;
    const record = asPlainRecord(value, "modelMap");
    const entries: [string, string][] = [];
    for (const [rawKey, rawValue] of Object.entries(record)) {
        const key = nonEmptyString(rawKey, "modelMap key");
        rejectPrototypeKey(key, "modelMap key");
        entries.push([key, nonEmptyString(rawValue, `modelMap.${key}`)]);
    }
    if (entries.length === 0) return undefined;
    entries.sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries);
}

function normalizeHeaders(
    value: unknown,
): Readonly<Record<string, string>> | undefined {
    if (value === undefined) return undefined;
    const record = asPlainRecord(value, "headers");
    const entries: [string, string][] = [];
    const names = new Set<string>();
    for (const [rawName, rawValue] of Object.entries(record)) {
        const name = nonEmptyString(rawName, "header name");
        const lower = name.toLowerCase();
        if (names.has(lower)) {
            throw new TypeError(`duplicate header name: ${name}`);
        }
        names.add(lower);
        if (isSensitiveHeaderName(name)) {
            throw new TypeError(
                `header ${name} cannot be configured by a preset`,
            );
        }
        if (typeof rawValue !== "string") {
            throw new TypeError(`header ${name} must be a string`);
        }
        // Let the platform validate header-name/value syntax and reject CRLF.
        try {
            const parsed = new Headers([[name, rawValue]]);
            const canonicalValue = parsed.get(name);
            entries.push([name, canonicalValue ?? ""]);
        } catch {
            throw new TypeError(`header ${name} is invalid`);
        }
        rejectPrototypeKey(name, "header name");
    }
    if (entries.length === 0) return undefined;
    entries.sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries);
}

function nonEmptyString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(`${field} must be a non-empty string`);
    }
    return value.trim();
}

function hasControlCharacter(value: string): boolean {
    for (const character of value) {
        const code = character.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
}

function rejectPrototypeKey(value: string, field: string): void {
    if (
        value === "__proto__" || value === "constructor" ||
        value === "prototype"
    ) {
        throw new TypeError(`${field} uses a reserved key`);
    }
}

function asPlainRecord(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`${field} must be an object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${field} must be a plain object`);
    }
    return value as Record<string, unknown>;
}
