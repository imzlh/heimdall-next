import type { KernelRuntime } from "@heimdall/kernel";
import type { RequestContext } from "@heimdall/contracts";
import type {
    ChatAttachment,
    ChatMessageRecord,
    ChatStore,
    ConversationRecord,
} from "@heimdall/storage";
import { StorageNotFoundError } from "@heimdall/storage";
import type {
    ContentPart,
    OperationRequest,
    ToolDefinition,
} from "@heimdall/hip";
import { base64ToBytes } from "@heimdall/hip";
import {
    type ChatToolProvider,
    createChatToolset,
    newRunBudget,
} from "./tools/toolset.ts";
import {
    MAX_HISTORY_MESSAGES,
    MAX_HISTORY_TEXT_CHARS,
    MAX_TOOL_CALLS_PER_ROUND,
    MAX_TOOL_ROUNDS,
} from "./constants.ts";
import { boundHistory } from "./history.ts";
import {
    ChatResponse,
    type ChatResponseActivity,
    type ChatResponseCitation,
    type ChatResponseImage,
    type ChatResponseQuota,
    type ChatToolCall,
} from "./response.ts";
import { withConversationRun } from "./runs.ts";
import type { ChatAssetService } from "./assets.ts";
import { ChatRouteError } from "./errors.ts";
import { presentConversation } from "./branches.ts";
import { chatChildContext, chatCommandContext } from "./context.ts";

export interface ChatServiceOptions {
    readonly runtime: KernelRuntime;
    readonly store: ChatStore;
    readonly now?: () => Date;
    /** Host-registered capabilities, resolved once at the beginning of a turn. */
    readonly tools?: ChatToolProvider;
    readonly assets?: ChatAssetService;
    /**
     * Optional cheap model id for generating a conversation title when the
     * upstream provides none. Falls back to the conversation's own model when it
     * returns undefined.
     */
    readonly titleModel?: () => string | undefined;
}

type ToolCallRecord = ChatToolCall;

interface CompletionOutcome {
    text: string;
    cancelled: boolean;
    toolCalls: ToolCallRecord[];
    error?: ChatRouteError;
    /** Provider-suggested conversation title, or "" when none was streamed. */
    serverTitle?: string;
    /** Provider-suggested follow-up prompts. */
    suggestions?: readonly string[];
    /** Provider-generated images produced during the turn. */
    images?: readonly ChatResponseImage[];
    /** Public reasoning transcript, "" when none was streamed. */
    reasoning?: string;
    /** Cloud-activity status lines (searches, etc.). */
    activity?: readonly ChatResponseActivity[];
    /** Sources the reply cited. */
    citations?: readonly ChatResponseCitation[];
    /** Per-turn account quota snapshot, when the source reported one. */
    quota?: ChatResponseQuota;
}

interface TurnSettings {
    readonly systemPrompt?: string;
    readonly reasoningEffort?: "low" | "medium" | "high";
}

