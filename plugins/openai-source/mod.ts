/** OpenAI-compatible upstream source plugin public entry point. */
export {
    DEFAULT_ENDPOINT,
    DEFAULT_SOURCE_ID,
    type OpenAICompatibleSourceConfig,
    type OpenAICompatibleSourceOptions,
    sourceManifest,
    validateOpenAICompatibleSourceConfig,
} from "./config.ts";
export { OpenAIUpstreamError } from "./errors.ts";
export {
    createOpenAICompatibleSource,
    OpenAICompatibleSource,
} from "./transport.ts";
export { generationPayload, toWireRequest } from "./request.ts";
export { jsonEvents, parseUsage } from "./response.ts";
export { readSse, streamResponse } from "./stream.ts";
