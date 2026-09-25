import type { PluginRoute } from "@heimdall/contracts";

/** Public wire-level contract for the built-in OpenAI protocol adapter. */
export const OPENAI_CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
export const OPENAI_RESPONSES_PATH = "/v1/responses";
export const OPENAI_COMPLETIONS_PATH = "/v1/completions";
export const OPENAI_EMBEDDINGS_PATH = "/v1/embeddings";
export const OPENAI_IMAGE_GENERATIONS_PATH = "/v1/images/generations";
export const OPENAI_IMAGE_EDITS_PATH = "/v1/images/edits";

export type OpenAIDialect =
    | "chat.completions"
    | "responses"
    | "completions"
    | "embeddings"
    | "images.generations"
    | "images.edits";

const DIALECTS = new Set<OpenAIDialect>([
    "chat.completions",
    "responses",
    "completions",
    "embeddings",
    "images.generations",
    "images.edits",
]);

/** Select the wire codec from manifest metadata, after Hono has routed. */
export function dialectForRoute(
    route: Pick<PluginRoute, "variant">,
): OpenAIDialect {
    const variant = route.variant;
    if (variant !== undefined && DIALECTS.has(variant as OpenAIDialect)) {
        return variant as OpenAIDialect;
    }
    return "chat.completions";
}

export function isGenerationDialect(dialect: OpenAIDialect): boolean {
    return dialect === "chat.completions" || dialect === "responses";
}