async function complete(
    runtime: KernelRuntime,
    history: readonly ChatMessageRecord[],
    model: string,
    context: RequestContext,
    onDelta?: (text: string) => void,
    tools?: readonly ToolDefinition[],
    settings?: TurnSettings,
    assets?: ChatAssetService,
    onMeta?: (event: unknown) => void,
): Promise<{
    text: string;
    cancelled: boolean;
    toolCalls: ToolCallRecord[];
    error?: ChatRouteError;
    serverTitle: string;
    suggestions: readonly string[];
    images: readonly ChatResponseImage[];
    reasoning: string;
    activity: readonly ChatResponseActivity[];
    citations: readonly ChatResponseCitation[];
    quota?: ChatResponseQuota;
}> {
    const { requestId, signal } = context;
    // The conversation-level system prompt joins the window before bounding so
    // the oldest turns, not the prompt, give way to the character budget.
    const withSystem = settings?.systemPrompt
        ? [
            {
                id: "system-prompt",
                conversationId: "",
                role: "system" as const,
                text: settings.systemPrompt,
                createdAt: "",
            },
            ...history,
        ]
        : history;
    const bounded = boundHistory(
        withSystem,
        MAX_HISTORY_MESSAGES,
        MAX_HISTORY_TEXT_CHARS,
    );
    const request: OperationRequest = {
        version: 1,
        requestId,
        operation: "generation.create",
        metadata: context.metadata,
        payload: {
            model,
            stream: onDelta !== undefined,
            messages: await Promise.all(bounded.map(async (item) => ({
                id: item.id,
                role: item.role,
                parts: await messageParts(item, assets),
            }))),
            ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
            ...(settings?.reasoningEffort
                ? {
                    extensions: {
                        raw: { reasoning_effort: settings.reasoningEffort },
                    },
                }
                : {}),
        },
        traits: { model, streaming: onDelta !== undefined },
    };
    const lifecycle = runtime.createLifecycle(request, signal);
    const response = new ChatResponse();
    let cancelled = false;
    let failure: ChatRouteError | undefined;
    try {
        const execution = await runtime.run(request, lifecycle, {
            requestContext: context,
        });
        for await (const frame of execution.frames) {
            const event = frame.event;
            // Snapshot the meta accumulators so any growth this frame caused can
            // be streamed live — the model's thinking and search activity land
            // before the first answer token, explaining the wait.
            const reasoned = response.reasoning.length;
            const activities = response.activity.length;
            const cited = response.citations.length;
            const hadQuota = response.quota !== undefined;
            const delta = response.append(event);
            if (delta.length > 0) onDelta?.(delta);
            if (onMeta) {
                if (response.reasoning.length > reasoned) {
                    onMeta({
                        type: "reasoning",
                        text: response.reasoning.slice(reasoned),
                    });
                }
                const newActivity = response.activity.slice(activities);
                if (newActivity.length > 0) {
                    onMeta({
                        type: "activity",
                        items: newActivity.map((item) => ({ ...item })),
                    });
                }
                const newCitations = response.citations.slice(cited);
                if (newCitations.length > 0) {
                    onMeta({
                        type: "citations",
                        items: newCitations.map((item) => ({ ...item })),
                    });
                }
                const quota = response.quota;
                if (!hadQuota && quota) {
                    onMeta({
                        type: "quota",
                        quota: {
                            meters: quota.meters.map((meter) => ({ ...meter })),
                        },
                    });
                }
            }
            if (event.kind === "run.cancelled") {
                cancelled = true;
                break;
            }
            if (event.kind === "run.error") {
                throw new ChatRouteError(
                    502,
                    event.error.code || "upstream_error",
                    event.error.message || "generation failed",
                );
            }
        }
    } catch (error) {
        // The kernel interrupts pending reads with the caller's abort reason;
        // providers need not produce a final run.cancelled frame. Preserve the
        // visible partial reply and the chat protocol's stopped outcome.
        if (signal.aborted && error === signal.reason) cancelled = true;
        else {
            failure = error instanceof ChatRouteError
                ? error
                : new ChatRouteError(
                    502,
                    "upstream_error",
                    error instanceof Error
                        ? error.message
                        : "generation failed",
                );
        }
    }
    return {
        text: response.text,
        cancelled,
        // An interrupted tool call may contain incomplete arguments. Only a
        // completed model round can commit calls to history or execute them.
        toolCalls: failure || cancelled ? [] : response.toolCalls,
        serverTitle: response.title,
        suggestions: response.suggestions,
        images: failure || cancelled ? [] : response.images,
        reasoning: failure || cancelled ? "" : response.reasoning,
        activity: failure || cancelled ? [] : response.activity,
        citations: failure || cancelled ? [] : response.citations,
        ...(failure || cancelled
            ? {}
            : response.quota
            ? { quota: response.quota }
            : {}),
        ...(failure ? { error: failure } : {}),
    };
}

export interface ChatRunCommand {
    readonly type: "send" | "regenerate" | "continue" | "edit";
    readonly conversationId: string;
    readonly model?: string;
    readonly text?: string;
    readonly messageId?: string;
    readonly attachments?: readonly ChatAttachment[];
}

export interface StoredTurn {
    messages: ChatMessageRecord[];
    toolCalls: ToolCallRecord[];
    cancelled: boolean;
}

export async function withChatConversation<T>(
    store: ChatStore,
    id: string,
    run: () => T | Promise<T>,
): Promise<T> {
    try {
        return await withConversationRun(store, id, run);
    } catch (error) {
        if (error instanceof StorageNotFoundError) {
            throw new ChatRouteError(404, "not_found", error.message);
        }
        throw error;
    }
}

export function requireConversation(
    store: ChatStore,
    id: string,
): ConversationRecord {
    const conversation = store.getConversation(id);
    if (!conversation) {
        throw new ChatRouteError(
            404,
            "not_found",
            "conversation not found: " + id,
        );
    }
    return conversation;
}

