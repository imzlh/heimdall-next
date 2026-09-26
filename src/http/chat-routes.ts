import { Hono } from "hono";
import type { Context } from "hono";
import { upgradeWebSocket } from "hono/deno";
import type { KernelRuntime } from "@heimdall/kernel";
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
import type { ServerApp, ServerEnv } from "./app.ts";
import {
    type ChatToolProvider,
    createChatToolset,
    newRunBudget,
} from "../chat/tools/toolset.ts";
import {
    MAX_HISTORY_MESSAGES,
    MAX_HISTORY_TEXT_CHARS,
    MAX_TOOL_CALLS_PER_ROUND,
    MAX_TOOL_ROUNDS,
} from "../chat/constants.ts";
import { boundHistory } from "../chat/history.ts";
import { ChatResponse, type ChatToolCall } from "../chat/response.ts";
import { withConversationRun } from "../chat/runs.ts";
import { chatSocketProtocol } from "./chat-auth.ts";

const REQUEST_ID = "x-heimdall-request-id";
const TEXT_LIMIT = 100_000;
const SYSTEM_PROMPT_LIMIT = 8_000;

export interface ChatRouteOptions {
    readonly runtime: KernelRuntime;
    readonly store: ChatStore;
    readonly now?: () => Date;
    /** Host-registered capabilities, resolved once at the beginning of a turn. */
    readonly tools?: ChatToolProvider;
}

/**
 * Single-tenant chat API. HTTP stores a full turn. `/regenerate` repeats the
 * latest user turn and drops the previous reply. The WebSocket at `/socket`
 * streams deltas and accepts `stop` and `regenerate`. Registered tools execute
 * through the capability boundary; other calls return to the client. Image attachments
 * are stored with the user message and sent to the kernel as image parts.
 */
