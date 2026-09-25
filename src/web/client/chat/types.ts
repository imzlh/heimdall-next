import type { ChatInitial } from "@heimdall/admin-contracts/chat.ts";
import type {
    ChatAttachment,
    ChatCommand,
    ChatConversation,
    ChatEvent,
    ChatMessage,
    ChatStream,
    ChatToolCall,
} from "../api/chat.ts";

export type { ChatInitial };

export interface ChatApi {
    list(signal?: AbortSignal): Promise<ChatConversation[]>;
    create(signal?: AbortSignal): Promise<ChatConversation>;
    rename(
        id: string,
        title: string,
        signal?: AbortSignal,
    ): Promise<ChatConversation>;
    remove(id: string, signal?: AbortSignal): Promise<void>;
    load(id: string, signal?: AbortSignal): Promise<{
        conversation: ChatConversation;
        messages: ChatMessage[];
    }>;
    open(command: ChatCommand, onEvent: (event: ChatEvent) => void): ChatStream;
}

export interface ChatState {
    readonly conversations: readonly ChatConversation[];
    readonly conversation: ChatConversation | null;
    readonly selectedId: string;
    readonly messages: readonly ChatMessage[];
    readonly models: readonly string[];
    readonly model: string;
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
    readonly error: string;
    readonly available: boolean;
    readonly authenticated: boolean;
}

export interface ChatController {
    getState(): ChatState;
    subscribe(listener: (state: ChatState) => void): () => void;
    create(): Promise<void>;
    rename(id: string, title: string): Promise<boolean>;
    remove(id: string): Promise<boolean>;
    select(id: string): Promise<void>;
    refresh(): Promise<void>;
    setDraft(text: string): void;
    setModel(id: string): void;
    addAttachments(files: readonly File[]): Promise<void>;
    removeAttachment(index: number): void;
    send(): Promise<void>;
    regenerate(): Promise<void>;
    stop(): void;
    dispose(): void;
}

export interface ChatControllerOptions {
    readonly initial: ChatInitial;
    readonly api?: ChatApi;
    readonly onSelect?: (id: string) => void;
}