export async function presentMessages(
    options: ChatServiceOptions,
    messages: readonly ChatMessageRecord[],
) {
    return options.assets
        ? await options.assets.presentMessages(messages, options.store)
        : messages;
}

/** HTTP and WebSocket use the same locked state transitions and history. */
export async function executeCommand(
    options: ChatServiceOptions,
    command: ChatRunCommand,
    context: RequestContext,
    emit?: (payload: unknown) => void,
): Promise<StoredTurn> {
    return await withChatConversation(
        options.store,
        command.conversationId,
        async () => {
            const now = options.now ?? (() => new Date());
            const conversation = requireConversation(
                options.store,
                command.conversationId,
            );
            let history = options.store.listMessages(conversation.id);
            let continuation: ChatMessageRecord | undefined;
            let variantOf: string | undefined;
            const created: ChatMessageRecord[] = [];
            if (command.type === "send") {
                const attachments = options.assets
                    ? await options.assets.normalizeAttachments(
                        command.attachments ?? [],
                    )
                    : command.attachments;
                const user = {
                    ...message(
                        conversation.id,
                        "user",
                        command.text!,
                        now().toISOString(),
                        attachments,
                    ),
                    parentId: history.at(-1)?.id ?? null,
                };
                options.store.addMessage(user);
                options.assets?.consumeLeases(
                    command.attachments ?? [],
                    options.store,
                );
                history = options.store.listMessages(conversation.id);
                created.push(user);
                if (emit) {
                    emit({
                        type: "user",
                        message: (await presentMessages(options, [user]))[0],
                    });
                }
            } else {
                const target = command.messageId
                    ? options.store.messagePath(
                        conversation.id,
                        command.messageId,
                    ).at(-1)!
                    : [...history].reverse().find((row) =>
                        row.role === "assistant" && !row.callId
                    );
                if (command.type === "edit") {
                    if (
                        !target ||
                        (target.role !== "user" &&
                            target.role !== "assistant") ||
                        target.callId
                    ) {
                        throw new ChatRouteError(
                            400,
                            "invalid_request",
                            "only user and assistant text messages can be edited",
                        );
                    }
                    if (target.role === "user" && !command.model) {
                        throw new ChatRouteError(
                            400,
                            "invalid_request",
                            "model is required",
                        );
                    }
                    const path = options.store.messagePath(
                        conversation.id,
                        target.id,
                    );
                    const edited: ChatMessageRecord = {
                        ...message(
                            conversation.id,
                            target.role,
                            command.text!,
                            now().toISOString(),
                            target.attachments,
                        ),
                        parentId: target.parentId ?? null,
                        variantOf: target.id,
                        ...(target.role === "assistant"
                            ? { status: "completed" as const }
                            : {}),
                    };
                    options.store.appendMessages([edited], {
                        updatedAt: edited.createdAt,
                    });
                    created.push(edited);
                    history = [...path.slice(0, -1), edited];
                    if (target.role === "assistant") {
                        emit?.({
                            type: "done",
                            conversation: presentConversation(
                                options.store,
                                conversation.id,
                            ),
                        });
                        return {
                            messages: [
                                ...options.store.listMessages(conversation.id),
                            ],
                            toolCalls: [],
                            cancelled: false,
                        };
                    }
                    if (emit) {
                        emit({
                            type: "user",
                            message:
                                (await presentMessages(options, [edited]))[0],
                        });
                    }
                } else if (command.type === "continue") {
                    if (
                        !target || target.role !== "assistant" ||
                        target.callId || !target.text.trim()
                    ) {
                        throw new ChatRouteError(
                            400,
                            "invalid_request",
                            "conversation has no assistant message to continue",
                        );
                    }
                    continuation = target;
                    variantOf = target.id;
                    history = options.store.messagePath(
                        conversation.id,
                        target.id,
                    );
                    emit?.({ type: "delta", text: target.text });
                } else {
                    if (command.messageId) {
                        if (
                            !target || target.role !== "assistant" ||
                            target.callId
                        ) {
                            throw new ChatRouteError(
                                400,
                                "invalid_request",
                                "only assistant text messages can be regenerated",
                            );
                        }
                        history = options.store.messagePath(
                            conversation.id,
                            target.id,
                        ).slice(0, -1);
                        variantOf = target.id;
                    } else {
                        // Legacy callers retry the most recent user turn, including a failed
                        // attempt which has not produced any assistant text yet.
                        const index = history.findLastIndex((row) =>
                            row.role === "user"
                        );
                        if (index < 0) {
                            throw new ChatRouteError(
                                400,
                                "invalid_request",
                                "conversation has no user message to regenerate",
                            );
                        }
                        variantOf = history[index + 1]?.id;
                        history = history.slice(0, index + 1);
                        created.push(history.at(-1)!);
                    }
                }
            }
            const outcome = await settleTurn(
                options,
                conversation,
                history,
                command.model!,
                chatCommandContext(context, conversation.id, command.type),
                emit ? (text) => emit({ type: "delta", text }) : undefined,
                continuation,
                variantOf,
                emit,
            );
            if (outcome.toolCalls.length) {
                emit?.({
                    type: "tool",
                    calls: outcome.toolCalls,
                });
            }
            if (!outcome.cancelled && outcome.suggestions.length > 0) {
                emit?.({
                    type: "suggestions",
                    items: [...outcome.suggestions],
                });
            }
            emit?.(
                outcome.cancelled ? { type: "stopped" } : {
                    type: "done",
                    conversation: presentConversation(
                        options.store,
                        conversation.id,
                    ),
                },
            );
            return { ...outcome, messages: [...created, ...outcome.messages] };
        },
    );
}