export function createChatRoutes(options: ChatRouteOptions): ServerApp {
    const now = options.now ?? (() => new Date());
    const app = new Hono<ServerEnv>();

    app.post("/conversations", (context) => {
        const requestId = currentRequestId(context);
        const record = options.store.createConversation(
            "新对话",
            now().toISOString(),
        );
        return json(requestId, { conversation: record }, 201);
    });

    app.get("/conversations", (context) => {
        const requestId = currentRequestId(context);
        return json(requestId, {
            conversations: options.store.listConversations(),
        });
    });

    app.get("/conversation", (context) => {
        const requestId = currentRequestId(context);
        const id = requiredQuery(context, "id");
        const conversation = options.store.getConversation(id);
        if (conversation === null) {
            return errorResponse(
                requestId,
                404,
                "not_found",
                `conversation not found: ${id}`,
            );
        }
        return json(requestId, {
            conversation,
            messages: options.store.listMessages(id),
        });
    });

    app.patch("/conversation", async (context) => {
        const requestId = currentRequestId(context);
        const id = requiredQuery(context, "id");
        const body = await readJsonBody(context);
        const hasTitle = body.title !== undefined;
        const hasSystemPrompt = body.systemPrompt !== undefined;
        const hasEffort = body.reasoningEffort !== undefined;
        if (!hasTitle && !hasSystemPrompt && !hasEffort) {
            throw new ChatRouteError(
                400,
                "invalid_request",
                "nothing to update",
            );
        }
        let title: string | undefined;
        if (hasTitle) {
            title = requiredString(body.title, "title");
            if (title.length > 120) {
                throw new ChatRouteError(
                    400,
                    "invalid_request",
                    "title must be at most 120 characters",
                );
            }
        }
        let systemPrompt: string | undefined;
        if (hasSystemPrompt) {
            if (typeof body.systemPrompt !== "string") {
                throw new ChatRouteError(
                    400,
                    "invalid_request",
                    "systemPrompt must be a string",
                );
            }
            systemPrompt = body.systemPrompt;
            if (systemPrompt.length > SYSTEM_PROMPT_LIMIT) {
                throw new ChatRouteError(
                    413,
                    "payload_too_large",
                    `systemPrompt must be at most ${SYSTEM_PROMPT_LIMIT} characters`,
                );
            }
        }
        let reasoningEffort: string | undefined;
        if (hasEffort) {
            if (body.reasoningEffort === null) reasoningEffort = "";
            else if (
                body.reasoningEffort === "low" ||
                body.reasoningEffort === "medium" ||
                body.reasoningEffort === "high"
            ) reasoningEffort = body.reasoningEffort;
            else {
                throw new ChatRouteError(
                    400,
                    "invalid_request",
                    "reasoningEffort must be low, medium, high or null",
                );
            }
        }
        return await withConversationRun(options.store, id, () => {
            const conversation = options.store.getConversation(id);
            if (conversation === null) {
                return errorResponse(
                    requestId,
                    404,
                    "not_found",
                    `conversation not found: ${id}`,
                );
            }
            const updatedAt = now().toISOString();
            options.store.updateConversation(id, {
                updatedAt,
                ...(title === undefined ? {} : { title }),
                ...(systemPrompt === undefined ? {} : { systemPrompt }),
                ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            });
            return json(requestId, {
                conversation: options.store.getConversation(id),
            });
        });
    });

    app.delete("/conversation", async (context) => {
        const requestId = currentRequestId(context);
        const id = requiredQuery(context, "id");
        return await withConversationRun(options.store, id, () => {
            if (options.store.getConversation(id) === null) {
                return errorResponse(
                    requestId,
                    404,
                    "not_found",
                    `conversation not found: ${id}`,
                );
            }
            options.store.deleteConversation(id);
            return json(requestId, { deleted: true, id });
        });
    });

    app.post("/message", async (context) => {
        const requestId = currentRequestId(context);
        const body = await readJsonBody(context);
        const conversationId = requiredString(
            body.conversationId,
            "conversationId",
        );
        const model = requiredString(body.model, "model");
        const text = requiredString(body.text, "text");
        const attachments = readAttachments(body.attachments);
        if (text.length > TEXT_LIMIT) {
            throw new ChatRouteError(
                413,
                "payload_too_large",
                "message is too large",
            );
        }
        const conversation = options.store.getConversation(conversationId);
        if (conversation === null) {
            return errorResponse(
                requestId,
                404,
                "not_found",
                `conversation not found: ${conversationId}`,
            );
        }
        try {
            return await withConversationRun(
                options.store,
                conversationId,
                async () => {
                    const user = message(
                        conversationId,
                        "user",
                        text,
                        now().toISOString(),
                        attachments,
                    );
                    options.store.addMessage(user);
                    const history = options.store.listMessages(conversationId);
                    const outcome = await settleTurn(
                        options,
                        conversation,
                        history,
                        model,
                        requestId,
                        context.req.raw.signal,
                    );
                    return json(requestId, {
                        conversation: options.store.getConversation(
                            conversationId,
                        ),
                        messages: [user, ...outcome.messages],
                        toolCalls: outcome.toolCalls,
                    });
                },
            );
        } catch (error) {
            if (error instanceof ChatRouteError) throw error;
            if (error instanceof StorageNotFoundError) {
                throw new ChatRouteError(404, "not_found", error.message);
            }
            throw error;
        }
    });

    app.post("/regenerate", async (context) => {
        const requestId = currentRequestId(context);
        const body = await readJsonBody(context);
        const conversationId = requiredString(
            body.conversationId,
            "conversationId",
        );
        const model = requiredString(body.model, "model");
        try {
            const replaced = await withConversationRun(
                options.store,
                conversationId,
                () =>
                    replaceLatestTurn(
                        options,
                        conversationId,
                        model,
                        requestId,
                        context.req.raw.signal,
                    ),
            );
            return json(requestId, {
                conversation: options.store.getConversation(conversationId),
                messages: [replaced.user, ...replaced.outcome.messages],
                toolCalls: replaced.outcome.toolCalls,
            });
        } catch (error) {
            if (error instanceof ChatRouteError) throw error;
            if (error instanceof StorageNotFoundError) {
                throw new ChatRouteError(404, "not_found", error.message);
            }
            throw error;
        }
    });

    app.get(
        "/socket",
        (context, next) =>
            upgradeWebSocket(() => {
                let active: AbortController | undefined;
                let busy = false;
                let closed = false;
                return {
                    onMessage(event, socket) {
                        const send = (payload: unknown): void => {
                            if (closed || socket.readyState !== 1) return;
                            try {
                                socket.send(socketJson(payload));
                            } catch {
                                closed = true;
                                active?.abort();
                            }
                        };
                        const parsed = parseSocketEvent(event.data);
                        if (parsed === undefined) {
                            send({
                                type: "error",
                                message: "invalid json",
                            });
                            return;
                        }
                        if (parsed.type === "stop") {
                            active?.abort();
                            return;
                        }
                        if (
                            parsed.type !== "send" &&
                            parsed.type !== "regenerate"
                        ) {
                            send({
                                type: "error",
                                message: "unsupported event",
                            });
                            return;
                        }
                        if (busy) {
                            send({
                                type: "error",
                                code: "run_in_progress",
                                status: 409,
                                message: "a run is already active",
                            });
                            return;
                        }
                        busy = true;
                        const controller = new AbortController();
                        active = controller;
                        const run = parsed.type === "send"
                            ? handleSocketSend(
                                options,
                                parsed,
                                controller.signal,
                                send,
                            )
                            : handleSocketRegenerate(
                                options,
                                parsed,
                                controller.signal,
                                send,
                            );
                        void run.catch((error) => {
                            send(socketError(error));
                        }).finally(() => {
                            busy = false;
                            if (active === controller) active = undefined;
                        });
                    },
                    onClose() {
                        closed = true;
                        active?.abort();
                    },
                    onError() {
                        closed = true;
                        active?.abort();
                    },
                };
            }, { protocol: chatSocketProtocol(context.req.raw) })(
                context,
                next,
            ),
    );

    return app;
}

