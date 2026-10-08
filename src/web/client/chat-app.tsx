/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import type {
    ChatInitial,
    ChatMessage,
} from "@heimdall/admin-contracts/chat.ts";
import { useChat } from "./chat/use-chat.ts";
import { ChatMessages } from "./chat/messages.tsx";
import { ChatComposer } from "./chat/composer.tsx";
import type { ChatState } from "./chat/types.ts";
import { Icon } from "../shared/icons.tsx";
import {
    type ConversationAction,
    ConversationDialog,
    MessageDeleteDialog,
} from "./chat/conversation-dialog.tsx";
import { downloadConversation } from "./chat/export.ts";
import { MessageEditor } from "./chat/message-editor.tsx";
import { ConversationBranches } from "./chat/conversation-branches.tsx";
import { ChatClientSlots, useChatExtensions } from "./chat/extensions.tsx";

function savedTheme(): "light" | "dark" {
    try {
        const stored = localStorage.getItem("heimdall.theme");
        if (stored === "light" || stored === "dark") return stored;
    } catch { /* Theme persistence is optional. */ }
    return matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
}

function savedCollapsed(): boolean {
    try {
        return localStorage.getItem("heimdall.chat.sidebar") === "collapsed";
    } catch {
        return false;
    }
}

function updateLocation(id: string) {
    const url = new URL("/admin/chat", location.origin);
    if (id) url.searchParams.set("id", id);
    history.replaceState(null, "", url);
}

type TitleSaveState = "idle" | "saving" | "saved" | "error";

/** Conversation settings popover: plugin switches plus the system prompt. */
function ConversationSettings(
    { state, controller, open, onDismiss, onSelectBranch }: {
        state: ChatState;
        controller: ReturnType<typeof useChat>["controller"];
        open: boolean;
        onDismiss: () => void;
        onSelectBranch: (messageId: string) => void;
    },
) {
    const panel = useRef<HTMLDivElement | null>(null);
    const [promptDraft, setPromptDraft] = useState(
        state.conversation?.systemPrompt ?? "",
    );
    const [settingsState, setSettingsState] = useState<TitleSaveState>("idle");
    const settingsTimer = useRef<
        ReturnType<typeof globalThis.setTimeout> | undefined
    >(undefined);
    const conversationId = state.conversation?.id ?? "";
    useEffect(() => {
        setPromptDraft(state.conversation?.systemPrompt ?? "");
        setSettingsState("idle");
    }, [conversationId]);
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            if (!panel.current?.contains(event.target as Node)) onDismiss();
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            if (document.querySelector("dialog[open]")) return;
            event.preventDefault();
            onDismiss();
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [open, onDismiss]);
    useEffect(() => {
        return () => {
            globalThis.clearTimeout(settingsTimer.current ?? undefined);
        };
    }, []);
    function scheduleSettingsSave(patch: { readonly systemPrompt?: string }) {
        globalThis.clearTimeout(settingsTimer.current ?? undefined);
        if (!conversationId) return;
        setSettingsState("saving");
        settingsTimer.current = globalThis.setTimeout(async () => {
            const saved = await controller.updateSettings(
                conversationId,
                patch,
            );
            setSettingsState(saved ? "saved" : "error");
        }, 600);
    }
    function schedulePromptSave(next: string) {
        setPromptDraft(next);
        if (next === (state.conversation?.systemPrompt ?? "")) return;
        scheduleSettingsSave({ systemPrompt: next });
    }
    function toggleTool(id: string, enable: boolean) {
        void controller.setToolEnabled(id, enable);
    }
    if (!open) return null;
    return (
        <div
            ref={panel}
            class="chat-settings-popover"
            role="region"
            aria-label="对话设置"
        >
            <ConversationBranches
                branches={state.conversation?.branches}
                disabled={busy(state) || !state.available ||
                    !state.authenticated}
                onSelectBranch={onSelectBranch}
            />
            {state.tools.length > 0 && (
                <div class="chat-settings-field">
                    <span>插件</span>
                    <div class="chat-plugin-list">
                        {state.tools.map((tool) => {
                            const on = !state.conversation?.disabledTools
                                ?.includes(tool.id);
                            return (
                                <button
                                    key={tool.id}
                                    type="button"
                                    role="switch"
                                    aria-checked={on ? "true" : "false"}
                                    class="chat-plugin-row"
                                    disabled={busy(state) || !conversationId}
                                    onClick={() => toggleTool(tool.id, !on)}
                                    title={on ? "点击停用" : "点击启用"}
                                >
                                    <Icon name="plugin" />
                                    <span class="chat-plugin-copy">
                                        <strong>{tool.name}</strong>
                                        {tool.description && (
                                            <small>{tool.description}</small>
                                        )}
                                    </span>
                                    <span
                                        class="chat-plugin-switch"
                                        data-on={on ? "true" : "false"}
                                        aria-hidden="true"
                                    />
                                </button>
                            );
                        })}
                    </div>
                    <small class="chat-settings-meta">
                        按会话记忆，刷新后仍保留。
                    </small>
                </div>
            )}
            <label class="chat-settings-field">
                <span>
                    系统提示词
                    <button
                        type="button"
                        class="chat-small-button"
                        disabled={!promptDraft || busy(state)}
                        onClick={() => schedulePromptSave("")}
                    >
                        清空
                    </button>
                </span>
                <textarea
                    rows={3}
                    value={promptDraft}
                    maxlength={8000}
                    placeholder="写给这个会话的固定指令，每次对话都会生效…"
                    disabled={busy(state)}
                    onInput={(event) =>
                        schedulePromptSave(
                            (event.currentTarget as HTMLTextAreaElement).value,
                        )}
                />
                {settingsState === "error" && (
                    <small class="chat-settings-meta">
                        <span class="chat-settings-error">
                            保存失败
                            <button
                                type="button"
                                class="chat-small-button"
                                onClick={() => {
                                    setSettingsState("saving");
                                    void controller.updateSettings(
                                        conversationId,
                                        { systemPrompt: promptDraft },
                                    ).then((saved) =>
                                        setSettingsState(
                                            saved ? "saved" : "error",
                                        )
                                    );
                                }}
                            >
                                重试
                            </button>
                        </span>
                    </small>
                )}
            </label>
        </div>
    );
}

