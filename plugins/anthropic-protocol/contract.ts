import type { PluginManifest } from "@heimdall/contracts";
import manifestJson from "./manifest.json" with { type: "json" };

/** Public wire contract for the built-in Anthropic Messages adapter. */
export const ANTHROPIC_MESSAGES_PATH = "/v1/messages";

export const ANTHROPIC_MANIFEST = manifestJson as PluginManifest;

/** Fields with a first-class HIP representation or an explicit raw policy. */
export const ANTHROPIC_REQUEST_FIELDS: ReadonlySet<string> = new Set([
    "model",
    "messages",
    "system",
    "max_tokens",
    "stream",
    "temperature",
    "top_p",
    "top_k",
    "stop_sequences",
    "tools",
    "tool_choice",
    "metadata",
    "service_tier",
    "thinking",
    "container",
    "mcp_servers",
    "betas",
]);

/** Anthropic controls retained in OperationRequest.extensions.raw. */
export const ANTHROPIC_PRESERVED_FIELDS = [
    "stop_sequences",
    "service_tier",
    "thinking",
    "container",
    "mcp_servers",
    "betas",
] as const;