function message(
    conversationId: string,
    role: ChatMessageRecord["role"],
    text: string,
    createdAt: string,
    attachments: readonly ChatAttachment[] = [],
    tool?: { readonly callId: string; readonly name: string },
): ChatMessageRecord {
    return {
        id: crypto.randomUUID(),
        conversationId,
        role,
        text,
        createdAt,
        ...(tool === undefined ? {} : tool),
        ...(attachments.length === 0 ? {} : { attachments }),
    };
}

async function settleTurn(
    options: ChatServiceOptions,
    conversation: ConversationRecord,
    history: readonly ChatMessageRecord[],
    model: string,
    context: RequestContext,
    onDelta?: (text: string) => void,
    continuation?: ChatMessageRecord,
    variantOf?: string,
    emit?: (payload: unknown) => void,
): Promise<{
    messages: ChatMessageRecord[];
    toolCalls: ToolCallRecord[];
    cancelled: boolean;
    suggestions: readonly string[];
}> {
    const { signal } = context;
    const now = options.now ?? (() => new Date());
    // A brand-new conversation still carries the placeholder title; only then do
    // we apply a server-provided or generated title over the first-user-text
    // baseline that storeReply sets.
    const wasNewConversation = conversation.title === "新对话";
    const firstUser = firstUserText(history);
    // Per-conversation switches hide whole tool plugins from the model.
    const providers = typeof options.tools === "function"
        ? options.tools()
        : options.tools;
    const toolset = createChatToolset(
        (providers ?? []).filter((plugin) =>
            !conversation.disabledTools?.includes(plugin.manifest.id)
        ),
    );
    const budget = newRunBudget();
    const settings: TurnSettings = {
        ...(conversation.systemPrompt
            ? { systemPrompt: conversation.systemPrompt }
            : {}),
        ...(conversation.reasoningEffort
            ? { reasoningEffort: conversation.reasoningEffort }
            : {}),
    };
    const created: ChatMessageRecord[] = [];
    const working: ChatMessageRecord[] = [...history];
    let titleText = firstUserText(history);
    let serverTitle = "";
    let suggestions: readonly string[] = [];
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const roundContext = round === 0
            ? context
            : chatChildContext(context, `tool:${round}`);
        const result = await complete(
            options.runtime,
            working,
            model,
            roundContext,
            onDelta,
            toolset.definitions,
            settings,
            options.assets,
            emit,
        );
        if (result.serverTitle) serverTitle = result.serverTitle;
        if (result.suggestions.length > 0) suggestions = result.suggestions;
        if (
            round === 0 && continuation &&
            (result.text.length > 0 || result.toolCalls.length > 0)
        ) {
            result.text = continuation.text + result.text;
        }
        // Persist generated images as chat assets (files), like v1: the source
        // handed us buffers; the kernel kept none. Failures skip the image only.
        const replyImages = options.assets && result.images?.length
            ? await uploadReplyImages(options.assets, result.images)
            : [];
        const reply = storeReply(
            options.store,
            conversation,
            titleText,
            result,
            now,
            round === 0 && continuation
                ? continuation.parentId ?? null
                : working.at(-1)?.id ?? null,
            round === 0 ? variantOf : undefined,
            replyImages,
        );
        if (replyImages.length > 0) {
            options.assets?.consumeLeases(replyImages, options.store);
        }
        created.push(...reply);
        // The new continuation is a sibling of the original reply, not an
        // extra prefix in the next tool round's model history.
        if (round === 0 && continuation && reply.length > 0) working.pop();
        working.push(...reply);
        titleText = "";
        if (result.error) throw result.error;
        if (result.cancelled) {
            return {
                messages: created,
                toolCalls: [],
                cancelled: true,
                suggestions: [],
            };
        }
        const serverCalls = result.toolCalls.filter((call) =>
            toolset.isServerTool(call.name)
        );
        const clientCalls = result.toolCalls.filter((call) =>
            !toolset.isServerTool(call.name)
        );
        if (serverCalls.length === 0) {
            await finalizeTitle(
                options,
                conversation,
                wasNewConversation,
                serverTitle,
                firstUser,
                result.text,
                model,
                context,
                now,
            );
            return {
                messages: created,
                toolCalls: clientCalls,
                cancelled: false,
                suggestions,
            };
        }
        for (const call of serverCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND)) {
            const outcome = await toolset.run(call, budget, signal, {
                requestId: roundContext.requestId,
                metadata: roundContext.metadata,
            });
            const row = toolResultMessage(
                conversation.id,
                call,
                outcome.text,
                now,
            );
            const linked = { ...row, parentId: working.at(-1)?.id ?? null };
            options.store.addMessage(linked);
            created.push(linked);
            working.push(linked);
        }
    }
    return {
        messages: created,
        toolCalls: [],
        cancelled: false,
        suggestions,
    };
}

