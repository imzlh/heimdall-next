import { CHATHUB_ENDPOINT } from "./constants.ts";
import type { ChatHubUrlOptions } from "./types.ts";

export class ChatHubUrlError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ChatHubUrlError";
    }
}

/**
 * Feature-flag variants the Office web client declares on every connection.
 * Without them the turn is answered with a "no valid license" refusal — the
 * engines are gated on this client capability string, not on the tenant alone.
 */
const VARIANTS =
    "EnableMcpServerWidgets,feature.EnableMcpServerWidgets,feature.EnableLuForChatCIQ,feature.enableChatCIQPlugin,EnableRequestPlugins,feature.EnableSensitivityLabels,EnableUnsupportedUrlDetector,feature.IsCustomEngineCopilotEnabled,feature.bizchatfluxv3,feature.enablechatpages,feature.enableCodeCanvas,feature.turnOnDARecommendation,feature.IsStreamingModeInChatRequestEnabled,IncludeSourceAttributionsConcise,SkipPublishEmptyMessage,feature.EnableDeduplicatingSourceAttributions,Enable3PActionProgressMessages,feature.enableClientWebRtc,feature.EnableMeetingRecapOfSeriesMeetingWithCiq,feature.EnableReferencesListCompleteSignal,feature.StorageMessageSplitDisabled,feature.cwcallowedos,feature.disabledisallowedmsgs,feature.enableCitationsForSynthesisData,feature.enableGenerateGraphicArtOptionsSet,cdximagen,feature.EnableUpdatedUXForConfirmationDialog,feature.EnableClientFileURLSupportForOfficeWebPaidCopilot,feature.EnableDesignEditorImageGrounding,feature.EnableDesignerEditor,feature.OfficeWebToHelix,feature.OfficeDesktopToHelix,feature.M365TeamsHubToHelix,feature.OwaHubToHelix,feature.MonarchHubToHelix,feature.Win32OutlookHubToHelix,feature.MacOutlookHubToHelix,Agt_bizchat_enableGpt5ForHelix,feature.EnableImageGenInsufficientTokensThrottled,feature.EnableImageGenSystemCapacityThrottled,feature.EnableConversationShareApis,feature.IsCitationsReferencesOutputEnabled,feature.enableDeltaStreamingForReferences,feature.enableIncludeReferencesInDeltaResponse,feature.enablereferencesforagents,feature.EnableMergingPureDeltas,feature.EnableRemoveStreamingMode,feature.EnableCodeInterpreterConversion,agt_module_attr_enableReferencesForCodeInterpreter,agt_module_enableCodeInterpreterHallucinatedUrlFilter,SingletonEnvOn,cdxenablefccinmainline,EnableComposeWidget,feature.EnableContentApiandDocTypeHtmlInRichAnswers,cdxgrounding_api_v2_rich_web_answers_reference_bottom_force,cdxenablerenderforisocomp,feature.EnableSkipRehydrationForSpeCIdImages,feature.EnablePersonalization,feature.EnableBase64DataInMessageAnnotations,feature.EnableSkipEmittingMessageOnFlush,feature.EnableRemoveEmptySourceAttributions,agt_researcheragent_enableMemoryRead";

function requireValue(name: string, value: string): string {
    if (value.trim().length === 0) {
        throw new ChatHubUrlError(`${name} must not be empty`);
    }
    return value;
}

/** Builds the authenticated ChatHub WebSocket URL for one invocation. */
export function buildChatHubUrl(options: ChatHubUrlOptions): string {
    const oid = requireValue("oid", options.oid);
    const tid = requireValue("tid", options.tid);
    const accessToken = requireValue("accessToken", options.accessToken);
    const sessionId = requireValue("sessionId", options.sessionId);
    const conversationId = requireValue(
        "conversationId",
        options.conversationId,
    );
    const chatSessionId = requireValue("chatSessionId", options.chatSessionId);
    const clientRequestId = options.clientRequestId ?? chatSessionId;

    const endpoint = (options.endpoint ?? CHATHUB_ENDPOINT).replace(/\/+$/, "");
    let url: URL;
    try {
        url = new URL(
            `${endpoint}/${encodeURIComponent(oid)}@${encodeURIComponent(tid)}`,
        );
    } catch (cause) {
        throw new ChatHubUrlError(
            `Invalid ChatHub endpoint: ${
                cause instanceof Error ? cause.message : String(cause)
            }`,
        );
    }

    if (url.protocol !== "wss:" && url.protocol !== "ws:") {
        throw new ChatHubUrlError("ChatHub endpoint must use ws: or wss:");
    }

    url.searchParams.set("chatsessionid", chatSessionId);
    url.searchParams.set("clientrequestid", clientRequestId);
    url.searchParams.set("XRoutingParameterSessionKey", chatSessionId);
    url.searchParams.set("X-SessionId", sessionId);
    url.searchParams.set("ConversationId", conversationId);
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("variants", VARIANTS);
    // The source value keeps its literal quotes, exactly as the browser sends it.
    url.searchParams.set("source", '"officeweb"');
    url.searchParams.set("product", "Office");
    url.searchParams.set("agentHost", "Bizchat.FullScreen");
    url.searchParams.set(
        "licenseType",
        options.licenseType?.trim() || "Starter",
    );
    url.searchParams.set("agent", "web");
    url.searchParams.set(
        "scenario",
        options.scenario?.trim() || "OfficeWebIncludedCopilot",
    );
    if (options.disableMemory) {
        url.searchParams.set("disableMemory", "1");
    }

    for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
    }

    return url.toString();
}