type ToolCallRecord = ChatToolCall;

interface CompletionOutcome {
    text: string;
    cancelled: boolean;
    toolCalls: ToolCallRecord[];
    error?: ChatRouteError;
}

interface TurnSettings {
    readonly systemPrompt?: string;
    readonly reasoningEffort?: "low" | "medium" | "high";
}

async function complete(
    runtime: KernelRuntime,
    history: readonly ChatMessageRecord[],
    model: string,
    requestId: string,
    signal: AbortSignal,
    onDelta?: (text: string) => void,
    tools?: readonly ToolDefinition[],
    settings?: TurnSettings,
): Promise<{
    text: string;
    cancelled: boolean;
    toolCalls: ToolCallRecord[];
    error?: ChatRouteError;
}> {
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
        payload: {
            model,
            stream: onDelta !== undefined,
            messages: bounded.map((item) => ({
                id: item.id,
                role: item.role,
                parts: messageParts(item),
            })),
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
        const execution = await runtime.run(request, lifecycle);
        for await (const frame of execution.frames) {
            const event = frame.event;
            const delta = response.append(event);
            if (delta.length > 0) onDelta?.(delta);
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
        ...(failure ? { error: failure } : {}),
    };
}

interface SocketSend {
    readonly type: "send";
    readonly conversationId: string;
    readonly model: string;
    readonly text: string;
    readonly attachments?: readonly ChatAttachment[];
}

interface SocketRegenerate {
    readonly type: "regenerate";
    readonly conversationId: string;
    readonly model: string;
}

async function handleSocketSend(
    options: ChatRouteOptions,
    event: SocketSend,
    signal: AbortSignal,
    send: (payload: unknown) => void,
): Promise<void> {
    const now = options.now ?? (() => new Date());
    try {
        if (event.text.length > TEXT_LIMIT) {
            throw new ChatRouteError(
                413,
                "payload_too_large",
                "message is too large",
            );
        }
        const conversation = options.store.getConversation(
            event.conversationId,
        );
        if (conversation === null) {
            throw new ChatRouteError(
                404,
                "not_found",
                `conversation not found: ${event.conversationId}`,
            );
        }
        await withConversationRun(
            options.store,
            event.conversationId,
            async () => {
                const user = message(
                    event.conversationId,
                    "user",
                    event.text,
                    now().toISOString(),
                    event.attachments,
                );
                options.store.addMessage(user);
                send({ type: "user", message: user });
                const outcome = await settleTurn(
                    options,
                    conversation,
                    options.store.listMessages(event.conversationId),
                    event.model,
                    crypto.randomUUID(),
                    signal,
                    (text) => send({ type: "delta", text }),
                );
                if (outcome.toolCalls.length > 0) {
                    send({ type: "tool", calls: outcome.toolCalls });
                }
                send(
                    outcome.cancelled ? { type: "stopped" } : {
                        type: "done",
                        conversation: options.store.getConversation(
                            event.conversationId,
                        ),
                    },
                );
            },
        );
    } catch (error) {
        send(socketError(error));
    }
}

async function handleSocketRegenerate(
    options: ChatRouteOptions,
    event: SocketRegenerate,
    signal: AbortSignal,
    send: (payload: unknown) => void,
): Promise<void> {
    try {
        const replaced = await withConversationRun(
            options.store,
            event.conversationId,
            () =>
                replaceLatestTurn(
                    options,
                    event.conversationId,
                    event.model,
                    crypto.randomUUID(),
                    signal,
                    (text) => send({ type: "delta", text }),
                ),
        );
        const outcome = replaced.outcome;
        if (outcome.toolCalls.length > 0) {
            send({ type: "tool", calls: outcome.toolCalls });
        }
        send(
            outcome.cancelled ? { type: "stopped" } : {
                type: "done",
                conversation: options.store.getConversation(
                    event.conversationId,
                ),
            },
        );
    } catch (error) {
        send(socketError(error));
    }
}

async function replaceLatestTurn(
    options: ChatRouteOptions,
    conversationId: string,
    model: string,
    requestId: string,
    signal: AbortSignal,
    onDelta?: (text: string) => void,
): Promise<{
    user: ChatMessageRecord;
    outcome: {
        messages: ChatMessageRecord[];
        toolCalls: ToolCallRecord[];
        cancelled: boolean;
    };
}> {
    const conversation = options.store.getConversation(conversationId);
    if (conversation === null) {
        throw new ChatRouteError(
            404,
            "not_found",
            `conversation not found: ${conversationId}`,
        );
    }
    const existing = options.store.listMessages(conversationId);
    const user = [...existing].reverse().find((item) => item.role === "user");
    if (user === undefined) {
        throw new ChatRouteError(
            400,
            "invalid_request",
            "conversation has no user message to regenerate",
        );
    }
    const index = existing.findIndex((item) => item.id === user.id);
    const staleIds = existing.slice(index + 1).map((item) => item.id);
    const before = new Set(existing.map((item) => item.id));
    try {
        const outcome = await settleTurn(
            options,
            conversation,
            existing.slice(0, index + 1),
            model,
            requestId,
            signal,
            onDelta,
        );
        options.store.deleteMessages(staleIds);
        return { user, outcome };
    } catch (error) {
        // A generation failure already saved its partial reply before surfacing
        // the error. Keep both that reply and the previous answer available.
        if (error instanceof ChatCompletionFailure) throw error;
        const added = options.store.listMessages(conversationId)
            .filter((item) => !before.has(item.id))
            .map((item) => item.id);
        options.store.deleteMessages(added);
        throw error;
    }
}

function parseSocketEvent(
    data: unknown,
):
    | SocketSend
    | SocketRegenerate
    | { type: "stop" }
    | { type: "ignored" }
    | undefined {
    const text = typeof data === "string" ? data : "";
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (
        parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    ) {
        return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type === "stop") return { type: "stop" };
    if (record.type === "regenerate") {
        try {
            return {
                type: "regenerate",
                conversationId: requiredString(
                    record.conversationId,
                    "conversationId",
                ),
                model: requiredString(record.model, "model"),
            };
        } catch {
            return undefined;
        }
    }
    if (record.type !== "send") return { type: "ignored" };
    try {
        return {
            type: "send",
            conversationId: requiredString(
                record.conversationId,
                "conversationId",
            ),
            model: requiredString(record.model, "model"),
            text: requiredString(record.text, "text"),
            attachments: readAttachments(record.attachments),
        };
    } catch {
        return undefined;
    }
}

function socketJson(payload: unknown): string {
    return JSON.stringify(payload);
}

function socketError(error: unknown): {
    type: "error";
    message: string;
    code?: string;
    status?: number;
} {
    const detail = typeof error === "object" && error !== null
        ? error as { code?: unknown; status?: unknown }
        : undefined;
    return {
        type: "error",
        message: error instanceof Error ? error.message : "chat failed",
        ...(typeof detail?.code === "string" ? { code: detail.code } : {}),
        ...(typeof detail?.status === "number"
            ? { status: detail.status }
            : {}),
    };
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
    options: ChatRouteOptions,
    conversation: ConversationRecord,
    history: readonly ChatMessageRecord[],
    model: string,
    requestId: string,
    signal: AbortSignal,
    onDelta?: (text: string) => void,
): Promise<{
    messages: ChatMessageRecord[];
    toolCalls: ToolCallRecord[];
    cancelled: boolean;
}> {
    const now = options.now ?? (() => new Date());
    const toolset = createChatToolset(
        typeof options.tools === "function" ? options.tools() : options.tools,
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
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const result = await complete(
            options.runtime,
            working,
            model,
            round === 0 ? requestId : `${requestId}:tool:${round}`,
            signal,
            onDelta,
            toolset.definitions,
            settings,
        );
        const reply = storeReply(
            options.store,
            conversation,
            titleText,
            result,
            now,
        );
        created.push(...reply);
        working.push(...reply);
        titleText = "";
        if (result.error) throw new ChatCompletionFailure(result.error);
        if (result.cancelled) {
            return { messages: created, toolCalls: [], cancelled: true };
        }
        const serverCalls = result.toolCalls.filter((call) =>
            toolset.isServerTool(call.name)
        );
        const clientCalls = result.toolCalls.filter((call) =>
            !toolset.isServerTool(call.name)
        );
        if (serverCalls.length === 0) {
            return {
                messages: created,
                toolCalls: clientCalls,
                cancelled: false,
            };
        }
        for (const call of serverCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND)) {
            const outcome = await toolset.run(call, budget, signal);
            const row = toolResultMessage(
                conversation.id,
                call,
                outcome.text,
                now,
            );
            options.store.addMessage(row);
            created.push(row);
            working.push(row);
        }
    }
    return { messages: created, toolCalls: [], cancelled: false };
}

