import {
    createConversation,
    deleteChatConversation,
    listChatConversations,
    loadChatConversation,
    openChatStream,
    renameChatConversation,
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
        remove: (id, signal) =>
            deleteChatConversation(id, { ...options, signal }),
        open: (command, onEvent) =>
            openChatStream(
                command,
                { onEvent },
                globalThis.location.href,
                options,
            ),
    };
}
