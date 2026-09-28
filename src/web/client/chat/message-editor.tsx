/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import type { ChatMessage } from "@heimdall/admin-contracts/chat.ts";
import { Icon } from "../../shared/icons.tsx";

/** Editing creates a sibling message; the existing path remains available. */
export function MessageEditor(
    { message, pending, error, onSubmit, onDismiss }: {
        message: ChatMessage;
        pending: boolean;
        error: string;
        onSubmit: (text: string) => Promise<boolean>;
        onDismiss: () => void;
    },
) {
    const dialog = useRef<HTMLDialogElement | null>(null);
    const input = useRef<HTMLTextAreaElement | null>(null);
    const [text, setText] = useState(message.text);
    const [attempted, setAttempted] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [localError, setLocalError] = useState("");
    const locked = pending || submitting;
    const isUser = message.role === "user";
    const hasAttachments = !!message.attachments?.length;
    const changed = text !== message.text;

    useEffect(() => {
        const trigger = document.activeElement as HTMLElement | null;
        const element = dialog.current;
        element?.showModal();
        input.current?.focus();
        return () => {
            element?.close();
            if (trigger?.isConnected && !trigger.hasAttribute("disabled")) {
                trigger.focus();
            } else {
                document.getElementById("chat-draft")?.focus();
            }
        };
    }, []);

    async function submit() {
        if (locked || !changed) return;
        setAttempted(true);
        if (!text.trim() && !(isUser && hasAttachments)) {
            setLocalError("请输入消息内容。");
            input.current?.focus();
            return;
        }
        if (text.length > 100_000) {
            setLocalError("消息过长，最多可输入 100,000 个字符。");
            input.current?.focus();
            return;
        }
        setLocalError("");
        setSubmitting(true);
        try {
            if (await onSubmit(text)) onDismiss();
        } catch {
            setLocalError("保存失败，编辑内容已保留，请重试。");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <dialog
            ref={dialog}
            class="chat-conversation-dialog chat-message-editor"
            aria-labelledby="message-editor-title"
            aria-describedby="message-editor-description"
            aria-busy={locked ? "true" : "false"}
            onCancel={(event: Event) => {
                event.preventDefault();
                if (!locked) onDismiss();
            }}
            onClick={(event) => {
                const element = dialog.current;
                if (locked || !element || event.target !== element) return;
                const rect = element.getBoundingClientRect();
                if (
                    event.clientX < rect.left || event.clientX > rect.right ||
                    event.clientY < rect.top || event.clientY > rect.bottom
                ) onDismiss();
            }}
        >
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                }}
            >
                <header class="chat-conversation-dialog-heading">
                    <h2 id="message-editor-title">
                        {isUser ? "编辑提问" : "编辑回复"}
                    </h2>
                    <button
                        type="button"
                        class="chat-icon-button"
                        aria-label="关闭编辑"
                        disabled={locked}
                        onClick={onDismiss}
                    >
                        <Icon name="close" />
                    </button>
                </header>
                <p
                    id="message-editor-description"
                    class="chat-conversation-description"
                >
                    {isUser
                        ? "保存后从这条提问生成新的回复。原消息及后续对话会保留，可用版本箭头切换。"
                        : "保存为这条回复的新版本。原消息及后续对话会保留，可用版本箭头切换。"}
                </p>
                <div class="chat-message-editor-field">
                    <label for="message-editor-text">消息内容</label>
                    <textarea
                        ref={input}
                        id="message-editor-text"
                        name="text"
                        rows={8}
                        value={text}
                        disabled={locked}
                        maxLength={100_000}
                        aria-invalid={localError ? "true" : undefined}
                        aria-describedby={localError
                            ? "message-editor-hint message-editor-error"
                            : "message-editor-hint"}
                        onInput={(event) => {
                            setText(
                                (event.currentTarget as HTMLTextAreaElement)
                                    .value,
                            );
                            setLocalError("");
                        }}
                        onKeyDown={(event) => {
                            if (
                                event.key === "Enter" &&
                                (event.ctrlKey || event.metaKey) &&
                                !event.isComposing
                            ) {
                                event.preventDefault();
                                void submit();
                            }
                        }}
                    />
                    <small id="message-editor-hint">
                        {hasAttachments ? "原有图片会保留。" : ""}
                        Ctrl / ⌘ + Enter 保存
                    </small>
                </div>
                {(localError || (attempted && error)) && !locked && (
                    <p
                        id="message-editor-error"
                        class="chat-conversation-dialog-error"
                        role="alert"
                    >
                        {localError || error}
                    </p>
                )}
                <footer class="chat-conversation-dialog-actions">
                    <button type="button" disabled={locked} onClick={onDismiss}>
                        取消
                    </button>
                    <button
                        type="submit"
                        class="primary-button"
                        disabled={locked || !changed}
                    >
                        {locked
                            ? "正在保存…"
                            : isUser
                            ? "保存并生成"
                            : "保存新版本"}
                    </button>
                </footer>
            </form>
        </dialog>
    );
}
