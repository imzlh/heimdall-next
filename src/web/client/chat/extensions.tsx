/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useMemo, useRef, useState } from "hono/jsx/dom";
import {
    buildChatExtensions,
    CHAT_TOOL_TOGGLE,
    type ChatExtensions,
    chatUiContext,
    EMPTY_CHAT_EXTENSIONS,
    parseChatExtensions,
} from "@heimdall/admin-contracts/chat-ui.ts";
import type { ChatInitial } from "@heimdall/admin-contracts/chat.ts";
import {
    selectUiContributions,
    type UiAction,
    uiActionAllowed,
    type UiContext,
    type UiContribution,
    uiContributionKey,
} from "@heimdall/admin-contracts/ui.ts";
import { ClientSlot } from "../extensions/slots.tsx";
import type { ChatController, ChatState } from "./types.ts";
import {
    PLUGIN_CATALOG_CHANGED,
    PLUGIN_CATALOG_STORAGE_KEY,
} from "../plugin-events.ts";

export async function runChatSlotAction(
    controller: ChatController,
    extensions: ChatExtensions,
    contribution: UiContribution,
    action: UiAction,
    context: UiContext,
): Promise<void> {
    const state = controller.getState();
    if (
        !extensions.contributions.some((item) =>
            uiContributionKey(item) === uiContributionKey(contribution)
        ) ||
        !uiActionAllowed(contribution, action, extensions.policy) ||
        action.id !== CHAT_TOOL_TOGGLE ||
        Object.keys(action.payload).length !== 1 ||
        typeof action.payload.checked !== "boolean" ||
        (context.conversationId ?? "") !== state.selectedId ||
        !state.authenticated || !state.available || state.sending ||
        state.loading || state.creating || state.managing ||
        !state.tools.some((tool) => tool.id === contribution.pluginId)
    ) {
        throw new Error("此插件动作不适用于当前会话。");
    }
    if (
        !await controller.setToolEnabled(
            contribution.pluginId,
            action.payload.checked,
        )
    ) {
        throw new Error("插件设置保存失败，请重试。");
    }
}

export async function loadChatExtensions(
    signal?: AbortSignal,
): Promise<ChatExtensions> {
    const response = await fetch("/admin/chat/ui", {
        credentials: "same-origin",
        cache: "no-store",
        signal,
        headers: { accept: "application/json" },
    });
    if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(
            response.status === 401
                ? "会话已过期，请重新登录。"
                : "插件能力刷新失败。",
        );
        Object.assign(error, { status: response.status });
        throw error;
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("插件能力响应为空。");
    let length = 0;
    let text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            length += result.value.byteLength;
            if (length > 1_048_576) {
                await reader.cancel();
                throw new Error("插件能力响应过大。");
            }
            text += decoder.decode(result.value, { stream: true });
        }
        return parseChatExtensions(JSON.parse(text + decoder.decode()));
    } finally {
        reader.releaseLock();
    }
}

