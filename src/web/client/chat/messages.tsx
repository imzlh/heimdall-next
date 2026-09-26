/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useState } from "hono/jsx/dom";
import type { ChatMessage } from "@heimdall/admin-contracts/chat.ts";
import {
    chatAttachmentUrl,
    chatMessageStatus,
    chatRoleLabel,
} from "../../shared/chat-view.ts";
import type { ChatState } from "./types.ts";
import { Icon } from "../../shared/icons.tsx";
import { ChatMarkdown } from "./markdown.tsx";
import { copyChatText } from "./clipboard.ts";

function messageTime(createdAt?: string): string {
    if (!createdAt) return "";
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (input: number) => String(input).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ImageLightbox(
    { src, alt, onClose }: { src: string; alt: string; onClose: () => void },
) {
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                onClose();
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);
    return (
        <div
            class="chat-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={alt}
            onClick={onClose}
        >
            <figure
                class="chat-lightbox-stage"
                onClick={(event) => event.stopPropagation()}
            >
                <img src={src} alt={alt} />
                <button
                    type="button"
                    class="chat-lightbox-close"
                    aria-label="关闭预览"
                    onClick={onClose}
                >
                    <Icon name="close" />
                </button>
            </figure>
        </div>
    );
}

function Message(
    { message, latest, onRetry, canRetry }: {
        message: ChatMessage;
        latest: boolean;
        onRetry?: () => void;
        canRetry?: boolean;
    },
) {
    const [copied, setCopied] = useState(false);
    const [copyError, setCopyError] = useState("");
    const [lightbox, setLightbox] = useState<string | null>(null);
    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 1400);
        return () => clearTimeout(timer);
    }, [copied]);
    async function copy() {
        try {
            await copyChatText(message.text);
            setCopied(true);
            setCopyError("");
        } catch {
            setCopyError("复制失败，请选择消息文本后复制。");
        }
    }
    const time = messageTime(message.createdAt);
    return (
        <article
            class={`chat-message role-${message.role}${
                latest ? " is-latest" : ""
            }`}
            data-status={message.status}
        >
            <p class="chat-message-author">
                {chatRoleLabel(message)}
                {time && <time>{time}</time>}
            </p>
            <div class="chat-message-body">
                {message.role === "assistant" && message.callId
                    ? (
                        <details class="chat-tool-call">
                            <summary>{chatRoleLabel(message)}</summary>
                            <pre>{message.text || "无参数"}</pre>
                        </details>
                    )
                    : message.text && (message.role === "assistant"
                        ? <ChatMarkdown text={message.text} />
                        : <p class="chat-message-text">{message.text}</p>)}
                {!!message.attachments?.length && (
                    <div class="chat-attachments">
                        {message.attachments.map((attachment, index) => {
                            const url = chatAttachmentUrl(attachment);
                            return url
                                ? (
                                    <img
                                        class="chat-message-image"
                                        src={url}
                                        alt={`消息图片 ${index + 1}`}
                                        loading="lazy"
                                        onClick={() => setLightbox(url)}
                                    />
                                )
                                : (
                                    <span class="chat-attachment">
                                        图片 {index + 1} · 无法预览
                                    </span>
                                );
                        })}
                    </div>
                )}
            </div>
            {chatMessageStatus(message) && (
                <p class="chat-notice" role="status">
                    {chatMessageStatus(message)}
                </p>
            )}
            {message.status === "failed" && message.error?.message && (
                <p class="chat-notice">{message.error.message}</p>
            )}
            {!message.callId && (message.text || (latest && onRetry)) && (
                <div class="chat-message-actions">
                    {message.role === "assistant" && latest && onRetry && (
                        <button
                            type="button"
                            class="chat-small-button"
                            disabled={!canRetry}
                            onClick={onRetry}
                            aria-label="重新生成这条回复"
                            title="重新生成这条回复"
                        >
                            <Icon name="refresh" />
                            重试
                        </button>
                    )}
                    {message.text && (
                        <button
                            type="button"
                            class={`chat-small-button${
                                copied ? " is-copied" : ""
                            }`}
                            onClick={() => void copy()}
                            aria-label={copied ? "消息已复制" : "复制消息"}
                        >
                            <Icon name="copy" />
                            {copied ? "已复制" : "复制"}
                        </button>
                    )}
                </div>
            )}
            {copyError && <p class="chat-notice" role="status">{copyError}</p>}
            {lightbox && (
                <ImageLightbox
                    src={lightbox}
                    alt="消息图片预览"
                    onClose={() => setLightbox(null)}
                />
            )}
        </article>
    );
}

