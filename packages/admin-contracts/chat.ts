/** JSON-only chat presentation and transport records, shared by SSR and islands. */
export interface ChatConversation {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
}

export interface ChatAttachment {
    mediaType: string;
    dataBase64: string;
}

export interface ChatMessage {
    id: string;
    conversationId: string;
    role: "system" | "user" | "assistant" | "tool";
    text: string;
    createdAt: string;
    callId?: string;
    name?: string;
    attachments?: ChatAttachment[];
}

export interface ChatToolCall {
    callId: string;
    name: string;
    argumentsText: string;
}

export type ChatCommand =
    | {
        type: "send";
        conversationId: string;
        model: string;
        text: string;
        attachments?: ChatAttachment[];
    }
    | { type: "regenerate"; conversationId: string; model: string };

export type ChatEvent =
    | { type: "user"; message: ChatMessage }
    | { type: "delta"; text: string }
    | { type: "tool"; calls: ChatToolCall[] }
    | { type: "done"; conversation?: ChatConversation }
    | { type: "stopped" }
    | { type: "error"; message: string };

export interface ChatInitial {
    conversations: ChatConversation[];
    conversation: ChatConversation | null;
    messages: ChatMessage[];
    models: string[];
    selectedModel?: string;
    error?: string;
    authenticated: boolean;
    available: boolean;
}