/** One metadata subscription per Chat island; no subscription per widget or message. */
export function useChatExtensions(
    initial: ChatInitial,
    controller: ChatController,
) {
    const [extensions, setExtensions] = useState(
        initial.extensions ?? buildChatExtensions([], initial.tools ?? []),
    );
    const [error, setError] = useState("");
    const refreshRef = useRef<() => Promise<void>>(async () => {});
    useEffect(() => {
        if (!initial.authenticated || !initial.available) return;
        let disposed = false;
        let pending: Promise<void> | undefined;
        let queuedRefresh = false;
        let abort: AbortController | undefined;
        let signature = JSON.stringify(initial.extensions);
        const refresh = (): Promise<void> => {
            if (pending) {
                queuedRefresh = true;
                return pending;
            }
            abort = new AbortController();
            pending = loadChatExtensions(abort.signal).then((current) => {
                if (disposed) return;
                const next = JSON.stringify(current);
                if (signature !== next) {
                    signature = next;
                    controller.replaceTools(current.tools);
                    setExtensions(current);
                }
                setError("");
            }).catch((failure: unknown) => {
                if (disposed) return;
                if (
                    failure && typeof failure === "object" &&
                    "status" in failure && failure.status === 401
                ) {
                    // Compare the next refresh with what is actually rendered.
                    // Signing in again may return the exact pre-expiry catalog.
                    signature = JSON.stringify(EMPTY_CHAT_EXTENSIONS);
                    controller.replaceTools([]);
                    setExtensions(EMPTY_CHAT_EXTENSIONS);
                }
                setError("插件能力暂不可用，请刷新重试。");
            }).finally(() => {
                pending = undefined;
                if (!disposed && queuedRefresh) {
                    queuedRefresh = false;
                    void refresh();
                }
            });
            return pending;
        };
        refreshRef.current = refresh;
        const visible = () => {
            if (document.visibilityState !== "hidden") void refresh();
        };
        const interval = globalThis.setInterval(visible, 30_000);
        const onStorage = (event: StorageEvent) => {
            if (event.key === PLUGIN_CATALOG_STORAGE_KEY) visible();
        };
        globalThis.addEventListener("focus", visible);
        globalThis.addEventListener("storage", onStorage);
        globalThis.addEventListener(PLUGIN_CATALOG_CHANGED, visible);
        document.addEventListener("visibilitychange", visible);
        void refresh();
        return () => {
            disposed = true;
            abort?.abort();
            globalThis.clearInterval(interval);
            globalThis.removeEventListener("focus", visible);
            globalThis.removeEventListener("storage", onStorage);
            globalThis.removeEventListener(PLUGIN_CATALOG_CHANGED, visible);
            document.removeEventListener("visibilitychange", visible);
            refreshRef.current = async () => {};
        };
    }, [controller, initial.authenticated, initial.available]);
    return {
        extensions,
        error,
        refresh: () => refreshRef.current?.() ?? Promise.resolve(),
    };
}

function ChatSlot({ contribution, extensions, state, controller, theme }: {
    contribution: UiContribution;
    extensions: ChatExtensions;
    state: ChatState;
    controller: ChatController;
    theme: UiContext["theme"];
}) {
    const busy = state.sending || state.loading || state.creating ||
        state.managing || Boolean(state.toolsBusy);
    const context = useMemo(
        () =>
            chatUiContext({
                conversation: state.conversation,
                model: state.model,
                messageCount: state.messages.length,
                busy,
                pendingDisabledTools: state.pendingDisabledTools,
                tools: extensions.tools,
                theme,
            }, contribution),
        [
            state.conversation,
            state.model,
            state.messages.length,
            state.pendingDisabledTools,
            extensions.tools,
            busy,
            theme,
            contribution,
        ],
    );
    const action = useMemo(
        () => (item: UiContribution, value: UiAction, ctx: UiContext) =>
            runChatSlotAction(controller, extensions, item, value, ctx),
        [controller, extensions],
    );
    return (
        <ClientSlot
            contribution={contribution}
            context={context}
            policy={extensions.policy}
            onAction={action}
        />
    );
}

export function ChatClientSlots(
    { slot, extensions, state, controller, theme }: {
        slot: "chat.composer" | "chat.sidebar";
        extensions: ChatExtensions;
        state: ChatState;
        controller: ChatController;
        theme: UiContext["theme"];
    },
) {
    if (!state.available || !state.authenticated) return null;
    const entries = selectUiContributions(extensions.contributions, slot);
    if (!entries.length) return null;
    return (
        <div
            class={`chat-plugin-slots plugin-slots-${
                slot.replaceAll(".", "-")
            }`}
            data-ui-slot={slot}
            aria-label={slot === "chat.composer" ? "对话能力" : "会话插件"}
        >
            {entries.map((contribution) => (
                <ChatSlot
                    key={uiContributionKey(contribution)}
                    contribution={contribution}
                    extensions={extensions}
                    state={state}
                    controller={controller}
                    theme={theme}
                />
            ))}
        </div>
    );
}
