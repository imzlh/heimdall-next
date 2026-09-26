import type {
    ChatAttachment,
    ChatCommand,
    ChatConversation,
    ChatEvent,
    ChatStream,
} from "../api/chat.ts";
import { createChatApi } from "./api.ts";
import { readChatAttachments, validateChatAttachments } from "./attachments.ts";
import type {
    ChatController,
    ChatControllerOptions,
    ChatState,
} from "./types.ts";
export type {
    ChatController,
    ChatControllerOptions,
    ChatState,
} from "./types.ts";

interface Draft {
    readonly text: string;
    readonly attachments: readonly ChatAttachment[];
}
interface Run {
    id: string;
    readonly abort: AbortController;
    stream?: ChatStream;
    stopped: boolean;
}
const emptyDraft = (): Draft => ({ text: "", attachments: [] });
const describe = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

// Unsent drafts survive reloads, like the original chat: text goes to
// localStorage per conversation; images stay in memory only (they can exceed
// the storage quota as base64).
const DRAFT_KEY_PREFIX = "heimdall.chat.draft.";
const MODEL_STORE_KEY = "heimdall.chat.models";

function readStoredText(id: string): string {
    try {
        const raw = globalThis.localStorage?.getItem(DRAFT_KEY_PREFIX + id);
        if (!raw) return "";
        const parsed = JSON.parse(raw) as { text?: unknown };
        return typeof parsed?.text === "string"
            ? parsed.text.slice(0, 100_000)
            : "";
    } catch {
        return "";
    }
}

function writeStoredText(id: string, text: string): void {
    try {
        if (text) {
            globalThis.localStorage?.setItem(
                DRAFT_KEY_PREFIX + id,
                JSON.stringify({ text }),
            );
        } else globalThis.localStorage?.removeItem(DRAFT_KEY_PREFIX + id);
    } catch { /* Storage may be unavailable; drafts stay in memory. */ }
}

function readStoredModels(): Record<string, string> {
    try {
        const parsed: unknown = JSON.parse(
            globalThis.localStorage?.getItem(MODEL_STORE_KEY) ?? "{}",
        );
        const map: Record<string, string> = {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [key, value] of Object.entries(parsed)) {
                if (typeof value === "string") map[key] = value;
            }
        }
        return map;
    } catch {
        return {};
    }
}

