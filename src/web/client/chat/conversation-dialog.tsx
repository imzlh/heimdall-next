/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx/dom */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import { Icon } from "../../shared/icons.tsx";

export interface ConversationAction {
    readonly kind: "rename" | "delete";
    readonly id: string;
    readonly title: string;
}

/** Native dialog supplies focus containment and makes the history behind it inert. */
export function ConversationDialog(
    { action, pending, error, onSubmit, onDismiss }: {
        action: ConversationAction;
        pending: boolean;
        error: string;
        onSubmit: (title: string) => Promise<boolean>;
        onDismiss: () => void;
    },
) {
    const dialog = useRef<HTMLDialogElement | null>(null);
    const titleInput = useRef<HTMLInputElement | null>(null);
    const cancel = useRef<HTMLButtonElement | null>(null);
    const [title, setTitle] = useState(action.title);
    const [attempted, setAttempted] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const deleting = action.kind === "delete";
    const locked = pending || submitting;

    useEffect(() => {
        const trigger = document.activeElement as HTMLElement | null;
        const element = dialog.current;
        element?.showModal();
        if (deleting) cancel.current?.focus();
        else {
            titleInput.current?.focus();
            titleInput.current?.select();
        }
        return () => {
            element?.close();
            if (trigger?.isConnected && !trigger.hasAttribute("disabled")) {
                trigger.focus();
            } else {
                document.querySelector<HTMLElement>(".chat-new")?.focus();
            }
        };
    }, []);

    return (
        <dialog
            ref={dialog}
            class="chat-conversation-dialog"
            aria-labelledby="conversation-dialog-title"
            aria-describedby="conversation-dialog-description"
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
                ) {
                    onDismiss();
                }
            }}
        >
            <form
                onSubmit={async (event) => {
                    event.preventDefault();
                    if (locked) return;
                    setAttempted(true);
                    setSubmitting(true);
                    const saved = await onSubmit(title);
                    setSubmitting(false);
                    if (saved) onDismiss();
                }}
            >
                <header class="chat-conversation-dialog-heading">
                    <h2 id="conversation-dialog-title">
                        {deleting ? "删除这段对话？" : "重命名对话"}
                    </h2>
                    <button
                        type="button"
                        class="chat-icon-button"
                        aria-label="关闭"
                        disabled={locked}
                        onClick={onDismiss}
                    >
                        <Icon name="close" />
                    </button>
                </header>
                <p
                    id="conversation-dialog-description"
                    class="chat-conversation-description"
                >
                    {deleting
                        ? (
                            <>
                                “{action.title ||
                                    "新对话"}”及其中的消息和附件将被永久删除，无法恢复。
                            </>
                        )
                        : "取一个方便回顾和查找的名字。"}
                </p>
                {!deleting && (
                    <div class="chat-conversation-name-field">
                        <label for="conversation-name">会话名称</label>
                        <input
                            ref={titleInput}
                            id="conversation-name"
                            name="title"
                            value={title}
                            required
                            maxLength={120}
                            autoComplete="off"
                            disabled={locked}
                            aria-describedby="conversation-name-hint"
                            aria-invalid={attempted && !!error
                                ? "true"
                                : undefined}
                            onInput={(event) =>
                                setTitle(
                                    (event.currentTarget as HTMLInputElement)
                                        .value,
                                )}
                        />
                        <small id="conversation-name-hint">
                            最多 120 个字符
                        </small>
                    </div>
                )}
                {attempted && error && !locked && (
                    <p class="chat-conversation-dialog-error" role="alert">
                        {error}
                    </p>
                )}
                <footer class="chat-conversation-dialog-actions">
                    <button
                        ref={cancel}
                        type="button"
                        disabled={locked}
                        onClick={onDismiss}
                    >
                        取消
                    </button>
                    <button
                        type="submit"
                        class={deleting
                            ? "chat-delete-confirm"
                            : "primary-button"}
                        disabled={locked}
                    >
                        {locked
                            ? deleting ? "正在删除…" : "正在保存…"
                            : deleting
                            ? "删除对话"
                            : "保存名称"}
                    </button>
                </footer>
            </form>
        </dialog>
    );
}
