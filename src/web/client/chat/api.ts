import {
    acquireChatAttachment,
    type ChatSettingsPatch,
    createConversation,
    deleteChatConversation,
    deleteChatMessage,
    forkChatConversation,
    listChatConversations,
    loadChatConversation,
    openChatStream,
    releaseChatAttachment,
    renameChatConversation,
    switchChatBranch,
    updateChatConversationSettings,
    uploadChatAttachment,
} from "../api/chat.ts";
import type { ChatApi } from "./types.ts";

const options = { endpoint: "/admin/chat/api", session: true } as const;

/** The chat island uses the HttpOnly web session and never reads an API token. */
export function createChatApi(): ChatApi {
    return {
        list: (signal) => listChatConversations({ ...options, signal }),
        create: (signal) => createConversation({ ...options, signal }),
        load: (id, signal) => loadChatConversation(id, { ...options, signal }),
        rename: (id, title, signal) =>
            renameChatConversation(id, title, { ...options, signal }),
        updateSettings: (id, patch, signal) =>
            updateChatConversationSettings(
                id,
                patch as ChatSettingsPatch,
                { ...options, signal },
            ),
        remove: (id, signal) =>
            deleteChatConversation(id, { ...options, signal }),
        deleteMessage: (conversationId, messageId, signal) =>
            deleteChatMessage(conversationId, messageId, {
                ...options,
                signal,
            }),
        switchBranch: (conversationId, messageId, signal) =>
            switchChatBranch(conversationId, messageId, { ...options, signal }),
        fork: (conversationId, messageId, signal) =>
            forkChatConversation(conversationId, messageId, {
                ...options,
                signal,
            }),
        upload: (file, signal) =>
            uploadChatAttachment(file, { ...options, signal }),
        acquireAttachment: (assetId, signal) =>
            acquireChatAttachment(assetId, { ...options, signal }),
        releaseAttachment: (assetId, leaseId) =>
            releaseChatAttachment(assetId, leaseId, options),
        open: (command, onEvent) =>
            openChatStream(
                command,
                { onEvent },
                globalThis.location.href,
                options,
            ),
    };
}
