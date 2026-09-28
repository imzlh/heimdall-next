/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useLayoutEffect, useRef, useState } from "hono/jsx/dom";
import { chatAttachmentUrl } from "../../shared/chat-view.ts";
import { CHAT_ATTACHMENT_ACCEPT } from "./attachments.ts";
import {
    composerKeyAction,
    insertComposerNewline,
    resizeComposerInput,
} from "./composer-behavior.ts";
import type { ChatController, ChatState } from "./types.ts";
import { Icon } from "../../shared/icons.tsx";
import type { IconName } from "../../shared/icons.tsx";

const EFFORT_OPTIONS = [
    {
        value: "low",
        label: "快速",
        hint: "更快的回答，更少的推理",
        icon: "zap",
    },
    {
        value: "medium",
        label: "默认",
        hint: "速度与深度的平衡",
        icon: "gauge",
    },
    {
        value: "high",
        label: "深入",
        hint: "更充分的推理，回答更慢",
        icon: "brain",
    },
] as const satisfies readonly {
    value: "low" | "medium" | "high";
    label: string;
    hint: string;
    icon: IconName;
}[];

export function ChatComposer(
    { state, controller }: { state: ChatState; controller: ChatController },
) {
    const fileInput = useRef<HTMLInputElement | null>(null);
    const draftInput = useRef<HTMLTextAreaElement | null>(null);
    const assetsButton = useRef<HTMLButtonElement | null>(null);
    const assetsPanel = useRef<HTMLDivElement | null>(null);
    const effortButton = useRef<HTMLButtonElement | null>(null);
    const effortMenu = useRef<HTMLDivElement | null>(null);
    const previousAttachments = useRef({
        count: state.attachments.length,
        conversation: state.selectedId,
    });
    const [assetsOpen, setAssetsOpen] = useState(false);
    const [effortOpen, setEffortOpen] = useState(false);
    const busy = state.loading || state.creating || state.sending ||
        state.managing;
    const disabled = !state.available || !state.authenticated || busy ||
        state.attachmentsBusy;
    const hasModel = !!state.model && state.models.includes(state.model);
    const canSend = !disabled && hasModel && !!state.draft.trim();
    // Reasoning effort rides with the conversation; a fresh unsaved chat keeps
    // the picked value in the controller and applies it once the chat exists.
    const effort = state.conversation
        ? state.conversation.reasoningEffort ?? "medium"
        : state.pendingEffort;
    const effortMeta =
        EFFORT_OPTIONS.find((option) => option.value === effort) ??
            EFFORT_OPTIONS.find((option) => option.value === "medium")!;
    const effortLocked = disabled;

    // Drafts also change after server acknowledgement, failed sends and history
    // selection. Resize those updates too, not just physical keystrokes.
    useLayoutEffect(() => {
        if (draftInput.current) resizeComposerInput(draftInput.current);
    }, [state.draft, state.selectedId, state.attachments.length]);

    useEffect(() => {
        const input = draftInput.current;
        if (!input) return;
        let width = input.getBoundingClientRect().width;
        let frame = 0;
        const resize = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => resizeComposerInput(input));
        };
        // Focusing expands the island without a window resize. Re-measure line
        // wrapping as its width changes, while ignoring our own height updates.
        const observer = typeof ResizeObserver === "undefined"
            ? undefined
            : new ResizeObserver(() => {
                const nextWidth = input.getBoundingClientRect().width;
                if (Math.abs(nextWidth - width) < 0.5) return;
                width = nextWidth;
                resize();
            });
        observer?.observe(input);
        globalThis.addEventListener("resize", resize);
        return () => {
            observer?.disconnect();
            globalThis.removeEventListener("resize", resize);
            cancelAnimationFrame(frame);
        };
    }, []);

    useEffect(() => {
        const previous = previousAttachments.current;
        if (
            !previous || state.selectedId !== previous.conversation ||
            state.attachments.length === 0
        ) {
            setAssetsOpen(false);
        } else if (state.attachments.length > previous.count) {
            setAssetsOpen(true);
        }
        previousAttachments.current = {
            count: state.attachments.length,
            conversation: state.selectedId,
        };
    }, [state.attachments.length, state.selectedId]);

    useEffect(() => {
        if (!assetsOpen) return;
        const outside = (event: PointerEvent) => {
            const target = event.target as Node | null;
            if (
                !assetsPanel.current?.contains(target) &&
                !assetsButton.current?.contains(target)
            ) setAssetsOpen(false);
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setAssetsOpen(false);
            (assetsButton.current ?? draftInput.current)?.focus();
        };
        document.addEventListener("pointerdown", outside);
        document.addEventListener("keydown", escape);
        return () => {
            document.removeEventListener("pointerdown", outside);
            document.removeEventListener("keydown", escape);
        };
    }, [assetsOpen]);

    useEffect(() => {
        if (!effortOpen) return;
        const outside = (event: PointerEvent) => {
            const target = event.target as Node | null;
            if (
                !effortMenu.current?.contains(target) &&
                !effortButton.current?.contains(target)
            ) setEffortOpen(false);
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            if (document.querySelector("dialog[open]")) return;
            event.preventDefault();
            setEffortOpen(false);
            effortButton.current?.focus();
        };
        document.addEventListener("pointerdown", outside);
        document.addEventListener("keydown", escape);
        return () => {
            document.removeEventListener("pointerdown", outside);
            document.removeEventListener("keydown", escape);
        };
    }, [effortOpen]);

    function chooseFiles(event: Event) {
        const input = event.currentTarget as HTMLInputElement;
        const files = Array.from(input.files ?? []);
        input.value = "";
        if (files.length) void controller.addAttachments(files);
    }

    function chooseEffort(next: "low" | "medium" | "high") {
        setEffortOpen(false);
        effortButton.current?.focus();
        if (next === effort) return;
        controller.chooseEffort(next);
    }

    function submit() {
        if (!canSend) return;
        // Clicking send should leave the cursor in the same surface when its
        // button crossfades into stop, just as sending with Enter does.
        draftInput.current?.focus();
        void controller.send();
    }

    function keydown(event: KeyboardEvent) {
        const action = composerKeyAction(event);
        if (action === "none") return;
        event.preventDefault();
        if (action === "send") {
            submit();
            return;
        }
        const input = event.currentTarget as HTMLTextAreaElement;
        const { text, caret } = insertComposerNewline(
            input.value,
            input.selectionStart,
            input.selectionEnd,
        );
        input.value = text;
        input.setSelectionRange(caret, caret);
        controller.setDraft(text);
        resizeComposerInput(input);
    }

    // Status line under the capsule; collapsed entirely when there is nothing
    // to say so the capsule rests near the bottom edge.
    const metaStatus = state.attachmentsBusy
        ? "正在上传图片…"
        : state.attachments.length && !state.draft.trim()
        ? "添加一段文字后发送图片"
        : "";

    return (
        <div class="chat-composer-region">
            <form
                class="chat-composer"
                data-sending={state.sending ? "true" : "false"}
                aria-label="发送消息"
                onSubmit={(event) => {
                    event.preventDefault();
                    submit();
                }}
            >
                <div class="chat-composer-input">
                    <input
                        type="file"
                        ref={fileInput}
                        hidden
                        multiple
                        accept={CHAT_ATTACHMENT_ACCEPT}
                        onChange={chooseFiles}
                        disabled={disabled}
                        aria-label="选择 PNG、JPEG、WebP 或 GIF 图片"
                    />
                    <button
                        type="button"
                        class="chat-composer-tool chat-attach"
                        onClick={() => fileInput.current?.click()}
                        disabled={disabled || state.attachments.length >= 4}
                        aria-label="添加图片"
                        aria-busy={state.attachmentsBusy ? "true" : "false"}
                        title={state.attachmentsBusy
                            ? "正在上传图片…"
                            : "添加图片，最多 4 张，每张 5 MiB"}
                    >
                        <span class="chat-attach-glyph" aria-hidden="true">
                            <span class="chat-attach-ready">
                                <Icon name="attach" />
                            </span>
                            <span class="chat-attach-spinner">
                                <Icon name="spinner" />
                            </span>
                        </span>
                    </button>
                    <button
                        ref={effortButton}
                        type="button"
                        class="chat-composer-tool chat-effort-toggle"
                        onClick={() => setEffortOpen(!effortOpen)}
                        aria-expanded={effortOpen ? "true" : "false"}
                        aria-haspopup="menu"
                        aria-controls="chat-effort-menu"
                        disabled={effortLocked}
                        aria-label={`思考等级：${effortMeta.label}`}
                        title={`思考等级：${effortMeta.label}（${effortMeta.hint}）`}
                    >
                        <Icon name={effortMeta.icon} />
                    </button>
                    {!!state.attachments.length && (
                        <button
                            ref={assetsButton}
                            type="button"
                            class="chat-composer-tool chat-assets-toggle"
                            onClick={() => setAssetsOpen(!assetsOpen)}
                            aria-expanded={assetsOpen ? "true" : "false"}
                            aria-controls="chat-assets-panel"
                            aria-label={`管理 ${state.attachments.length} 张图片`}
                            title={`已添加 ${state.attachments.length} 张图片`}
                        >
                            <Icon name="image" />
                            <span class="chat-assets-count" aria-hidden="true">
                                {state.attachments.length}
                            </span>
                        </button>
                    )}
                    <label class="sr-only" for="chat-draft">消息内容</label>
                    <textarea
                        ref={draftInput}
                        id="chat-draft"
                        class="chat-draft"
                        rows={1}
                        placeholder={state.attachments.length
                            ? "描述你想了解的图片内容…"
                            : "发送消息给 Heimdall…"}
                        value={state.draft}
                        disabled={!state.available || !state.authenticated ||
                            state.loading || state.creating}
                        onInput={(event) =>
                            controller.setDraft(
                                (event.currentTarget as HTMLTextAreaElement)
                                    .value,
                            )}
                        onKeyDown={keydown}
                        aria-describedby={metaStatus
                            ? "chat-composer-hint"
                            : undefined}
                        aria-keyshortcuts="Enter Shift+Enter Control+Enter Meta+Enter"
                    />
                    <div class="chat-composer-action-slot">
                        <button
                            type="submit"
                            class="chat-send chat-send-action"
                            disabled={!canSend}
                            tabIndex={state.sending ? -1 : 0}
                            aria-hidden={state.sending ? "true" : "false"}
                            aria-label="发送消息"
                            title="发送消息（Enter）"
                        >
                            <Icon name="send" />
                        </button>
                        <button
                            type="button"
                            class="chat-send chat-stop-action"
                            disabled={!state.sending || state.stopping}
                            tabIndex={state.sending ? 0 : -1}
                            onClick={() => {
                                draftInput.current?.focus();
                                controller.stop();
                            }}
                            aria-hidden={state.sending ? "false" : "true"}
                            aria-busy={state.stopping ? "true" : "false"}
                            aria-label={state.stopping
                                ? "正在停止"
                                : "停止生成"}
                            title={state.stopping ? "正在停止…" : "停止生成"}
                        >
                            <Icon name="stop" />
                        </button>
                    </div>
                </div>
                <div
                    ref={effortMenu}
                    id="chat-effort-menu"
                    class="chat-effort-popover"
                    data-open={effortOpen ? "true" : "false"}
                    role="menu"
                    aria-label="思考等级"
                    aria-hidden={effortOpen ? "false" : "true"}
                    inert={!effortOpen}
                >
                    {EFFORT_OPTIONS.map((option) => (
                        <button
                            key={option.value}
                            type="button"
                            role="menuitemradio"
                            aria-checked={effort === option.value
                                ? "true"
                                : "false"}
                            class="chat-effort-option"
                            disabled={effortLocked}
                            onClick={() => chooseEffort(option.value)}
                        >
                            <Icon name={option.icon} />
                            <span>
                                <strong>{option.label}</strong>
                                <small>{option.hint}</small>
                            </span>
                            {effort === option.value && <Icon name="check" />}
                        </button>
                    ))}
                </div>
                <div
                    ref={assetsPanel}
                    id="chat-assets-panel"
                    class="chat-assets-popover"
                    data-open={assetsOpen ? "true" : "false"}
                    role="region"
                    aria-label="待发送图片"
                    aria-hidden={assetsOpen ? "false" : "true"}
                    inert={!assetsOpen}
                >
                    <div class="chat-assets-heading">
                        <span>待发送图片</span>
                        <small>{state.attachments.length} / 4</small>
                        <button
                            type="button"
                            class="chat-composer-tool"
                            onClick={() => {
                                setAssetsOpen(false);
                                assetsButton.current?.focus();
                            }}
                            aria-label="收起图片列表"
                            disabled={!assetsOpen}
                        >
                            <Icon name="close" />
                        </button>
                    </div>
                    <ul class="chat-draft-attachments">
                        {state.attachments.map((attachment, index) => (
                            <li class="chat-draft-attachment" key={index}>
                                <img
                                    src={chatAttachmentUrl(attachment)}
                                    alt={`待发送图片 ${index + 1}`}
                                />
                                <span>
                                    图片 {index + 1}
                                    <small>
                                        {attachment.mediaType.slice(6)
                                            .toUpperCase()}
                                    </small>
                                </span>
                                <button
                                    type="button"
                                    class="chat-remove-image chat-composer-tool"
                                    onClick={() => {
                                        controller.removeAttachment(index);
                                        if (state.attachments.length === 1) {
                                            draftInput.current?.focus();
                                        }
                                    }}
                                    disabled={disabled || !assetsOpen}
                                    aria-label={`移除图片 ${index + 1}`}
                                    title="移除图片"
                                >
                                    <Icon name="close" />
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            </form>
            {metaStatus && (
                <div class="chat-composer-meta">
                    <p id="chat-composer-hint" class="chat-composer-hint">
                        {metaStatus}
                    </p>
                </div>
            )}
        </div>
    );
}
