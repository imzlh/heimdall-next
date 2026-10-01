/** Browser management API. Transport, wire types, and domain requests stay separate. */
export type * from "./types.ts";
export {
    AdminApiError,
    clearAdminToken,
    configureAdminTransport,
    describeError,
    getAdminToken,
    request,
    setAdminToken,
} from "./transport.ts";
export { loadDashboard } from "./dashboard.ts";
export {
    applyPreset,
    clearSourceCooldown,
    createSource,
    deleteSource,
    loadSourceConfig,
    loadSourceMetadata,
    previewPreset,
    probeSourceDraft,
    saveSourceConfig,
    updateSource,
    validateSourceConfig,
} from "./sources.ts";
export { loadRuntimeSettings, saveRuntimeSettings } from "./settings.ts";
export {
    loadProxyPool,
    type ProxyPoolEnvelope,
    saveProxyPool,
} from "./proxies.ts";
export {
    createChatConversation,
    loadRequests,
    loadUsage,
    probeSource,
    regenerateChat,
    sendChatMessage,
    setPluginEnabled,
    uninstallPlugin,
} from "./operations.ts";