function busy(state: ChatState): boolean {
    return state.loading || state.creating || state.sending ||
        state.attachmentsBusy || state.managing || Boolean(state.toolsBusy);
}

export function ChatApp({ initial }: { initial: ChatInitial }) {
    const { state, controller } = useChat(initial, updateLocation);
    const plugins = useChatExtensions(initial, controller);
    const [theme, setTheme] = useState(savedTheme);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [collapsed, setCollapsed] = useState(savedCollapsed);
    const [modelOpen, setModelOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [management, setManagement] = useState<ConversationAction | null>(
        null,
    );
    const [deletingMessage, setDeletingMessage] = useState<string | null>(
        null,
    );
    const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(
        null,
    );
    const [atBottom, setAtBottom] = useState(true);
    const historyPanel = useRef<HTMLElement | null>(null);
    const modelField = useRef<HTMLDivElement | null>(null);
    const modelTrigger = useRef<HTMLButtonElement | null>(null);
    const modelMenu = useRef<HTMLDivElement | null>(null);
    const viewport = useRef<HTMLDivElement | null>(null);
    const followEnd = useRef(true);
    const busyState = busy(state);
    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        try {
            localStorage.setItem("heimdall.theme", theme);
        } catch { /* Optional. */ }
    }, [theme]);
    useEffect(() => {
        const onStorage = (event: StorageEvent) => {
            if (
                event.key === "heimdall.theme" &&
                (event.newValue === "light" || event.newValue === "dark")
            ) setTheme(event.newValue);
        };
        globalThis.addEventListener("storage", onStorage);
        return () => globalThis.removeEventListener("storage", onStorage);
    }, []);
    useEffect(() => {
        try {
            localStorage.setItem(
                "heimdall.chat.sidebar",
                collapsed ? "collapsed" : "open",
            );
        } catch { /* Optional. */ }
    }, [collapsed]);
    useEffect(() => {
        followEnd.current = true;
        setAtBottom(true);
    }, [state.selectedId]);
    useEffect(() => {
        const element = viewport.current;
        if (element && followEnd.current) {
            element.scrollTop = element.scrollHeight;
        }
    }, [
        state.messages,
        state.streamText,
        state.streamReasoning,
        state.streamActivity,
        state.streamCitations,
        state.toolCalls,
    ]);
    // Blocks that grow taller after the first paint — streaming code blocks,
    // images finishing load — must keep the newest line in view too. A resize
    // observer on the thread follows that growth while the user stays pinned to
    // the bottom, which per-delta state effects alone miss.
    useEffect(() => {
        const element = viewport.current;
        if (!element || typeof ResizeObserver === "undefined") return;
        const content = element.firstElementChild;
        if (!content) return;
        const observer = new ResizeObserver(() => {
            if (followEnd.current) element.scrollTop = element.scrollHeight;
        });
        observer.observe(content);
        return () => observer.disconnect();
    }, [state.selectedId]);
    // Ctrl+N opens a new conversation, matching the original chat.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (
                (event.ctrlKey || event.metaKey) &&
                !event.altKey && !event.shiftKey &&
                event.key.toLowerCase() === "n"
            ) {
                event.preventDefault();
                if (document.querySelector("dialog[open]")) return;
                setHistoryOpen(false);
                void controller.create();
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [controller]);
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
    // The custom menu replaces the native <select>, so it carries the same
    // outside-click, Escape and focus-trap duties a real popover needs.
    useEffect(() => {
        if (!modelOpen) return;
        const field = modelField.current;
        const menu = modelMenu.current;
        const options = () =>
            Array.from(
                menu?.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                ) ?? [],
            ).filter((element) => element.getClientRects().length);
        const focusSelected = () => {
            for (const element of options()) {
                if (element.dataset.selected === "true") {
                    element.focus();
                    return;
                }
            }
            options()[0]?.focus();
        };
        focusSelected();
        const onPointerDown = (event: PointerEvent) => {
            if (!field?.contains(event.target as Node)) setModelOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            const items = options();
            if (!items.length) return;
            const index = items.findIndex((element) =>
                element === document.activeElement
            );
            const move = (offset: number) => {
                const target = index < 0
                    ? items[0]
                    : items[(index + offset + items.length) % items.length];
                (target ?? items[0])?.focus();
            };
            if (event.key === "Escape") {
                if (document.querySelector("dialog[open]")) return;
                event.preventDefault();
                setModelOpen(false);
                modelTrigger.current?.focus();
            } else if (event.key === "Tab") {
                event.preventDefault();
                const first = items[0]!;
                const last = items.at(-1)!;
                (document.activeElement === first && event.shiftKey
                    ? last
                    : document.activeElement === last && !event.shiftKey
                    ? first
                    : items[
                        event.shiftKey
                            ? Math.max(0, index - 1)
                            : Math.min(items.length - 1, index + 1)
                    ] ??
                        first).focus();
            } else if (
                event.key === "ArrowDown" || event.key === "ArrowUp"
            ) {
                event.preventDefault();
                move(event.key === "ArrowDown" ? 1 : -1);
            }
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [modelOpen]);
    function select(event: MouseEvent, id: string) {
        if (
            event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
            event.button !== 0
        ) return;
        event.preventDefault();
        if (busyState) return;
        setHistoryOpen(false);
        void controller.select(id);
    }
    function stickToBottom() {
        const element = viewport.current;
        followEnd.current = true;
        setAtBottom(true);
        if (element) element.scrollTop = element.scrollHeight;
    }
    const showJump = !atBottom && (state.sending || !!state.streamText);
    return (
        <div
            class={`chat-layout${historyOpen ? " history-open" : ""}${
                collapsed ? " collapsed" : ""
            }`}
        >
            <aside
                ref={historyPanel}
                class="chat-sidebar"
                id="chat-history-panel"
                aria-label="会话历史"
            >
                <div class="chat-sidebar-heading">
                    <h2>会话</h2>
                    <div class="chat-sidebar-heading-actions">
                        <button
                            type="button"
                            class="chat-icon-button chat-sidebar-collapse"
                            aria-label="收起会话列表"
                            title="收起会话列表"
                            onClick={() => setCollapsed(true)}
                        >
                            <Icon name="panel-close" />
                        </button>
                    </div>
                </div>
                <button
                    type="button"
                    class="chat-new primary-button"
                    disabled={busyState || !state.available ||
                        !state.authenticated}
                    onClick={() => {
                        setHistoryOpen(false);
                        void controller.create();
                    }}
                >
                    <Icon name="plus" />新对话
                </button>
                <ul class="chat-history" aria-label="历史会话">
                    {state.conversations.map((conversation) => (
                        <li
                            key={conversation.id}
                            class="chat-conversation-row"
                            onDoubleClick={() =>
                                !busyState &&
                                setManagement({
                                    kind: "rename",
                                    id: conversation.id,
                                    title: conversation.title,
                                })}
                        >
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
                                aria-disabled={busyState ? "true" : "false"}
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
                                    title="重命名（或双击会话）"
                                    disabled={busyState}
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
                                    disabled={busyState}
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
                <ChatClientSlots
                    slot="chat.sidebar"
                    extensions={plugins.extensions}
                    state={state}
                    controller={controller}
                    theme={theme}
                />
                {plugins.error && (
                    <p class="chat-plugin-notice" role="status">
                        {plugins.error}
                    </p>
                )}
                <div class="chat-sidebar-footer">
                    <button
                        type="button"
                        class="chat-small-button chat-export-button"
                        disabled={busyState ||
                            !state.conversation ||
                            !state.messages.length}
                        onClick={() => {
                            if (!state.conversation) return;
                            downloadConversation(
                                state.conversation,
                                state.messages,
                            );
                        }}
                        aria-label="导出当前会话为 Markdown"
                        title="导出当前会话为 Markdown"
                    >
                        <Icon name="download" />导出会话
                    </button>
                    <div class="chat-sidebar-footer-actions">
                        <a
                            class="chat-icon-button"
                            href="/admin"
                            title="返回管理页面"
                            aria-label="返回管理页面"
                        >
                            <Icon name="back" />
                        </a>
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
                {collapsed && (
                    <button
                        type="button"
                        class="chat-icon-button chat-sidebar-expand"
                        aria-label="展开会话列表"
                        title="展开会话列表"
                        onClick={() => setCollapsed(false)}
                    >
                        <Icon name="panel-open" />
                    </button>
                )}
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
                        <div
                            class="chat-model-field"
                            ref={modelField}
                        >
                            <button
                                type="button"
                                id="chat-model"
                                class="chat-model chat-model-trigger"
                                ref={modelTrigger}
                                disabled={busyState || !state.available ||
                                    !state.authenticated ||
                                    !state.models.length}
                                aria-haspopup="listbox"
                                aria-expanded={modelOpen ? "true" : "false"}
                                title={state.model || "选择模型"}
                                onClick={() => setModelOpen(!modelOpen)}
                            >
                                <Icon name="cpu" />
                                <span class="chat-model-label">
                                    {state.model || "暂无可用模型"}
                                </span>
                                <Icon
                                    name="chevron-down"
                                    class="chat-model-chevron"
                                />
                            </button>
                            <div
                                ref={modelMenu}
                                id="chat-model-menu"
                                class="chat-model-menu"
                                data-open={modelOpen ? "true" : "false"}
                                role="listbox"
                                aria-label="选择模型"
                                aria-hidden={modelOpen ? "false" : "true"}
                                inert={!modelOpen}
                            >
                                {state.models.map((model) => (
                                    <button
                                        key={model}
                                        type="button"
                                        class="chat-model-option"
                                        role="option"
                                        aria-selected={state.model === model
                                            ? "true"
                                            : "false"}
                                        data-selected={state.model === model
                                            ? "true"
                                            : "false"}
                                        onClick={() => {
                                            setModelOpen(false);
                                            modelTrigger.current?.focus();
                                            controller.setModel(model);
                                        }}
                                    >
                                        <span>{model}</span>
                                        {state.model === model && (
                                            <Icon name="check" />
                                        )}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <button
                            type="button"
                            class={`chat-icon-button chat-settings-toggle${
                                settingsOpen ? " is-open" : ""
                            }`}
                            disabled={!state.authenticated}
                            aria-label="对话设置"
                            title="对话设置"
                            aria-expanded={settingsOpen ? "true" : "false"}
                            onClick={() => setSettingsOpen(!settingsOpen)}
                        >
                            <Icon name="settings" />
                        </button>
                        <button
                            type="button"
                            class="chat-icon-button"
                            disabled={busyState}
                            onClick={() => {
                                void controller.refresh();
                                void plugins.refresh();
                            }}
                            aria-label="刷新会话"
                            title="刷新会话"
                        >
                            <Icon name="refresh" />
                        </button>
                    </div>
                    <ConversationSettings
                        state={state}
                        controller={controller}
                        open={settingsOpen}
                        onDismiss={() => setSettingsOpen(false)}
                        onSelectBranch={(messageId) => {
                            followEnd.current = true;
                            void controller.switchBranch(messageId).then(
                                (saved) => {
                                    if (saved) setSettingsOpen(false);
                                },
                            );
                        }}
                    />
                </header>
                <div
                    class="chat-messages"
                    id="chat-messages"
                    ref={viewport}
                    tabIndex={0}
                    aria-label="消息记录"
                    onScroll={() => {
                        const element = viewport.current;
                        if (!element) return;
                        const bottom =
                            element.scrollHeight - element.clientHeight -
                                    element.scrollTop < 100;
                        followEnd.current = bottom;
                        setAtBottom(bottom);
                    }}
                >
                    <ChatMessages
                        state={state}
                        onStarter={(text) => {
                            controller.setDraft(text);
                            document.getElementById("chat-draft")?.focus();
                        }}
                        onRetry={(messageId) => {
                            followEnd.current = true;
                            void controller.regenerate(messageId);
                        }}
                        onContinue={(messageId) => {
                            followEnd.current = true;
                            void controller.continueMessage(messageId);
                        }}
                        onEditMessage={setEditingMessage}
                        onForkMessage={(messageId) =>
                            void controller.forkMessage(messageId)}
                        onSwitchBranch={(messageId) => {
                            followEnd.current = false;
                            void controller.switchBranch(messageId);
                        }}
                        onReference={(attachment) => {
                            controller.addReference(attachment);
                            document.getElementById("chat-draft")?.focus();
                        }}
                        onDeleteMessage={(messageId) =>
                            setDeletingMessage(messageId)}
                    />
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
                {showJump && (
                    <button
                        type="button"
                        class="chat-jump-latest"
                        onClick={stickToBottom}
                        aria-label="回到最新消息"
                        title="回到最新"
                    >
                        <Icon name="arrow-down" size={18} />
                    </button>
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
                <ChatComposer
                    state={state}
                    controller={controller}
                    capabilities={
                        <ChatClientSlots
                            slot="chat.composer"
                            extensions={plugins.extensions}
                            state={state}
                            controller={controller}
                            theme={theme}
                        />
                    }
                />
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
            {deletingMessage && (
                <MessageDeleteDialog
                    key={deletingMessage}
                    pending={state.managing || state.loading}
                    error={state.error}
                    onSubmit={() => {
                        if (!state.selectedId) return Promise.resolve(false);
                        return controller.removeMessage(
                            state.selectedId,
                            deletingMessage,
                        );
                    }}
                    onDismiss={() => setDeletingMessage(null)}
                />
            )}
            {editingMessage && (
                <MessageEditor
                    key={editingMessage.id}
                    message={editingMessage}
                    pending={busyState}
                    error={state.error}
                    onSubmit={(text) => {
                        followEnd.current = true;
                        return controller.editMessage(editingMessage.id, text);
                    }}
                    onDismiss={() => setEditingMessage(null)}
                />
            )}
        </div>
    );
}