function storeReply(
    store: ChatStore,
    conversation: ConversationRecord,
    userText: string,
    result: CompletionOutcome,
    now: () => Date,
): ChatMessageRecord[] {
    const created: ChatMessageRecord[] = [];
    // Failed and stopped turns persist their visible output together with the
    // outcome status; an outcome with no text (a bare stop or a failure before
    // the first delta) leaves no empty row behind.
    if (result.text.length > 0) {
        const assistant: ChatMessageRecord = {
            ...message(
                conversation.id,
                "assistant",
                result.text,
                now().toISOString(),
            ),
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
        store.addMessage(assistant);
        created.push(assistant);
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
        store.addMessage(callRow);
        created.push(callRow);
    }
    const last = created.at(-1);
    if (last !== undefined) {
        store.updateConversation(conversation.id, {
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

function messageParts(item: ChatMessageRecord): ContentPart[] {
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
    for (const [index, attachment] of (item.attachments ?? []).entries()) {
        parts.push({
            id: `${item.id}:image:${index}`,
            type: "image",
            source: {
                mediaType: attachment.mediaType,
                dataBase64: attachment.dataBase64,
            },
        });
    }
    return parts;
}

function readAttachments(value: unknown): ChatAttachment[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 4) {
        throw new ChatRouteError(
            400,
            "invalid_request",
            "attachments must be an array of at most 4 images",
        );
    }
    return value.map((item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
            throw new ChatRouteError(
                400,
                "invalid_request",
                "attachment must be an object",
            );
        }
        const record = item as Record<string, unknown>;
        const mediaType = requiredString(record.mediaType, "mediaType");
        const dataBase64 = requiredString(record.dataBase64, "dataBase64");
        if (!/^image\/[a-z0-9.+-]+$/.test(mediaType)) {
            throw new ChatRouteError(
                400,
                "invalid_request",
                "attachment mediaType must be an image",
            );
        }
        if (
            dataBase64.length > 1_400_000 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)
        ) {
            throw new ChatRouteError(
                400,
                "invalid_request",
                "attachment dataBase64 is invalid",
            );
        }
        return { mediaType, dataBase64 };
    });
}

function currentRequestId(context: Context<ServerEnv>): string {
    return context.get("requestId") ||
        context.req.header("x-request-id")?.trim() || crypto.randomUUID();
}

function requiredQuery(context: Context<ServerEnv>, name: string): string {
    return requiredString(context.req.query(name), name);
}

function requiredString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new ChatRouteError(400, "invalid_request", `${name} is required`);
    }
    return value.trim();
}