/** Persist generated reply images as chat assets; skip any the store rejects. */
async function uploadReplyImages(
    assets: ChatAssetService,
    images: readonly ChatResponseImage[],
): Promise<ChatAttachment[]> {
    const attachments: ChatAttachment[] = [];
    for (const image of images) {
        try {
            attachments.push(
                await assets.upload(image.data, image.mediaType),
            );
        } catch {
            // Unsupported media type or oversize image: keep the text reply.
        }
    }
    return attachments;
}

function storeReply(
    store: ChatStore,
    conversation: ConversationRecord,
    userText: string,
    result: CompletionOutcome,
    now: () => Date,
    parentId: string | null,
    variantOf?: string,
    attachments: readonly ChatAttachment[] = [],
): ChatMessageRecord[] {
    const created: ChatMessageRecord[] = [];
    const reasoning = result.reasoning?.trim() ?? "";
    const activity = result.activity ?? [];
    const citations = result.citations ?? [];
    const quota = result.quota;
    // Failed and stopped turns persist their visible output together with the
    // outcome status; an outcome with no text (a bare stop or a failure before
    // the first delta) leaves no empty row behind. Generated images, reasoning,
    // search activity or citations alone also warrant a row so a non-text reply
    // (e.g. an image-only or search-only turn) is not dropped.
    if (
        result.text.length > 0 || attachments.length > 0 ||
        reasoning.length > 0 || activity.length > 0 || citations.length > 0
    ) {
        const assistant: ChatMessageRecord = {
            ...message(
                conversation.id,
                "assistant",
                result.text,
                now().toISOString(),
                attachments,
            ),
            parentId,
            ...(variantOf ? { variantOf } : {}),
            ...(reasoning.length > 0 ? { reasoning } : {}),
            ...(activity.length > 0
                ? { activity: activity.map((item) => ({ ...item })) }
                : {}),
            ...(citations.length > 0
                ? { citations: citations.map((item) => ({ ...item })) }
                : {}),
            ...(quota
                ? {
                    quota: {
                        meters: quota.meters.map((item) => ({ ...item })),
                    },
                }
                : {}),
            status: result.error
                ? "failed"
                : result.cancelled
                ? "stopped"
                : "completed",
            ...(result.error
                ? {
                    error: {
                        code: result.error.code,
                        message: result.error.message,
                    },
                }
                : {}),
        };
        created.push(assistant);
        parentId = assistant.id;
    }
    for (const call of result.toolCalls) {
        const callRow = message(
            conversation.id,
            "assistant",
            call.argumentsText,
            now().toISOString(),
            [],
            { callId: call.callId, name: call.name },
        );
        created.push({
            ...callRow,
            parentId,
            ...(created.length === 0 && variantOf ? { variantOf } : {}),
        });
        parentId = callRow.id;
    }
    const last = created.at(-1);
    if (last !== undefined) {
        store.appendMessages(created, {
            title: conversation.title === "新对话" && userText.trim().length > 0
                ? userText.trim().slice(0, 80)
                : undefined,
            updatedAt: last.createdAt,
        });
    }
    return created;
}

