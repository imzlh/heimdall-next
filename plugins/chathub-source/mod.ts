import type { SourcePluginFactory } from "@heimdall/contracts";
import {
    type ChatHubSourceConfig,
    mergeChatHubSourceConfig,
    redactChatHubSourceConfig,
    sourceManifest,
    validateChatHubSourceConfig,
} from "./config.ts";
import { createChatHubSource } from "./transport.ts";

export * from "./config.ts";
export * from "./transport.ts";
export { completeLogin, refreshAccessToken, startLogin } from "./auth.ts";

export const sourcePlugin: SourcePluginFactory<ChatHubSourceConfig> = {
    manifest: sourceManifest,
    validate: validateChatHubSourceConfig,
    create: createChatHubSource,
    redact: redactChatHubSourceConfig,
    mergeConfig: mergeChatHubSourceConfig,
};
