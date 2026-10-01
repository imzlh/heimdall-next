import type { ChatInitial } from "@heimdall/admin-contracts/chat.ts";
import type { ChatToolInfo } from "@heimdall/admin-contracts/chat.ts";
import type {
    ChatActivity,
    ChatAttachment,
    ChatCitation,
    ChatCommand,
    ChatConversation,
    ChatEvent,
    ChatMessage,
    ChatStream,
    ChatToolCall,
} from "../api/chat.ts";

export type { ChatInitial };

export interface ChatHistory {
    conversation: ChatConversation;
    messages: ChatMessage[];
}

export interface ChatApi {
    list(signal?: AbortSignal): Promise<ChatConversation[]>;
    create(signal?: AbortSignal): Promise<ChatConversation>;
    rename(
        id: string,
        title: string,
        signal?: AbortSignal,
    ): Promise<ChatConversation>;
    updateSettings(
        id: string,
        patch: {
            readonly systemPrompt?: string;
            readonly reasoningEffort?: "low" | "medium" | "high" | null;
            readonly disabledTools?: readonly string[];
        },
        signal?: AbortSignal,
    ): Promise<ChatConversation>;
    remove(id: string, signal?: AbortSignal): Promise<void>;
    /** Deletes the message's whole Q&A turn and returns every removed id. */
    deleteMessage(
        conversationId: string,
        messageId: string,
        signal?: AbortSignal,
    ): Promise<readonly string[]>;
    load(id: string, signal?: AbortSignal): Promise<ChatHistory>;
    switchBranch(
        conversationId: string,
        messageId: string,
        signal?: AbortSignal,
    ): Promise<ChatHistory>;
    fork(
        conversationId: string,
        messageId: string,
        signal?: AbortSignal,
    ): Promise<ChatHistory>;
    upload(file: File, signal?: AbortSignal): Promise<ChatAttachment>;
    acquireAttachment(
        assetId: string,
        signal?: AbortSignal,
    ): Promise<ChatAttachment>;
    releaseAttachment(assetId: string, leaseId: string): Promise<void>;
    open(command: ChatCommand, onEvent: (event: ChatEvent) => void): ChatStream;
}

export interface ChatState {
    readonly conversations: readonly ChatConversation[];
    readonly conversation: ChatConversation | null;
    readonly selectedId: string;
    readonly messages: readonly ChatMessage[];
    readonly models: readonly string[];
    readonly model: string;
    /** Tool plugins available for the settings toggles. */
    readonly tools: readonly ChatToolInfo[];
    readonly draft: string;
    readonly attachments: readonly ChatAttachment[];
    readonly loading: boolean;
    readonly creating: boolean;
    readonly managing: boolean;
    readonly sending: boolean;
    readonly stopping: boolean;
    readonly attachmentsBusy: boolean;
    readonly streamText: string;
    readonly toolCalls: readonly ChatToolCall[];
    /** Live public reasoning for the in-flight turn; session-only. */
    readonly streamReasoning: string;
    /** Live cloud-activity lines for the in-flight turn; session-only. */
    readonly streamActivity: readonly ChatActivity[];
    /** Live citations for the in-flight turn; session-only. */
    readonly streamCitations: readonly ChatCitation[];
    /** Provider-suggested follow-up prompts for the current turn; session-only. */
    readonly suggestions: readonly string[];
    /**
     * Effort picked before the first message creates the conversation; the
     * composer falls back to it only while no conversation is selected.
     */
    readonly pendingEffort: "low" | "medium" | "high";
    readonly pendingDisabledTools?: readonly string[];
    readonly toolsBusy?: boolean;
    readonly error: string;
    readonly available: boolean;
    readonly authenticated: boolean;
}

export interface ChatController {
    getState(): ChatState;
    subscribe(listener: (state: ChatState) => void): () => void;
    create(): Promise<void>;
    rename(id: string, title: string): Promise<boolean>;
    /** Persist per-conversation settings; returns true on success. */
    updateSettings(
        id: string,
        patch: {
            readonly systemPrompt?: string;
            readonly reasoningEffort?: "low" | "medium" | "high" | null;
            readonly disabledTools?: readonly string[];
        },
    ): Promise<boolean>;
    /**
     * Routing for the composer's effort menu: persists to the conversation
     * when one is selected, otherwise holds the choice for the next new chat.
     */
    chooseEffort(effort: "low" | "medium" | "high"): void;
    setToolEnabled(id: string, enabled: boolean): Promise<boolean>;
    replaceTools(tools: readonly ChatToolInfo[]): void;
    remove(id: string): Promise<boolean>;
    /** Delete a single message from the selected conversation. */
    removeMessage(conversationId: string, messageId: string): Promise<boolean>;
    select(id: string): Promise<void>;
    refresh(): Promise<void>;
    setDraft(text: string): void;
    setModel(id: string): void;
    addAttachments(files: readonly File[]): Promise<void>;
    addReference(attachment: ChatAttachment): Promise<void>;
    removeAttachment(index: number): void;
    send(): Promise<void>;
    regenerate(messageId?: string): Promise<void>;
    continueMessage(messageId?: string): Promise<void>;
    editMessage(messageId: string, text: string): Promise<boolean>;
    switchBranch(messageId: string): Promise<boolean>;
    forkMessage(messageId: string): Promise<boolean>;
    stop(): void;
    dispose(): void;
}

export interface ChatControllerOptions {
    readonly initial: ChatInitial;
    readonly api?: ChatApi;
    readonly onSelect?: (id: string) => void;
}
