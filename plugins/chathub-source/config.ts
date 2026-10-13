import type { PluginManifest, SourceFactoryOptions } from "@heimdall/contracts";
import type { ChatHubClientOptions } from "./protocol/mod.ts";
import manifest from "./manifest.json" with { type: "json" };

export const sourceManifest = manifest as unknown as PluginManifest;
export const DEFAULT_MODELS = [
    "gpt-5.6-sol",
    "auto",
];
export const DEFAULT_ENDPOINT =
    "wss://substrate.office.com/m365Copilot/Chathub";

export interface ChatHubSourceConfig {
    readonly id: string;
    readonly oid: string;
    readonly tid: string;
    readonly accessToken: string;
    readonly refreshToken?: string;
    readonly accountEmail?: string;
    readonly expiresAt?: string;
    readonly models: readonly string[];
    readonly endpoint: string;
    readonly licenseType?: string;
    readonly scenario?: string;
    readonly locale?: string;
    readonly timezone?: string;
    readonly softThinking?: "auto" | "off";
}

export interface ChatHubSourceOptions
    extends SourceFactoryOptions<ChatHubSourceConfig>, ChatHubClientOptions {
    /** Optional caller-owned fetch implementation for token requests. */
    readonly fetch?: typeof fetch;
    readonly refresh?: typeof import("./auth.ts").refreshAccessToken;
}

export function validateChatHubSourceConfig(
    input: unknown,
): ChatHubSourceConfig {
    if (!isRecord(input)) {
        throw new TypeError("ChatHub config must be an object");
    }
    const text = (key: string, fallback?: string): string => {
        const value = input[key] ?? fallback;
        if (
            typeof value !== "string" || !value.trim() || value.length > 65_536
        ) {
            throw new TypeError(
                "ChatHub " + key + " is required and must be a string",
            );
        }
        return value.trim();
    };
    const endpoint = new URL(text("endpoint", DEFAULT_ENDPOINT));
    if (
        !["wss:", "ws:"].includes(endpoint.protocol) || endpoint.username ||
        endpoint.password || endpoint.search || endpoint.hash ||
        (endpoint.protocol === "ws:" &&
            !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
    ) {
        throw new TypeError(
            "ChatHub endpoint must use wss (ws is allowed only on loopback), without credentials or query parameters",
        );
    }
    const raw = input.models ?? DEFAULT_MODELS;
    const models = typeof raw === "string"
        ? raw.split(/[\s,]+/).filter(Boolean)
        : raw;
    if (
        !Array.isArray(models) || !models.length || models.length > 100 ||
        models.some((model) =>
            typeof model !== "string" || !model.trim() || model.length > 256
        )
    ) {
        throw new TypeError(
            "ChatHub models must contain between 1 and 100 model IDs",
        );
    }
    const optional: Record<string, string> = {};
    for (
        const key of [
            "refreshToken",
            "accountEmail",
            "expiresAt",
            "licenseType",
            "scenario",
            "locale",
            "timezone",
        ]
    ) {
        if (input[key] !== undefined && input[key] !== "") {
            optional[key] = text(key);
        }
    }
    if (optional.refreshToken?.startsWith("enc:v1:")) {
        throw new TypeError(
            "Encrypted refresh tokens cannot be imported; sign in again or omit refreshToken",
        );
    }
    if (
        optional.expiresAt && !Number.isFinite(Date.parse(optional.expiresAt))
    ) {
        throw new TypeError("ChatHub expiresAt must be an ISO date");
    }
    const softThinking = input.softThinking === undefined
        ? undefined
        : text("softThinking").toLowerCase();
    if (
        softThinking !== undefined && softThinking !== "auto" &&
        softThinking !== "off"
    ) {
        throw new TypeError("ChatHub softThinking must be auto or off");
    }
    return {
        id: text("id", "chathub"),
        oid: text("oid"),
        tid: text("tid"),
        accessToken: text("accessToken"),
        endpoint: endpoint.href,
        models: [...new Set(models.map((model: string) => model.trim()))],
        ...optional,
        ...(softThinking === undefined ? {} : { softThinking }),
    };
}

export function redactChatHubSourceConfig(
    config: ChatHubSourceConfig,
): unknown {
    const { accessToken, refreshToken, ...safe } = config;
    return {
        ...safe,
        models: safe.models.join(","),
        accessTokenConfigured: Boolean(accessToken),
        refreshTokenConfigured: Boolean(refreshToken),
    };
}

export function mergeChatHubSourceConfig(
    input: unknown,
    previous?: ChatHubSourceConfig,
): unknown {
    if (!isRecord(input) || !previous) return input;
    const result = { ...input };
    for (const key of ["accessToken", "refreshToken"] as const) {
        if (result[key] === undefined || result[key] === "") {
            result[key] = previous[key];
        }
    }
    return result;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