/** One controller owns one view and at most one generation. Failed sends never replay. */
export function createChatController(
    options: ChatControllerOptions,
): ChatController {
    const { initial, onSelect } = options;
    const api = options.api ?? createChatApi();
    // Remembered per-conversation models apply on selection; SSR state wins at
    // construction so a deep link never gets overridden by local preferences.
    const storedModels = readStoredModels();
    let state: ChatState = {
        conversations: initial.conversations,
        conversation: initial.conversation,
        selectedId: initial.conversation?.id ?? "",
        messages: initial.messages,
        models: initial.models,
        model: initial.selectedModel ?? initial.models[0] ?? "",
        draft: "",
        attachments: [],
        loading: false,
        creating: false,
        managing: false,
        sending: false,
        stopping: false,
        attachmentsBusy: false,
        streamText: "",
        toolCalls: [],
        error: initial.error ?? "",
        authenticated: initial.authenticated,
        available: initial.available,
    };
    const listeners = new Set<(state: ChatState) => void>();
    const drafts = new Map<string, Draft>();
    let disposed = false;
    let navigation = 0;
    let attachmentRevision = 0;
    let readAbort: AbortController | undefined;
    let mutationAbort: AbortController | undefined;
    let activeRun: Run | undefined;
    const patch = (update: Partial<ChatState>) => {
        if (disposed) return;
        state = { ...state, ...update };
        for (const listener of listeners) listener(state);
    };
    const allowed = () => !disposed && state.available && state.authenticated;
    const idle = () =>
        allowed() && !state.sending && !state.creating && !state.loading &&
        !state.managing;
    const draftFor = (id = state.selectedId): Draft => {
        const existing = drafts.get(id);
        if (existing) return existing;
        const text = readStoredText(id);
        const draft: Draft = { text, attachments: [] };
        if (text) drafts.set(id, draft);
        return draft;
    };
    const editDraft = (value: Draft) => {
        drafts.set(state.selectedId, value);
        writeStoredText(state.selectedId, value.text);
        patch({ draft: value.text, attachments: value.attachments });
    };
    const rememberModel = (id: string, model: string) => {
        storedModels[id] = model;
        try {
            globalThis.localStorage?.setItem(
                MODEL_STORE_KEY,
                JSON.stringify(storedModels),
            );
        } catch { /* Preference persistence is optional. */ }
    };
    const modelFor = (id: string) => {
        const remembered = storedModels[id];
        return remembered && state.models.includes(remembered)
            ? remembered
            : state.model;
    };
    const upsert = (conversation: ChatConversation) =>
        [
            conversation,
            ...state.conversations.filter((item) =>
                item.id !== conversation.id
            ),
        ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const currentRun = (run: Run) => !disposed && activeRun === run;
    function cancelRun() {
        const run = activeRun;
        activeRun = undefined;
        run?.abort.abort();
        run?.stream?.close();
    }
    function beginNavigation() {
        navigation++;
        attachmentRevision++;
        readAbort?.abort();
        cancelRun();
        patch({
            sending: false,
            stopping: false,
            creating: false,
            attachmentsBusy: false,
        });
        return navigation;
    }
    function showConversation(
        conversation: ChatConversation,
        transfer = false,
    ) {
        if (transfer) {
            drafts.set(conversation.id, draftFor(""));
            drafts.delete("");
            writeStoredText("", "");
        }
        const draft = draftFor(conversation.id);
        patch({
            conversation,
            selectedId: conversation.id,
            conversations: upsert(conversation),
            messages: [],
            draft: draft.text,
            attachments: draft.attachments,
            model: modelFor(conversation.id),
            streamText: "",
            toolCalls: [],
        });
        onSelect?.(conversation.id);
    }
    async function reload(
        id: string,
        signal: AbortSignal,
        valid: () => boolean,
        interrupted?: { readonly previousIds: ReadonlySet<string> },
    ): Promise<void> {
        const [list, history] = await Promise.allSettled([
            api.list(signal),
            id ? api.load(id, signal) : Promise.resolve(null),
        ]);
        if (!valid()) return;
        const errors = [state.error];
        if (list.status === "fulfilled") patch({ conversations: list.value });
        else errors.push(`会话列表读取失败：${describe(list.reason)}`);
        if (history.status === "fulfilled") {
            if (history.value) {
                const savedText = history.value.messages.filter((message) =>
                    message.role === "assistant" && !message.callId &&
                    !interrupted?.previousIds.has(message.id)
                ).map((message) => message.text).join("");
                // A successful history read does not prove the failed stream
                // was saved. Retain visible output after storage/transport
                // failure until the response actually contains that output.
                const unsavedText = interrupted && state.streamText &&
                        !savedText.endsWith(state.streamText)
                    ? state.streamText
                    : "";
                patch({
                    ...history.value,
                    streamText: unsavedText,
                    toolCalls: [],
                });
            }
        } else errors.push(`消息读取失败：${describe(history.reason)}`);
        patch({ error: errors.filter(Boolean).join("；") });
    }
    async function select(id: string, afterDelete = false) {
        if (!allowed() || !id || (state.managing && !afterDelete)) return;
        const ticket = beginNavigation();
        const abort = readAbort = new AbortController();
        // Keep the current conversation readable until the next history arrives.
        // A failed request must not discard the selected conversation or its draft.
        patch({ loading: true, error: "" });
        try {
            const loaded = await api.load(id, abort.signal);
            if (disposed || navigation !== ticket) return;
            const draft = draftFor(id);
            patch({
                ...loaded,
                selectedId: id,
                streamText: "",
                toolCalls: [],
                draft: draft.text,
                attachments: draft.attachments,
                model: modelFor(id),
            });
            onSelect?.(id);
        } catch (error) {
            if (!disposed && navigation === ticket) {
                patch({ error: `消息读取失败：${describe(error)}` });
            }
        } finally {
            if (!disposed && navigation === ticket) patch({ loading: false });
        }
    }
    async function create() {
        if (!idle()) return;
        const transfer = !state.selectedId;
        const ticket = beginNavigation();
        const abort = readAbort = new AbortController();
        patch({ creating: true, error: "" });
        try {
            const conversation = await api.create(abort.signal);
            if (disposed || navigation !== ticket) return;
            showConversation(conversation, transfer);
        } catch (error) {
            if (!disposed && navigation === ticket) {
                patch({ error: describe(error) });
            }
        } finally {
            if (!disposed && navigation === ticket) patch({ creating: false });
        }
    }
    async function refresh() {
        if (!idle()) return;
        const ticket = ++navigation;
        readAbort?.abort();
        const abort = readAbort = new AbortController();
        patch({ loading: true, error: "" });
        await reload(
            state.selectedId,
            abort.signal,
            () => !disposed && navigation === ticket,
        );
        if (!disposed && navigation === ticket) patch({ loading: false });
    }
    function canManage(id: string): boolean {
        if (!allowed()) return false;
        if (state.sending) {
            patch({ error: "请先停止生成，再管理会话" });
            return false;
        }
        if (!idle() || state.attachmentsBusy) return false;
        if (
            !state.conversations.some((conversation) => conversation.id === id)
        ) {
            patch({ error: "会话不存在，请刷新列表" });
            return false;
        }
        return true;
    }
    async function rename(id: string, title: string): Promise<boolean> {
        if (!canManage(id)) return false;
        const normalized = title.trim();
        if (!normalized || normalized.length > 120) {
            patch({ error: "会话名称需为 1–120 个字符" });
            return false;
        }
        const abort = mutationAbort = new AbortController();
        patch({ managing: true, error: "" });
        try {
            const conversation = await api.rename(id, normalized, abort.signal);
            if (disposed) return false;
            patch({
                conversations: upsert(conversation),
                ...(state.selectedId === id ? { conversation } : {}),
            });
            return true;
        } catch (error) {
            if (!disposed) patch({ error: `重命名失败：${describe(error)}` });
            return false;
        } finally {
            mutationAbort = undefined;
            patch({ managing: false });
        }
    }
    async function updateSettings(
        id: string,
        patchSettings: {
            readonly systemPrompt?: string;
            readonly reasoningEffort?: "low" | "medium" | "high" | null;
        },
    ): Promise<boolean> {
        if (!allowed() || !id) return false;
        // Settings auto-save stays out of the composer's busy flags: it must
        // not block typing, and a mid-run 409 only fails this one save.
        const abort = new AbortController();
        try {
            const conversation = await api.updateSettings(
                id,
                patchSettings,
                abort.signal,
            );
            if (disposed) return false;
            patch({
                conversations: upsert(conversation),
                ...(state.selectedId === id ? { conversation } : {}),
            });
            return true;
        } catch (error) {
            if (!disposed) patch({ error: `设置保存失败：${describe(error)}` });
            return false;
        }
    }
    async function remove(id: string): Promise<boolean> {
        if (!canManage(id)) return false;
        const abort = mutationAbort = new AbortController();
        patch({ managing: true, error: "" });
        try {
            await api.remove(id, abort.signal);
            if (disposed) return false;
            const index = state.conversations.findIndex((item) =>
                item.id === id
            );
            const conversations = state.conversations.filter((item) =>
                item.id !== id
            );
            drafts.delete(id);
            writeStoredText(id, "");
            patch({ conversations });
            if (state.selectedId === id) {
                beginNavigation();
                const draft = draftFor("");
                patch({
                    selectedId: "",
                    conversation: null,
                    messages: [],
                    streamText: "",
                    toolCalls: [],
                    draft: draft.text,
                    attachments: draft.attachments,
                });
                onSelect?.("");
                const next =
                    conversations[Math.min(index, conversations.length - 1)];
                if (next) await select(next.id, true);
            }
            return true;
        } catch (error) {
            if (!disposed) patch({ error: `删除失败：${describe(error)}` });
            return false;
        } finally {
            mutationAbort = undefined;
            patch({ managing: false });
        }
    }
    async function generate(type: "send" | "regenerate") {
        if (!idle() || state.attachmentsBusy) return;
        if (!state.model || !state.models.includes(state.model)) {
            patch({ error: "请选择可用模型" });
            return;
        }
        const draft = draftFor();
        if (type === "send") {
            if (!draft.text.trim()) {
                patch({ error: "请输入消息内容" });
                return;
            }
            if (draft.text.trim().length > 100_000) {
                patch({ error: "消息不能超过 100,000 个字符" });
                return;
            }
            try {
                validateChatAttachments(draft.attachments);
            } catch (error) {
                patch({ error: describe(error) });
                return;
            }
        } else if (
            !state.conversation ||
            !state.messages.some((message) => message.role === "user")
        ) {
            patch({ error: "当前会话还没有可重新生成的消息" });
            return;
        }
        const model = state.model;
        const previousIds = new Set(
            state.messages.map((message) => message.id),
        );
        let interrupted = false;
        const run: Run = {
            id: state.selectedId,
            abort: new AbortController(),
            stopped: false,
        };
        activeRun = run;
        patch({
            sending: true,
            stopping: false,
            error: "",
            streamText: "",
            toolCalls: [],
        });
        try {
            if (!run.id) {
                patch({ creating: true });
                const conversation = await api.create(run.abort.signal);
                if (!currentRun(run)) return;
                run.id = conversation.id;
                showConversation(conversation, true);
                patch({ creating: false });
            }
            if (run.stopped) return;
            if (type === "regenerate") {
                const lastUser = state.messages.findLastIndex((message) =>
                    message.role === "user"
                );
                patch({ messages: state.messages.slice(0, lastUser + 1) });
            }
            const command: ChatCommand = type === "send"
                ? {
                    type,
                    conversationId: run.id,
                    model,
                    text: draft.text.trim(),
                    ...(draft.attachments.length
                        ? { attachments: [...draft.attachments] }
                        : {}),
                }
                : { type, conversationId: run.id, model };
            const receive = (event: ChatEvent) => {
                if (!currentRun(run)) return;
                if (
                    event.type === "user" &&
                    event.message.conversationId === run.id
                ) {
                    if (
                        !state.messages.some((message) =>
                            message.id === event.message.id
                        )
                    ) {
                        patch({ messages: [...state.messages, event.message] });
                    }
                    if (drafts.get(run.id) === draft) editDraft(emptyDraft());
                } else if (event.type === "delta") {
                    patch({ streamText: state.streamText + event.text });
                } else if (event.type === "tool") {
                    const calls = new Map(
                        state.toolCalls.map((call) => [call.callId, call]),
                    );
                    for (const call of event.calls) {
                        calls.set(call.callId, call);
                    }
                    patch({ toolCalls: [...calls.values()] });
                } else if (event.type === "done" && event.conversation) {
                    patch({
                        conversation: event.conversation,
                        conversations: upsert(event.conversation),
                    });
                }
            };
            run.stream = api.open(command, receive);
            interrupted = await run.stream.finished === "stopped";
        } catch (error) {
            interrupted = true;
            if (currentRun(run)) patch({ error: describe(error) });
        } finally {
            if (currentRun(run)) {
                patch({ loading: true, creating: false });
                await reload(
                    run.id,
                    run.abort.signal,
                    () => currentRun(run),
                    interrupted ? { previousIds } : undefined,
                );
                if (currentRun(run)) {
                    activeRun = undefined;
                    patch({ sending: false, stopping: false, loading: false });
                }
            }
        }
    }
    return {
        getState: () => state,
        subscribe(listener) {
            if (!disposed) listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        create,
        rename,
        updateSettings,
        remove,
        select,
        refresh,
        setDraft(text) {
            if (!disposed) editDraft({ ...draftFor(), text });
        },
        setModel(model) {
            if (disposed) return;
            patch({ model });
            if (state.selectedId) rememberModel(state.selectedId, model);
        },
        async addAttachments(files) {
            if (!allowed() || state.attachmentsBusy) return;
            const ticket = ++attachmentRevision;
            const id = state.selectedId;
            const draft = draftFor();
            patch({ attachmentsBusy: true, error: "" });
            try {
                const attachments = await readChatAttachments(
                    files,
                    draft.attachments,
                );
                if (
                    !disposed && ticket === attachmentRevision &&
                    id === state.selectedId
                ) {
                    const current = draftFor();
                    const combined = [
                        ...current.attachments,
                        ...attachments.slice(draft.attachments.length),
                    ];
                    validateChatAttachments(combined);
                    editDraft({ ...current, attachments: combined });
                }
            } catch (error) {
                if (!disposed && ticket === attachmentRevision) {
                    patch({ error: describe(error) });
                }
            } finally {
                if (!disposed && ticket === attachmentRevision) {
                    patch({ attachmentsBusy: false });
                }
            }
        },
        removeAttachment(index) {
            if (disposed) return;
            attachmentRevision++;
            editDraft({
                ...draftFor(),
                attachments: draftFor().attachments.filter((_, i) =>
                    i !== index
                ),
            });
            patch({ attachmentsBusy: false });
        },
        send: () => generate("send"),
        regenerate: () => generate("regenerate"),
        stop() {
            if (!activeRun || activeRun.stopped) return;
            activeRun.stopped = true;
            patch({ stopping: true });
            activeRun.stream?.stop();
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            navigation++;
            attachmentRevision++;
            readAbort?.abort();
            mutationAbort?.abort();
            cancelRun();
            drafts.clear();
            listeners.clear();
        },
    };
}