function toolResultMessage(
    conversationId: string,
    call: ToolCallRecord,
    text: string,
    now: () => Date,
): ChatMessageRecord {
    return message(conversationId, "tool", text, now().toISOString(), [], {
        callId: call.callId,
        name: call.name,
    });
}

function firstUserText(history: readonly ChatMessageRecord[]): string {
    return [...history].reverse().find((item) => item.role === "user")?.text ??
        "";
}

const TITLE_INSTRUCTION =
    "用与对话相同的语言为下面的对话起一个不超过 6 个词的简短标题。只返回标题本身，不要引号、标点或多余说明。";

/**
 * Set a server-provided or generated title over the first-user-text baseline,
 * but only for a brand-new conversation. Any failure is swallowed so the turn
 * still succeeds with the baseline title.
 */
async function finalizeTitle(
    options: ChatServiceOptions,
    conversation: ConversationRecord,
    wasNewConversation: boolean,
    serverTitle: string,
    firstUser: string,
    replyText: string,
    model: string,
    context: RequestContext,
    now: () => Date,
): Promise<void> {
    if (!wasNewConversation) return;
    let title = serverTitle.trim();
    if (!title && replyText.trim().length > 0) {
        title = await generateTitle(
            options,
            options.titleModel?.() || model,
            firstUser,
            replyText,
            context,
        );
    }
    title = sanitizeTitle(title);
    if (title.length === 0) return;
    options.store.updateConversation(conversation.id, {
        title,
        updatedAt: now().toISOString(),
    });
}

/** One short non-streaming completion that summarizes the turn into a title. */
async function generateTitle(
    options: ChatServiceOptions,
    model: string,
    firstUser: string,
    reply: string,
    context: RequestContext,
): Promise<string> {
    const prompt = `${TITLE_INSTRUCTION}\n\n用户：${
        firstUser.slice(0, 2000)
    }\n助手：${reply.slice(0, 2000)}`;
    const history: ChatMessageRecord[] = [{
        id: "title-request",
        conversationId: "",
        role: "user",
        text: prompt,
        createdAt: "",
    }];
    try {
        const result = await complete(
            options.runtime,
            history,
            model,
            chatChildContext(context, "title", "chat.title"),
        );
        return result.error || result.cancelled ? "" : result.text;
    } catch {
        // A failed title request must never fail the turn; keep the baseline.
        return "";
    }
}

function sanitizeTitle(value: string): string {
    const collapsed = value.trim().replace(/\s+/g, " ");
    // Models often wrap the title in quotes or fancy brackets; strip them.
    const stripped = collapsed.replace(
        /^["'“”「」『』\s]+|["'“”「」『』\s]+$/g,
        "",
    );
    return stripped.slice(0, 80).trim();
}

async function messageParts(
    item: ChatMessageRecord,
    assets?: ChatAssetService,
): Promise<ContentPart[]> {
    if (item.role === "tool" && item.callId !== undefined) {
        return [{
            id: `${item.id}:result`,
            type: "tool_result",
            callId: item.callId,
            result: item.text,
        }];
    }
    if (item.callId !== undefined && item.name !== undefined) {
        return [{
            id: `${item.id}:call`,
            type: "tool_call",
            callId: item.callId,
            name: item.name,
            argumentsText: item.text,
            status: "completed",
        }];
    }
    const parts: ContentPart[] = [];
    if (item.text.length > 0 || (item.attachments ?? []).length === 0) {
        parts.push({ id: `${item.id}:text`, type: "text", text: item.text });
    }
    if (assets) {
        parts.push(...await assets.imageParts(item.id, item.attachments ?? []));
        return parts;
    }
    for (const [index, attachment] of (item.attachments ?? []).entries()) {
        if (!attachment.dataBase64) {
            throw new ChatRouteError(
                503,
                "unavailable",
                "chat image assets are unavailable",
            );
        }
        parts.push({
            id: `${item.id}:image:${index}`,
            type: "image",
            source: {
                mediaType: attachment.mediaType,
                data: base64ToBytes(attachment.dataBase64),
            },
        });
    }
    return parts;
}
