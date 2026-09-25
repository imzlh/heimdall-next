/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx/dom */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import type { ChatInitial } from "@heimdall/admin-contracts/chat.ts";
import { useChat } from "./chat/use-chat.ts";
import { ChatMessages } from "./chat/messages.tsx";
import { ChatComposer } from "./chat/composer.tsx";
import { Icon } from "../shared/icons.tsx";
import {
    type ConversationAction,
    ConversationDialog,
} from "./chat/conversation-dialog.tsx";

function savedTheme(): "light" | "dark" {
    try {
        const stored = localStorage.getItem("heimdall.theme");
        if (stored === "light" || stored === "dark") return stored;
    } catch { /* Theme persistence is optional. */ }
    return matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
}

function updateLocation(id: string) {
    const url = new URL("/admin/chat", location.origin);
    if (id) url.searchParams.set("id", id);
    history.replaceState(null, "", url);
}

export function ChatApp({ initial }: { initial: ChatInitial }) {
    const { state, controller } = useChat(initial, updateLocation);
    const [theme, setTheme] = useState(savedTheme);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [management, setManagement] = useState<ConversationAction | null>(
        null,
    );
    const historyPanel = useRef<HTMLElement | null>(null);
    const viewport = useRef<HTMLDivElement | null>(null);
    const followEnd = useRef(true);
    const busy = state.loading || state.creating || state.sending ||
        state.attachmentsBusy || state.managing;
    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        try {
            localStorage.setItem("heimdall.theme", theme);
        } catch { /* Optional. */ }
    }, [theme]);
    useEffect(() => {
        followEnd.current = true;
    }, [state.selectedId]);
    useEffect(() => {
        const element = viewport.current;
        if (element && followEnd.current) {
            element.scrollTop = element.scrollHeight;
        }
    }, [state.messages, state.streamText, state.toolCalls]);
    useEffect(() => {
        if (!historyOpen) return;
        const trigger = document.activeElement as HTMLElement | null;
        const panel = historyPanel.current;
        const focusable = () =>
            Array.from(
                panel?.querySelectorAll<HTMLElement>(
                    'a[href], button:not(:disabled), [tabindex="0"]',
                ) ?? [],
            ).filter((element) => element.getClientRects().length);
        focusable()[0]?.focus();
        const closeOnEscape = (event: KeyboardEvent) => {
            if (document.querySelector("dialog[open]")) return;
            if (event.key === "Escape") {
                event.preventDefault();
                setHistoryOpen(false);
            }
            if (event.key === "Tab") {
                const controls = focusable();
                const first = controls[0];
                const last = controls.at(-1);
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                }
            }
        };
        document.addEventListener("keydown", closeOnEscape);
        const mobile = matchMedia("(max-width: 800px)");
        const onResize = () => {
            if (!mobile.matches) setHistoryOpen(false);
        };
        mobile.addEventListener("change", onResize);
        return () => {
            document.removeEventListener("keydown", closeOnEscape);
            mobile.removeEventListener("change", onResize);
            if (trigger?.isConnected) trigger.focus();
        };
    }, [historyOpen]);
    function select(event: MouseEvent, id: string) {
        if (
            event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
            event.button !== 0
        ) return;
        event.preventDefault();
        if (busy) return;
        setHistoryOpen(false);
        void controller.select(id);
    }
    return (
        <div class={`chat-layout${historyOpen ? " history-open" : ""}`}>
            <aside
                ref={historyPanel}
                class="chat-sidebar"
                id="chat-history-panel"
                aria-label="会话历史"
            >
                <div class="chat-sidebar-heading">
                    <h2>会话</h2>
                    <a
                        class="chat-icon-button"
                        href="/admin"
                        title="返回管理页面"
                        aria-label="返回管理页面"
                    >
                        <Icon name="back" />
                    </a>
                </div>
                <button
                    type="button"
                    class="chat-new primary-button"
                    disabled={busy || !state.available || !state.authenticated}
                    onClick={() => {
                        setHistoryOpen(false);
                        void controller.create();
                    }}
                >
                    <Icon name="plus" />新对话
                </button>
                <ul class="chat-history" aria-label="历史会话">
                    {state.conversations.map((conversation) => (
                        <li key={conversation.id} class="chat-conversation-row">
                            <a
                                class={`chat-conversation${
                                    state.selectedId === conversation.id
                                        ? " is-active"
                                        : ""
                                }`}
                                href={`/admin/chat?id=${
                                    encodeURIComponent(conversation.id)
                                }`}
                                onClick={(event) =>
                                    select(event, conversation.id)}
                                aria-current={state.selectedId ===
                                        conversation.id
                                    ? "page"
                                    : undefined}
                                aria-disabled={busy ? "true" : "false"}
                                title={conversation.title || "新对话"}
                            >
                                <span>{conversation.title || "新对话"}</span>
                                <small>
                                    {conversation.updatedAt.slice(0, 10)}
                                </small>
                            </a>
                            <div
                                class="chat-conversation-actions"
                                aria-label="管理会话"
                            >
                                <button
                                    type="button"
                                    class="chat-icon-button"
                                    aria-label={`重命名 ${
                                        conversation.title || "新对话"
                                    }`}
                                    title="重命名"
                                    disabled={busy}
                                    onClick={() =>
                                        setManagement({
                                            kind: "rename",
                                            id: conversation.id,
                                            title: conversation.title,
                                        })}
                                >
                                    <Icon name="edit" />
                                </button>
                                <button
                                    type="button"
                                    class="chat-icon-button chat-delete-button"
                                    aria-label={`删除 ${
                                        conversation.title || "新对话"
                                    }`}
                                    title="删除对话"
                                    disabled={busy}
                                    onClick={() =>
                                        setManagement({
                                            kind: "delete",
                                            id: conversation.id,
                                            title: conversation.title,
                                        })}
                                >
                                    <Icon name="trash" />
                                </button>
                            </div>
                        </li>
                    ))}
                    {!state.conversations.length && (
                        <li class="chat-history-empty">
                            你的对话会保存在这里。
                        </li>
                    )}
                </ul>
                <div class="chat-sidebar-footer">
                    <a href="/admin">返回管理页面</a>
                    <button
                        type="button"
                        class="chat-icon-button"
                        onClick={() =>
                            setTheme(theme === "dark" ? "light" : "dark")}
                        aria-label={`切换为${
                            theme === "dark" ? "浅色" : "深色"
                        }主题`}
                        title="切换主题"
                    >
                        <Icon name={theme === "dark" ? "sun" : "moon"} />
                    </button>
                </div>
            </aside>
            <button
                type="button"
                class="chat-sidebar-scrim"
                tabIndex={-1}
                aria-hidden={historyOpen ? undefined : "true"}
                aria-label="关闭会话列表"
                onClick={() => setHistoryOpen(false)}
            />
            <section
                class="chat-main"
                id="chat-main"
                role="main"
                aria-label="聊天"
            >
                <header class="chat-header">
                    <div class="chat-header-title">
                        <button
                            type="button"
                            class="chat-icon-button chat-history-toggle"
                            aria-label={historyOpen
                                ? "关闭会话列表"
                                : "打开会话列表"}
                            aria-expanded={historyOpen ? "true" : "false"}
                            aria-controls="chat-history-panel"
                            onClick={() => setHistoryOpen(!historyOpen)}
                        >
                            <Icon name="menu" />
                        </button>
                        <div>
                            <h1 class="chat-title">
                                {state.conversation?.title || "Heimdall Chat"}
                            </h1>
                            <p class="chat-subtitle">
                                {state.sending
                                    ? "正在生成回复"
                                    : "与已配置的模型对话"}
                            </p>
                        </div>
                    </div>
                    <div class="chat-header-actions">
                        <div class="chat-model-field">
                            <label class="sr-only" for="chat-model">
                                选择模型
                            </label>
                            <select
                                id="chat-model"
                                class="chat-model"
                                value={state.model}
                                title={state.model || "选择模型"}
                                disabled={busy || !state.available ||
                                    !state.authenticated ||
                                    !state.models.length}
                                onChange={(event) =>
                                    controller.setModel(
                                        (event
                                            .currentTarget as HTMLSelectElement)
                                            .value,
                                    )}
                            >
                                {!state.models.length && (
                                    <option value="">暂无可用模型</option>
                                )}
                                {state.model &&
                                    !state.models.includes(state.model) && (
                                    <option value={state.model}>
                                        {state.model}
                                    </option>
                                )}
                                {state.models.map((model) => (
                                    <option key={model} value={model}>
                                        {model}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <button
                            type="button"
                            class="chat-icon-button"
                            disabled={busy}
                            onClick={() => void controller.refresh()}
                            aria-label="刷新会话"
                            title="刷新会话"
                        >
                            <Icon name="refresh" />
                        </button>
                    </div>
                </header>
                <div
                    class="chat-messages"
                    id="chat-messages"
                    ref={viewport}
                    tabIndex={0}
                    aria-label="消息记录"
                    onScroll={() => {
                        const element = viewport.current;
                        if (element) {
                            followEnd.current =
                                element.scrollHeight - element.clientHeight -
                                        element.scrollTop < 100;
                        }
                    }}
                >
                    <ChatMessages state={state} />
                </div>
                {state.error && (
                    <p class="chat-error" role="alert">
                        {state.error}{" "}
                        <a
                            href={state.selectedId
                                ? `/admin/chat?id=${
                                    encodeURIComponent(state.selectedId)
                                }`
                                : "/admin/chat"}
                        >
                            重新加载页面
                        </a>
                    </p>
                )}
                <p class="sr-only" role="status" aria-live="polite">
                    {state.sending
                        ? state.stopping ? "正在停止生成" : "正在生成回复"
                        : state.loading
                        ? "正在读取会话"
                        : state.creating
                        ? "正在创建会话"
                        : "已就绪"}
                </p>
                <ChatComposer state={state} controller={controller} />
            </section>
            {management && (
                <ConversationDialog
                    key={`${management.kind}:${management.id}`}
                    action={management}
                    pending={state.managing || state.loading}
                    error={state.error}
                    onSubmit={(title) =>
                        management.kind === "rename"
                            ? controller.rename(management.id, title)
                            : controller.remove(management.id)}
                    onDismiss={() => setManagement(null)}
                />
            )}
        </div>
    );
}