async function readJsonBody(
    context: Context<ServerEnv>,
): Promise<Record<string, unknown>> {
    const bytes = new Uint8Array(await context.req.raw.arrayBuffer());
    if (bytes.byteLength > 1_048_576) {
        throw new ChatRouteError(
            413,
            "payload_too_large",
            "request body is too large",
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new ChatRouteError(
            400,
            "invalid_json",
            "request body must be JSON",
        );
    }
    if (
        parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    ) {
        throw new ChatRouteError(
            400,
            "invalid_request",
            "request body must be an object",
        );
    }
    return parsed as Record<string, unknown>;
}

function json(requestId: string, payload: unknown, status = 200): Response {
    return Response.json(payload, {
        status,
        headers: { [REQUEST_ID]: requestId },
    });
}

function errorResponse(
    requestId: string,
    status: number,
    code: string,
    message: string,
): Response {
    return json(requestId, {
        error: { code, message, request_id: requestId },
    }, status);
}

class ChatRouteError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.name = "ChatRouteError";
        this.status = status;
        this.code = code;
    }
}

/** The failed generation and its visible output have reached durable storage. */
class ChatCompletionFailure extends ChatRouteError {
    constructor(error: ChatRouteError) {
        super(error.status, error.code, error.message);
        this.name = "ChatCompletionFailure";
    }
}