const STARTERS = [
    { title: "梳理想法", text: "帮我把下面的想法整理成清晰的要点：\n" },
    { title: "分析代码", text: "请帮我解释这段代码的作用和潜在问题：\n" },
    { title: "起草文案", text: "请帮我起草一段简洁的说明文字，主题是：" },
    { title: "头脑风暴", text: "围绕一个主题给我 10 个有创意的想法，主题是：" },
] as const;

function EmptyState(
    { state, onStarter }: {
        state: ChatState;
        onStarter?: (text: string) => void;
    },
) {
    return (
        <div class="chat-empty">
            <span class="chat-empty-mark" aria-hidden="true">H</span>
            <h2>有什么可以帮你？</h2>
            <p>
                {state.models.length
                    ? "选择一个模型，从你的第一个问题开始。"
                    : "暂时没有可用模型，请先配置渠道。"}
            </p>
            {!state.models.length
                ? <a href="/admin?view=channels">配置渠道</a>
                : (
                    <div class="chat-starters">
                        {STARTERS.map((starter) => (
                            <button
                                key={starter.title}
                                type="button"
                                class="chat-starter"
                                onClick={() => onStarter?.(starter.text)}
                            >
                                <strong>{starter.title}</strong>
                                <span>{starter.text.trim()}</span>
                            </button>
                        ))}
                    </div>
                )}
            <p class="chat-empty-shortcuts" aria-hidden="true">
                <kbd>Ctrl</kbd>+<kbd>N</kbd> 新对话 · <kbd>Enter</kbd> 发送 ·
                {" "}
                <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行
            </p>
        </div>
    );
}

export function ChatMessages(
    { state, onStarter, onRetry }: {
        state: ChatState;
        onStarter?: (text: string) => void;
        onRetry?: () => void;
    },
) {
    const latestIndex = state.messages.length - 1;
    const canRetry = !state.sending && !state.loading && !state.creating &&
        !state.managing && !!state.model && state.models.includes(state.model);
    return (
        <div class="chat-thread">
            {!state.available
                ? (
                    <div class="chat-empty">
                        <span class="chat-empty-mark">H</span>
                        <h2>聊天服务尚未启用</h2>
                        <p>配置完成后即可在这里开始对话。</p>
                        <a href="/admin">返回管理页面</a>
                    </div>
                )
                : !state.messages.length && !state.sending && !state.streamText
                ? <EmptyState state={state} onStarter={onStarter} />
                : null}
            {state.messages.map((message, index) => (
                <Message
                    key={message.id}
                    message={message}
                    latest={index === latestIndex}
                    onRetry={message.role === "assistant" &&
                            index === latestIndex
                        ? onRetry
                        : undefined}
                    canRetry={canRetry}
                />
            ))}
            {(state.sending || state.streamText) && (
                <article
                    class="chat-message role-assistant is-streaming"
                    aria-busy={state.sending ? "true" : "false"}
                >
                    <p class="chat-message-author">
                        {state.sending ? "Heimdall" : "Heimdall · 未完成的回复"}
                    </p>
                    <div class="chat-message-body">
                        {state.streamText
                            ? <ChatMarkdown text={state.streamText} />
                            : (
                                <p class="chat-message-text">
                                    {state.stopping ? "正在停止…" : "正在思考"}
                                    {state.sending && !state.stopping && (
                                        <span
                                            class="chat-thinking-dots"
                                            aria-hidden="true"
                                        >
                                            <i />
                                            <i />
                                            <i />
                                        </span>
                                    )}
                                </p>
                            )}
                        {state.streamText && state.sending && !state.stopping &&
                            (
                                <span
                                    class="chat-stream-caret"
                                    aria-hidden="true"
                                />
                            )}
                    </div>
                </article>
            )}
            {!!state.toolCalls.length && (
                <div class="chat-tool-calls">
                    {state.toolCalls.map((call) => (
                        <details key={call.callId} class="chat-tool-call">
                            <summary>
                                <Icon name="plugin" size={13} />
                                <span>插件调用 · {call.name}</span>
                                <small>
                                    <Icon
                                        name="chevron-down"
                                        size={12}
                                    />
                                </small>
                            </summary>
                            <pre>{call.argumentsText || "等待参数…"}</pre>
                        </details>
                    ))}
                </div>
            )}
        </div>
    );
}
