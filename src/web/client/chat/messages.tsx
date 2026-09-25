/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import { useEffect, useState } from "hono/jsx/dom";
import type { ChatMessage } from "@heimdall/admin-contracts/chat.ts";
import { chatAttachmentUrl, chatRoleLabel } from "../../shared/chat-view.ts";
import type { ChatState } from "./types.ts";
import { Icon } from "../../shared/icons.tsx";
import { ChatMarkdown } from "./markdown.tsx";
import { copyChatText } from "./clipboard.ts";

function Message(
    { message, latest }: { message: ChatMessage; latest: boolean },
) {
    const [copied, setCopied] = useState(false);
    const [copyError, setCopyError] = useState("");
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
    return (
        <article
            class={`chat-message role-${message.role}${
                latest ? " is-latest" : ""
            }`}
        >
            <p class="chat-message-author">{chatRoleLabel(message)}</p>
            <div class="chat-message-body">
                {message.text && (message.role === "assistant"
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
            {message.text && (
                <div class="chat-message-actions">
                    <button
                        type="button"
                        class={`chat-small-button${copied ? " is-copied" : ""}`}
                        onClick={() => void copy()}
                        aria-label={copied ? "消息已复制" : "复制消息"}
                    >
                        <Icon name="copy" />
                        {copied ? "已复制" : "复制"}
                    </button>
                </div>
            )}
            {copyError && <p class="chat-notice" role="status">{copyError}</p>}
        </article>
    );
}

export function ChatMessages({ state }: { state: ChatState }) {
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
                ? (
                    <div class="chat-empty">
                        <span class="chat-empty-mark" aria-hidden="true">
                            H
                        </span>
                        <h2>有什么可以帮你？</h2>
                        <p>
                            {state.models.length
                                ? "选择一个模型，从你的第一个问题开始。"
                                : "暂时没有可用模型，请先配置渠道。"}
                        </p>
                        {!state.models.length && (
                            <a href="/admin?view=channels">配置渠道</a>
                        )}
                    </div>
                )
                : null}
            {state.messages.map((message, index) => (
                <Message
                    key={message.id}
                    message={message}
                    latest={index === state.messages.length - 1}
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
                            <summary>插件调用 · {call.name}</summary>
                            <pre>{call.argumentsText || "等待参数…"}</pre>
                        </details>
                    ))}
                </div>
            )}
        </div>
    );
}
