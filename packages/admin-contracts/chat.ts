/** JSON-only chat presentation and transport records, shared by SSR and islands. */
import type { ChatExtensions } from "./chat-ui.ts";
export interface ChatConversation {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    /** Injected before every completion of this conversation. */
    systemPrompt?: string;
    /** Reasoning effort preference: "low" | "medium" | "high". */
    reasoningEffort?: "low" | "medium" | "high";
    /** Tool plugin ids switched off for this conversation. */
    disabledTools?: readonly string[];
    activeMessageId?: string;
    /** All leaf paths, including branches surviving deletion of an earlier turn. */
    branches?: { messageId: string; label: string; selected: boolean }[];
}

/** A tool plugin the conversation settings can switch on or off. */
export interface ChatToolInfo {
    id: string;
    name: string;
    description?: string;
}

/** Stored images travel by reference; inline data is accepted only for migration. */
export type ChatAttachment = ChatAssetAttachment | ChatInlineAttachment;

export interface ChatAssetAttachment {
    assetId: string;
    /** Draft reservation only; saved history never includes this value. */
    leaseId?: string;
    mediaType: string;
    url?: string;
    size?: number;
    name?: string;
    dataBase64?: never;
}

export interface ChatInlineAttachment {
    mediaType: string;
    dataBase64: string;
    assetId?: never;
    leaseId?: never;
    url?: never;
    size?: never;
    name?: never;
}

export interface ChatMessage {
    id: string;
    conversationId: string;
    role: "system" | "user" | "assistant" | "tool";
    text: string;
    createdAt: string;
    parentId?: string | null;
    branch?: { index: number; count: number; messageIds: string[] };
    callId?: string;
    name?: string;
    /** Absent on legacy messages, which are treated as completed. */
    status?: "completed" | "failed" | "stopped";
    error?: { code: string; message: string };
    attachments?: ChatAttachment[];
    /** Public reasoning transcript surfaced alongside the answer. */
    reasoning?: string;
    /** Cloud activity lines (e.g. searches) the model ran for this reply. */
    activity?: ChatActivity[];
    /** Sources the answer cited. */
    citations?: ChatCitation[];
}

/** A one-line cloud-activity status (search, tool, etc.) shown with a reply. */
export interface ChatActivity {
    summary: string;
}

/** A source the answer cited. */
export interface ChatCitation {
    label?: string;
    url?: string;
    /**
     * The marker id an inline `cite…` badge points at (e.g. `turn1search42`),
     * letting the answer link each badge to the source it cites.
     */
    ref?: string;
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
    | {
        type: "regenerate";
        conversationId: string;
        model: string;
        messageId?: string;
    }
    | {
        type: "continue";
        conversationId: string;
        model: string;
        messageId?: string;
    }
    | {
        type: "edit";
        conversationId: string;
        model?: string;
        messageId: string;
        text: string;
    };

export type ChatEvent =
    | { type: "user"; message: ChatMessage }
    | { type: "delta"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "activity"; items: ChatActivity[] }
    | { type: "citations"; items: ChatCitation[] }
    | { type: "tool"; calls: ChatToolCall[] }
    | { type: "suggestions"; items: string[] }
    | { type: "done"; conversation?: ChatConversation }
    | { type: "stopped" }
    | { type: "error"; message: string };

export interface ChatInitial {
    conversations: ChatConversation[];
    conversation: ChatConversation | null;
    messages: ChatMessage[];
    models: string[];
    selectedModel?: string;
    /** Tool plugins the settings popover can toggle for this conversation. */
    tools?: readonly ChatToolInfo[];
    /** Host-selected Chat slots; execution still requires the host UI policy. */
    extensions?: ChatExtensions;
    error?: string;
    authenticated: boolean;
    available: boolean;
}
