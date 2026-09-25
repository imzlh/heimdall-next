import {
    ChatHubTarget,
    DEFAULT_INVOCATION_ID,
    DEFAULT_PLUGINS,
    SIGNALR_PROTOCOL,
    SIGNALR_VERSION,
    SignalRMessageType,
} from "./constants.ts";
import type {
    ChatHubPlugin,
    ChatHubRequest,
    ChatHubSessionIds,
    MetricsTimestamps,
    ReceivedTokenMetrics,
    SignalRFrame,
    SignalRHandshakeRequest,
} from "./types.ts";

export interface FrameContext extends ChatHubSessionIds {
    clientRequestId?: string;
    clock?: () => Date;
}

export function createHandshakeRequest(): SignalRHandshakeRequest {
    return { protocol: SIGNALR_PROTOCOL, version: SIGNALR_VERSION };
}

export function createPingFrame(): SignalRFrame {
    return { type: SignalRMessageType.Ping };
}

// Exact payload fidelity matters: the upstream answers a turnState=Failed with
// no messages when the chat frame reads as a non-browser client. Everything
// below is mirrored from the Office-web traffic the reference gateway captured.
const ALLOWED_MESSAGE_TYPES = [
    "Chat",
    "Suggestion",
    "InternalSearchQuery",
    "Disengaged",
    "InternalLoaderMessage",
    "Progress",
    "GeneratedCode",
    "RenderCardRequest",
    "AdsQuery",
    "SemanticSerp",
    "GenerateContentQuery",
    "GenerateGraphicArt",
    "SearchQuery",
    "ConfirmationCard",
    "AuthError",
    "DeveloperLogs",
    "TriggerPlugin",
    "HintInvocation",
    "MemoryUpdate",
    "EndOfRequest",
    "TriggerConfirmation",
    "ResumeInvokeAction",
    "ResumeUserInputRequest",
    "TriggerUserInputRequest",
    "EscapeHatch",
    "TriggerPluginAuth",
    "ResumePluginAuth",
    "SideBySide",
    "ReferencesListComplete",
    "SwitchRespondingEndpoint",
];

const BASE_OPTION_SETS = [
    "search_result_progress_messages_with_search_queries",
    "update_textdoc_response_after_streaming",
    "deepleo_networking_timeout_10minutes_canmore",
    "cwc_flux_image",
    "cwc_code_interpreter",
    "cwc_code_interpreter_amsfix",
    "cwcfluxgptv",
    "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
    "gptvnorm2048",
    "cwc_code_interpreter_citation_fix",
    "code_interpreter_interactive_charts",
    "cwc_code_interpreter_interactive_charts_inline_image",
    "code_interpreter_matplotlib_patching",
    "cwc_fileupload_odb",
    "cwc_flux_v3",
    "flux_v3_progress_messages",
    "enable_batch_token_processing",
    "enable_gg_gpt",
    "flux_v3_references",
    "flux_v3_references_entities",
    "flux_v3_references_ci",
    "add_filestore_filetype",
    "cwc_code_interpreter_citation_sourceannotations",
    "cdxcwc_code_interpreter_hallucinated_url_filter",
    "flux_v3_image_gen_enable_dimensions",
    "flux_v3_image_gen_enable_non_watermarked_storage",
    "flux_v3_image_gen_enable_icon_dimensions",
    "flux_v3_image_gen_enable_system_text_with_params",
    "flux_v3_image_gen_enable_designer_dimensions_meta_prompting_in_system_prompts",
    "flux_v3_image_gen_enable_story",
    "rich_responses",
];

export function createChatFrame(
    request: ChatHubRequest,
    context: FrameContext,
): SignalRFrame {
    const invocationId = request.invocationId ?? DEFAULT_INVOCATION_ID;
    const requestId = context.clientRequestId ?? context.chatSessionId;
    const now = (context.clock ?? (() => new Date()))().toISOString();
    const plugins: readonly ChatHubPlugin[] = request.plugins ??
        DEFAULT_PLUGINS;

    const clientInfo = {
        clientPlatform: "mcmcopilot-web",
        clientAppName: "Office",
        clientEntrypoint: "mcmcopilot-officeweb",
        clientSessionId: context.sessionId,
        ProductCategory: "Chat",
        clientAppType: "Web",
        productEntryPoint: "ChatPanel",
        deviceOS: "Windows",
        deviceType: "Desktop",
        clientPlatformVersion: "10",
    };

    const message = {
        id: requestId,
        author: "user",
        inputMethod: "Keyboard",
        text: request.text,
        contentType: "text",
        messageType: "Chat",
        contentOrigin: "User",
        createdAt: now,
        requestId,
        entityAnnotationTypes: [
            "People",
            "File",
            "Event",
            "Email",
            "TeamsMessage",
        ],
        locationInfo: {
            timeZoneOffset: request.timezoneOffset ?? 0,
            timeZone: request.timezone ?? "UTC",
        },
        locale: request.locale ?? "en-us",
        adaptiveCards: [],
        clientPreferences: {},
        connectedFederatedConnections: ["dummyId"],
        experienceType: "Default",
        messageAnnotations: request.messageAnnotations ?? [],
    };

    const argument: Record<string, unknown> = {
        source: "officeweb",
        clientCorrelationId: requestId,
        sessionId: context.sessionId,
        conversationId: context.conversationId,
        optionsSets: [...BASE_OPTION_SETS],
        options: {},
        allowedMessageTypes: [...ALLOWED_MESSAGE_TYPES],
        sliceIds: [],
        threadLevelGptId: {},
        isStartOfSession: false,
        traceId: requestId.replace(/-/g, ""),
        clientInfo,
        tone: request.tone ?? "Magic",
        streamingMode: "ConciseWithPadding",
        plugins: plugins.map((plugin) => ({ ...plugin })),
        message,
        extraExtensionParameters: {},
        isSbsSupported: true,
        renderReferencesBehindEOS: true,
        disconnectBehavior: "continue",
        ...request.extraArguments,
    };

    if (request.previousMessages?.length) {
        argument.previousMessages = request.previousMessages;
    }

    return {
        arguments: [argument],
        invocationId,
        target: ChatHubTarget.Chat,
        type: SignalRMessageType.StreamInvocation,
    };
}

export function createRequestMetricsFrame(
    timestamps: MetricsTimestamps,
): SignalRFrame {
    return {
        arguments: [{ Timestamps: timestamps }],
        target: ChatHubTarget.Metrics,
        type: SignalRMessageType.Invocation,
    };
}

export function createResponseMetricsFrame(
    timestamps: MetricsTimestamps,
    receivedTokenMetrics: ReceivedTokenMetrics,
): SignalRFrame {
    return {
        arguments: [{
            Timestamps: timestamps,
            ReceivedTokenMetrics: receivedTokenMetrics,
        }],
        target: ChatHubTarget.Metrics,
        type: SignalRMessageType.Invocation,
    };
}

export function createAttachToSessionFrame(
    chatSessionId: string,
    invocationId = DEFAULT_INVOCATION_ID,
): SignalRFrame {
    if (chatSessionId.trim().length === 0) {
        throw new TypeError("chatSessionId must not be empty");
    }

    return {
        arguments: [chatSessionId],
        invocationId,
        target: ChatHubTarget.AttachToSession,
        type: SignalRMessageType.StreamInvocation,
    };
}

export function createCancelInvocationFrame(
    invocationId = DEFAULT_INVOCATION_ID,
): SignalRFrame {
    return {
        invocationId,
        type: SignalRMessageType.CancelInvocation,
    };
}
