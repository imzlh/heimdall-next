import type {
    ChatAttachment,
    ChatCommand,
    ChatConversation,
    ChatEvent,
    ChatStream,
} from "../api/chat.ts";
import { createChatApi } from "./api.ts";
import {
    type ChatDraft as Draft,
    readStoredDraft,
    writeStoredDraft,
} from "./drafts.ts";
import {
    uploadChatAttachments,
    validateChatAttachments,
} from "./attachments.ts";
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

interface Run {
    id: string;
    readonly abort: AbortController;
    stream?: ChatStream;
    stopped: boolean;
}
const emptyDraft = (): Draft => ({ text: "", attachments: [] });
const describe = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

const MODEL_STORE_KEY = "heimdall.chat.models";

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
        tools: initial.tools ?? [],
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
        streamReasoning: "",
        streamActivity: [],
        streamCitations: [],
        suggestions: [],
        pendingEffort: "medium",
        error: initial.error ?? "",
        authenticated: initial.authenticated,
        available: initial.available,
    };
    const listeners = new Set<(state: ChatState) => void>();
    const drafts = new Map<string, Draft>();
    // Storage is shared by browser tabs; reading a lease never grants ownership.
    const ownedLeases = new Set<string>();
    let restoringDraft: { id: string; ticket: number } | undefined;
    let disposed = false;
    let navigation = 0;
    let attachmentRevision = 0;
    let readAbort: AbortController | undefined;
    let mutationAbort: AbortController | undefined;
    let uploadAbort: AbortController | undefined;
    let activeRun: Run | undefined;
    const patch = (update: Partial<ChatState>) => {
        if (disposed) return;
        state = { ...state, ...update };
        for (const listener of listeners) listener(state);
    };
    const allowed = () => !disposed && state.available && state.authenticated;
    const idle = () =>
        allowed() && !state.sending && !state.creating && !state.loading &&
        !state.managing && !state.toolsBusy;
    const draftFor = (id = state.selectedId): Draft => {
        const existing = drafts.get(id);
        if (existing) return existing;
        const draft = readStoredDraft(id);
        drafts.set(id, draft);
        return draft;
    };
    const editDraft = (value: Draft) => {
        drafts.set(state.selectedId, value);
        writeStoredDraft(state.selectedId, value);
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
    const leaseKey = (attachment: ChatAttachment) =>
        `${attachment.assetId}:${attachment.leaseId}`;
    const ownsLease = (attachment: ChatAttachment) =>
        !!attachment.assetId && !!attachment.leaseId &&
        ownedLeases.has(leaseKey(attachment));
    function retainDraftImages(attachments: readonly ChatAttachment[]): void {
        for (const attachment of attachments) {
            if (attachment.assetId && attachment.leaseId) {
                ownedLeases.add(leaseKey(attachment));
            }
        }
    }
    function forgetDraftImages(attachments: readonly ChatAttachment[]): void {
        for (const attachment of attachments) {
            ownedLeases.delete(leaseKey(attachment));
        }
    }
    function releaseDraftImages(attachments: readonly ChatAttachment[]): void {
        for (const attachment of attachments) {
            if (attachment.assetId && attachment.leaseId) {
                void api.releaseAttachment(
                    attachment.assetId,
                    attachment.leaseId,
                ).catch(() => {
                    // Persisted leases expire even if an offline client cannot release them.
                });
            }
        }
    }
    function releaseOwnedDraftImages(attachments: readonly ChatAttachment[]) {
        const owned = attachments.filter(ownsLease);
        forgetDraftImages(owned);
        releaseDraftImages(owned);
    }
    const needsRestoration = (id: string) =>
        draftFor(id).attachments.some((attachment) =>
            attachment.assetId && !ownsLease(attachment)
        );
    async function renewRestoredDraft(id: string): Promise<boolean> {
        if (!allowed() || state.selectedId !== id) return false;
        if (!needsRestoration(id)) return true;
        const ticket = ++attachmentRevision;
        restoringDraft = { id, ticket };
        const abort = uploadAbort = new AbortController();
        const saved = draftFor(id);
        const acquired: ChatAttachment[] = [];
        patch({ attachmentsBusy: true, error: "" });
        const results = await Promise.allSettled(
            saved.attachments.map(async (attachment) => {
                if (!attachment.assetId || ownsLease(attachment)) {
                    return attachment;
                }
                const renewed = await api.acquireAttachment(
                    attachment.assetId,
                    abort.signal,
                );
                acquired.push(renewed);
                return renewed;
            }),
        );
        const attachments = results.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : []
        );
        const failed = results.find((result) => result.status === "rejected");
        if (restoringDraft?.ticket === ticket) restoringDraft = undefined;
        if (
            disposed || ticket !== attachmentRevision ||
            state.selectedId !== id || failed
        ) {
            releaseDraftImages(acquired);
            if (!disposed && ticket === attachmentRevision) {
                patch({
                    attachmentsBusy: false,
                    ...(failed?.status === "rejected"
                        ? {
                            error: `图片草稿恢复失败，请重试发送或移除图片：${
                                describe(failed.reason)
                            }`,
                        }
                        : {}),
                });
            }
            return false;
        }
        // A stored lease may still belong to another tab. Let it expire;
        // this controller owns and releases only its freshly acquired leases.
        retainDraftImages(acquired);
        editDraft({ ...draftFor(id), attachments });
        patch({ attachmentsBusy: false });
        return true;
    }
    function cancelRun() {
        const run = activeRun;
        activeRun = undefined;
        run?.abort.abort();
        run?.stream?.close();
    }
    function beginNavigation() {
        navigation++;
        attachmentRevision++;
        uploadAbort?.abort();
        restoringDraft = undefined;
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
            writeStoredDraft(conversation.id, draftFor(conversation.id));
            writeStoredDraft("", emptyDraft());
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
            streamReasoning: "",
            streamActivity: [],
            streamCitations: [],
            suggestions: [],
        });
        onSelect?.(conversation.id);
    }
    async function reload(
        id: string,
        signal: AbortSignal,
        valid: () => boolean,
        interrupted?: {
            readonly previousIds: ReadonlySet<string>;
            readonly continuation?: {
                readonly id: string;
                readonly text: string;
            };
        },
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
                const originalStillSaved = interrupted?.continuation &&
                    state.streamText === interrupted.continuation.text &&
                    history.value.messages.some((message) =>
                        message.id === interrupted.continuation!.id &&
                        message.text === state.streamText
                    );
                const unsavedText =
                    interrupted && state.streamText && !originalStillSaved &&
                        !savedText.endsWith(state.streamText)
                        ? state.streamText
                        : "";
                patch({
                    ...history.value,
                    streamText: unsavedText,
                    toolCalls: [],
                    streamReasoning: "",
                    streamActivity: [],
                    streamCitations: [],
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
                streamReasoning: "",
                streamActivity: [],
                streamCitations: [],
                suggestions: [],
                draft: draft.text,
                attachments: draft.attachments,
                model: modelFor(id),
                loading: false,
            });
            onSelect?.(id);
            await renewRestoredDraft(id);
        } catch (error) {
            if (!disposed && navigation === ticket) {
                patch({ error: `消息读取失败：${describe(error)}` });
            }
        } finally {
            if (!disposed && navigation === ticket) patch({ loading: false });
        }
    }
    async function create() {
        if (!idle() || state.attachmentsBusy) return;
        const transfer = !state.selectedId;
        const ticket = beginNavigation();
        const abort = readAbort = new AbortController();
        patch({ creating: true, error: "" });
        try {
            const created = await applyPendingEffort(
                await api.create(abort.signal),
            );
            if (disposed || navigation !== ticket) return;
            showConversation(created, transfer);
            await renewRestoredDraft(created.id);
        } catch (error) {
            if (!disposed && navigation === ticket) {
                patch({ error: describe(error) });
            }
        } finally {
            if (!disposed && navigation === ticket) patch({ creating: false });
        }
    }
    async function refresh() {
        if (!idle() || state.attachmentsBusy) return;
        const ticket = ++navigation;
        readAbort?.abort();
        const abort = readAbort = new AbortController();
        patch({ loading: true, error: "" });
        await reload(
            state.selectedId,
            abort.signal,
            () => !disposed && navigation === ticket,
        );
        if (!disposed && navigation === ticket) {
            await renewRestoredDraft(state.selectedId);
        }
        if (!disposed && navigation === ticket) patch({ loading: false });
    }
    function canManage(id: string, allowRestoration = false): boolean {
        if (!allowed()) return false;
        if (state.sending) {
            patch({ error: "请先停止生成，再管理会话" });
            return false;
        }
        if (
            !idle() || (state.attachmentsBusy &&
                !(allowRestoration && restoringDraft?.id === id))
        ) return false;
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
    /**
     * The effort menu works before the first message too: with no conversation
     * to persist onto, the choice is held and applied when the chat is created.
     */
    function chooseEffort(effort: "low" | "medium" | "high"): void {
        if (!allowed()) return;
        if (state.selectedId && state.conversation) {
            void updateSettings(state.selectedId, { reasoningEffort: effort });
            return;
        }
        patch({ pendingEffort: effort });
    }

    /** Fold a held effort choice into a freshly created conversation. */
    async function applyPendingEffort(
        conversation: ChatConversation,
    ): Promise<ChatConversation> {
        const effort = state.pendingEffort;
        const disabledTools = state.pendingDisabledTools ?? [];
        if (effort === "medium" && !disabledTools.length) return conversation;
        try {
            const saved = await api.updateSettings(
                conversation.id,
                {
                    reasoningEffort: effort,
                    ...(disabledTools.length ? { disabledTools } : {}),
                },
            );
            patch({ pendingEffort: "medium", pendingDisabledTools: [] });
            return saved;
        } catch (error) {
            // An explicitly disabled tool must never be exposed after a failed save.
            if (disabledTools.length) throw error;
            // The send must not fail over a cosmetic setting.
            return conversation;
        }
    }

    async function setToolEnabled(
        id: string,
        enabled: boolean,
    ): Promise<boolean> {
        if (
            !idle() || state.toolsBusy ||
            !state.tools.some((tool) => tool.id === id)
        ) return false;
        const current = state.conversation?.disabledTools ??
            state.pendingDisabledTools ?? [];
        const disabledTools = enabled
            ? current.filter((value) => value !== id)
            : [...new Set([...current, id])];
        if (!state.selectedId) {
            patch({ pendingDisabledTools: disabledTools });
            return true;
        }
        patch({ toolsBusy: true });
        try {
            return await updateSettings(state.selectedId, { disabledTools });
        } finally {
            patch({ toolsBusy: false });
        }
    }

    async function updateSettings(
        id: string,
        patchSettings: {
            readonly systemPrompt?: string;
            readonly reasoningEffort?: "low" | "medium" | "high" | null;
            readonly disabledTools?: readonly string[];
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
        if (!canManage(id, true)) return false;
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
            releaseOwnedDraftImages(draftFor(id).attachments);
            drafts.delete(id);
            writeStoredDraft(id, emptyDraft());
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
                    streamReasoning: "",
                    streamActivity: [],
                    streamCitations: [],
                    draft: draft.text,
                    attachments: draft.attachments,
                });
                onSelect?.("");
                const next =
                    conversations[Math.min(index, conversations.length - 1)];
                if (next) await select(next.id, true);
                else await renewRestoredDraft("");
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
    async function removeMessage(
        conversationId: string,
        messageId: string,
    ): Promise<boolean> {
        if (!canManage(conversationId)) return false;
        const abort = mutationAbort = new AbortController();
        patch({ managing: true, error: "" });
        try {
            const removed = await api.deleteMessage(
                conversationId,
                messageId,
                abort.signal,
            );
            if (disposed) return false;
            if (state.selectedId === conversationId) {
                const gone = new Set(removed);
                patch({
                    messages: state.messages.filter((message) =>
                        !gone.has(message.id)
                    ),
                });
                await reload(
                    conversationId,
                    abort.signal,
                    () => !disposed && state.selectedId === conversationId,
                );
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

    async function changeBranch(
        action: "switchBranch" | "fork",
        messageId: string,
    ): Promise<boolean> {
        const id = state.selectedId;
        if (!canManage(id)) return false;
        const abort = mutationAbort = new AbortController();
        patch({ managing: true, error: "" });
        try {
            const result = await api[action](id, messageId, abort.signal);
            if (disposed) return false;
            if (action === "fork") {
                rememberModel(result.conversation.id, state.model);
                beginNavigation();
                showConversation(result.conversation);
            }
            patch({
                ...result,
                conversations: upsert(result.conversation),
                streamText: "",
                toolCalls: [],
                streamReasoning: "",
                streamActivity: [],
                streamCitations: [],
            });
            return true;
        } catch (error) {
            patch({
                error: `${action === "fork" ? "创建分叉" : "切换分支"}失败：${
                    describe(error)
                }`,
            });
            return false;
        } finally {
            mutationAbort = undefined;
            patch({ managing: false });
        }
    }

    async function generate(
        type: "send" | "regenerate" | "continue" | "edit",
        messageId?: string,
        editedText?: string,
        onAccepted?: () => void,
    ): Promise<boolean> {
        if (!idle() || state.attachmentsBusy) return false;
        if (type === "send" && needsRestoration(state.selectedId)) {
            const id = state.selectedId;
            const ticket = navigation;
            if (
                !await renewRestoredDraft(id) || !idle() ||
                navigation !== ticket || state.selectedId !== id
            ) {
                return false;
            }
        }
        const targetIndex = messageId
            ? state.messages.findIndex((message) => message.id === messageId)
            : -1;
        const target = state.messages[targetIndex];
        const continuation = type === "continue"
            ? target ??
                state.messages.findLast((message) =>
                    message.role === "assistant" && !message.callId
                )
            : undefined;
        if (
            messageId &&
            (!target || target.callId ||
                (target.role !== "user" && target.role !== "assistant"))
        ) {
            patch({ error: "找不到可操作的消息，请刷新会话" });
            return false;
        }
        if (
            (type === "continue" || type === "regenerate") && target &&
            target.role !== "assistant"
        ) {
            patch({ error: "请选择一条助手回复" });
            return false;
        }
        if (
            (type !== "edit" || target?.role !== "assistant") &&
            (!state.model || !state.models.includes(state.model))
        ) {
            patch({ error: "请选择可用模型" });
            return false;
        }
        const draft = draftFor();
        if (type === "send") {
            if (!draft.text.trim()) {
                patch({ error: "请输入消息内容" });
                return false;
            }
            if (draft.text.trim().length > 100_000) {
                patch({ error: "消息不能超过 100,000 个字符" });
                return false;
            }
            try {
                validateChatAttachments(draft.attachments);
            } catch (error) {
                patch({ error: describe(error) });
                return false;
            }
        } else if (
            !state.conversation ||
            !state.messages.some((message) => message.role === "user")
        ) {
            patch({ error: "当前会话还没有可重新生成的消息" });
            return false;
        }
        if (
            type === "edit" &&
            (!target || !editedText?.trim() ||
                editedText.trim().length > 100_000)
        ) {
            patch({ error: "消息内容需为 1–100,000 个字符" });
            return false;
        }
        const model = state.model;
        const previousIds = new Set(
            state.messages.map((message) => message.id),
        );
        let interrupted = false;
        let accepted = false;
        const accept = () => {
            if (accepted) return;
            accepted = true;
            if (type === "send") forgetDraftImages(draft.attachments);
            if (
                type === "edit" || type === "regenerate" || type === "continue"
            ) {
                const lastUser = state.messages.findLastIndex((message) =>
                    message.role === "user"
                );
                const end = targetIndex >= 0
                    ? targetIndex
                    : type === "continue"
                    ? state.messages.length - 1
                    : lastUser + 1;
                patch({ messages: state.messages.slice(0, end) });
                if (type === "edit" && target?.role === "assistant") {
                    patch({ streamText: editedText!.trim() });
                }
            }
            onAccepted?.();
        };
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
            streamReasoning: "",
            streamActivity: [],
            streamCitations: [],
            suggestions: [],
        });
        try {
            if (!run.id) {
                patch({ creating: true });
                const created = await applyPendingEffort(
                    await api.create(run.abort.signal),
                );
                if (!currentRun(run)) return false;
                run.id = created.id;
                showConversation(created, true);
                patch({ creating: false });
            }
            if (run.stopped) return false;
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
                : type === "edit"
                ? {
                    type,
                    conversationId: run.id,
                    model,
                    messageId: messageId!,
                    text: editedText!.trim(),
                }
                : {
                    type,
                    conversationId: run.id,
                    model,
                    ...(messageId ? { messageId } : {}),
                };
            const receive = (event: ChatEvent) => {
                if (!currentRun(run)) return;
                if (
                    (event.type === "user" &&
                        event.message.conversationId === run.id) ||
                    event.type === "delta" || event.type === "tool" ||
                    event.type === "reasoning" || event.type === "activity" ||
                    event.type === "citations" || event.type === "done"
                ) accept();
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
                    if (type === "send" && drafts.get(run.id) === draft) {
                        editDraft(emptyDraft());
                    }
                } else if (event.type === "delta") {
                    patch({ streamText: state.streamText + event.text });
                } else if (event.type === "reasoning") {
                    patch({
                        streamReasoning: state.streamReasoning + event.text,
                    });
                } else if (event.type === "activity") {
                    patch({
                        streamActivity: [
                            ...state.streamActivity,
                            ...event.items,
                        ],
                    });
                } else if (event.type === "citations") {
                    patch({
                        streamCitations: [
                            ...state.streamCitations,
                            ...event.items,
                        ],
                    });
                } else if (event.type === "tool") {
                    const calls = new Map(
                        state.toolCalls.map((call) => [call.callId, call]),
                    );
                    for (const call of event.calls) {
                        calls.set(call.callId, call);
                    }
                    patch({ toolCalls: [...calls.values()] });
                } else if (event.type === "suggestions") {
                    patch({ suggestions: event.items });
                } else if (event.type === "done" && event.conversation) {
                    patch({
                        conversation: event.conversation,
                        conversations: upsert(event.conversation),
                    });
                }
            };
            run.stream = api.open(command, receive);
            interrupted = await run.stream.finished === "stopped";
            if (!interrupted && currentRun(run)) accept();
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
                    interrupted ? { previousIds, continuation } : undefined,
                );
                if (currentRun(run)) {
                    activeRun = undefined;
                    patch({ sending: false, stopping: false, loading: false });
                }
            }
        }
        return accepted;
    }
    const initialDraft = draftFor();
    state = {
        ...state,
        draft: initialDraft.text,
        attachments: initialDraft.attachments,
    };
    void renewRestoredDraft(state.selectedId);
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
        chooseEffort,
        setToolEnabled,
        replaceTools(tools) {
            if (!disposed) patch({ tools });
        },
        remove,
        removeMessage,
        select,
        refresh,
        switchBranch: (messageId) => changeBranch("switchBranch", messageId),
        forkMessage: (messageId) => changeBranch("fork", messageId),
        editMessage: (messageId, text) =>
            new Promise<boolean>((resolve) => {
                void generate("edit", messageId, text, () => resolve(true))
                    .then(resolve);
            }),
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
            const abort = uploadAbort = new AbortController();
            const uploaded: ChatAttachment[] = [];
            let retained = false;
            patch({ attachmentsBusy: true, error: "" });
            try {
                const attachments = await uploadChatAttachments(
                    files,
                    async (file) => {
                        const attachment = await api.upload(file, abort.signal);
                        uploaded.push(attachment);
                        return attachment;
                    },
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
                    retainDraftImages(uploaded);
                    editDraft({ ...current, attachments: combined });
                    retained = true;
                }
            } catch (error) {
                if (!disposed && ticket === attachmentRevision) {
                    patch({ error: describe(error) });
                }
            } finally {
                if (!retained) releaseDraftImages(uploaded);
                if (!disposed && ticket === attachmentRevision) {
                    patch({ attachmentsBusy: false });
                }
            }
        },
        async addReference(attachment) {
            if (!idle() || state.attachmentsBusy || !attachment.assetId) return;
            const draft = draftFor();
            if (
                draft.attachments.some((item) =>
                    item.assetId === attachment.assetId
                )
            ) return;
            const attachments = [...draft.attachments, attachment];
            try {
                validateChatAttachments(attachments);
            } catch (error) {
                patch({ error: describe(error) });
                return;
            }
            const ticket = ++attachmentRevision;
            const id = state.selectedId;
            const abort = uploadAbort = new AbortController();
            let acquired: ChatAttachment | undefined;
            let retained = false;
            patch({ attachmentsBusy: true, error: "" });
            try {
                acquired = await api.acquireAttachment(
                    attachment.assetId,
                    abort.signal,
                );
                if (
                    disposed || ticket !== attachmentRevision ||
                    id !== state.selectedId
                ) return;
                const current = draftFor();
                const combined = [...current.attachments, acquired];
                validateChatAttachments(combined);
                retainDraftImages([acquired]);
                editDraft({ ...current, attachments: combined });
                retained = true;
            } catch (error) {
                if (!disposed && ticket === attachmentRevision) {
                    patch({ error: describe(error) });
                }
            } finally {
                if (acquired && !retained) releaseDraftImages([acquired]);
                if (!disposed && ticket === attachmentRevision) {
                    patch({ attachmentsBusy: false });
                }
            }
        },
        removeAttachment(index) {
            if (disposed) return;
            attachmentRevision++;
            uploadAbort?.abort();
            restoringDraft = undefined;
            const removed = draftFor().attachments[index];
            if (removed && !state.sending) releaseOwnedDraftImages([removed]);
            editDraft({
                ...draftFor(),
                attachments: draftFor().attachments.filter((_, i) =>
                    i !== index
                ),
            });
            patch({ attachmentsBusy: false });
        },
        send: async () => {
            await generate("send");
        },
        regenerate: async (messageId) => {
            await generate("regenerate", messageId);
        },
        continueMessage: async (messageId) => {
            await generate("continue", messageId);
        },
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
            uploadAbort?.abort();
            cancelRun();
            drafts.clear();
            ownedLeases.clear();
            listeners.clear();
        },
    };
}
