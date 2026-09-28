import type {
    ChatInitial,
    ChatMessage,
} from "@heimdall/admin-contracts/chat.ts";
import {
    chatAttachmentUrl,
    chatMessageStatus,
    chatRoleLabel,
} from "../shared/chat-view.ts";
import { Icon } from "../shared/icons.tsx";
import { ChatMarkdown } from "../components/chat-markdown.tsx";

function MessageView({ message }: { message: ChatMessage }) {
    const branch = !message.callId &&
            (message.role === "user" || message.role === "assistant") &&
            message.branch && message.branch.count > 1
        ? message.branch
        : undefined;
    const branchLabel = message.role === "user" ? "提问" : "回复";
    return (
        <article
            class={`chat-message role-${message.role}`}
            data-status={message.status}
            data-message-id={message.id}
        >
            <div class="chat-message-author">{chatRoleLabel(message)}</div>
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
                    <div class="chat-attachments" aria-label="消息附件">
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
                                        附件 {index + 1} ·{" "}
                                        {attachment.mediaType}
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
            {(message.text || branch) && !message.callId && (
                <div class="chat-message-actions">
                    {branch && (
                        <span
                            class="chat-branch-counter"
                            role="status"
                            aria-label={`第 ${
                                branch.index + 1
                            } 个${branchLabel}版本，共 ${branch.count} 个`}
                        >
                            版本 {branch.index + 1}/{branch.count}
                        </span>
                    )}
                    {message.text && (
                        <button
                            type="button"
                            class="chat-small-button"
                            disabled
                        >
                            <Icon name="copy" />
                            复制
                        </button>
                    )}
                </div>
            )}
        </article>
    );
}

function EmptyState({ initial }: { initial: ChatInitial }) {
    return (
        <div class="chat-empty">
            <span class="chat-empty-mark" aria-hidden="true">H</span>
            {!initial.authenticated
                ? (
                    <>
                        <h2>登录后开始对话</h2>
                        <p>输入管理令牌，查看历史会话并发送消息。</p>
                        <form
                            class="chat-login"
                            action="/admin/session"
                            method="post"
                        >
                            <input
                                type="hidden"
                                name="returnTo"
                                value="/admin/chat"
                            />
                            <label for="chat-token">管理令牌</label>
                            <input
                                id="chat-token"
                                name="token"
                                type="password"
                                autocomplete="current-password"
                                required
                            />
                            <button class="primary-button" type="submit">
                                登录
                            </button>
                        </form>
                        <a href="/admin">返回管理面板</a>
                    </>
                )
                : !initial.available
                ? (
                    <>
                        <h2>聊天暂不可用</h2>
                        <p>{initial.error ?? "当前实例尚未启用聊天服务。"}</p>
                        <a href="/admin">返回管理面板</a>
                    </>
                )
                : initial.error
                ? (
                    <>
                        <h2>暂时无法加载对话</h2>
                        <p>{initial.error}</p>
                    </>
                )
                : (
                    <>
                        <h2>今天想聊些什么？</h2>
                        <p>
                            {initial.models.length
                                ? "选择模型，发送第一条消息开始对话。"
                                : "暂时没有可用模型，请先在管理面板配置渠道。"}
                        </p>
                        {!initial.models.length && (
                            <a href="/admin?view=channels">
                                配置渠道
                            </a>
                        )}
                    </>
                )}
        </div>
    );
}

/** Readable without JavaScript; the browser island enables chat actions. */
export function ChatPageView({ initial }: { initial: ChatInitial }) {
    const readable = initial.authenticated && initial.available;
    const conversations = readable ? initial.conversations : [];
    const messages = readable ? initial.messages : [];
    const models = readable ? initial.models : [];
    const selectedModel = models.includes(initial.selectedModel ?? "")
        ? initial.selectedModel
        : models[0];
    const hint = !initial.authenticated
        ? "登录后即可查看会话并开始聊天。"
        : !initial.available
        ? "聊天服务启用后即可开始对话。"
        : !models.length
        ? "配置可用模型后即可发送消息。"
        : "当前为只读视图。交互加载完成后即可发送消息。";
    return (
        <div class="chat-layout chat-readonly">
            <aside class="chat-sidebar" aria-label="会话">
                <div class="chat-sidebar-heading">
                    <h2>会话</h2>
                    <a
                        class="chat-icon-button"
                        href="/admin"
                        aria-label="返回管理页面"
                        title="返回管理页面"
                    >
                        <Icon name="back" />
                    </a>
                </div>
                <button class="chat-new primary-button" type="button" disabled>
                    <Icon name="plus" />新对话
                </button>
                <ul class="chat-history" aria-label="历史会话">
                    {conversations.map((conversation) => (
                        <li key={conversation.id} class="chat-conversation-row">
                            <a
                                class={`chat-conversation${
                                    conversation.id === initial.conversation?.id
                                        ? " is-active"
                                        : ""
                                }`}
                                href={`/admin/chat?id=${
                                    encodeURIComponent(conversation.id)
                                }`}
                                aria-current={conversation.id ===
                                        initial.conversation?.id
                                    ? "page"
                                    : undefined}
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
                                    disabled
                                    aria-label={`重命名 ${
                                        conversation.title || "新对话"
                                    }`}
                                    title="重命名"
                                >
                                    <Icon name="edit" />
                                </button>
                                <button
                                    type="button"
                                    class="chat-icon-button chat-delete-button"
                                    disabled
                                    aria-label={`删除 ${
                                        conversation.title || "新对话"
                                    }`}
                                    title="删除对话"
                                >
                                    <Icon name="trash" />
                                </button>
                            </div>
                        </li>
                    ))}
                    {!conversations.length && (
                        <li class="chat-history-empty">暂无历史会话</li>
                    )}
                </ul>
                <footer class="chat-sidebar-footer">
                    <a href="/admin">返回管理面板</a>
                    <button
                        class="chat-icon-button"
                        type="button"
                        disabled
                        aria-label="切换主题"
                        title="切换主题"
                    >
                        <Icon name="moon" />
                    </button>
                </footer>
            </aside>
            <section
                class="chat-main"
                id="chat-main"
                role="main"
                tabindex={-1}
                aria-labelledby="chat-title"
            >
                <header class="chat-header">
                    <div class="chat-header-title">
                        <div>
                            <h1 class="chat-title" id="chat-title">
                                {readable
                                    ? initial.conversation?.title ||
                                        "Heimdall Chat"
                                    : "Heimdall Chat"}
                            </h1>
                            <p class="chat-subtitle">与已配置的模型对话</p>
                        </div>
                    </div>
                    <div class="chat-header-actions">
                        <div class="chat-model-field">
                            <span class="sr-only" id="chat-model-label">
                                选择模型
                            </span>
                            <span
                                id="chat-model"
                                class="chat-model"
                                aria-labelledby="chat-model-label"
                            >
                                {models.length
                                    ? selectedModel || models[0]
                                    : "暂无可用模型"}
                                <Icon
                                    name="chevron-down"
                                    class="chat-model-chevron"
                                />
                            </span>
                        </div>
                        <button
                            class="chat-icon-button"
                            type="button"
                            aria-label="刷新会话"
                            title="刷新会话"
                            disabled
                        >
                            <Icon name="refresh" />
                        </button>
                    </div>
                </header>
                <div class="chat-messages" id="chat-messages">
                    {messages.length
                        ? (
                            <div class="chat-thread">
                                {initial.error && (
                                    <p class="chat-error" role="alert">
                                        {initial.error}
                                    </p>
                                )}
                                {messages.map((message) => (
                                    <MessageView
                                        key={message.id}
                                        message={message}
                                    />
                                ))}
                            </div>
                        )
                        : <EmptyState initial={initial} />}
                </div>
                <div class="chat-composer-region">
                    <form
                        class="chat-composer"
                        data-sending="false"
                        aria-label="消息输入"
                    >
                        <div class="chat-composer-input">
                            <button
                                class="chat-composer-tool chat-attach"
                                type="button"
                                aria-label="添加图片"
                                aria-busy="false"
                                title="添加图片，最多 4 张，每张 5 MiB"
                                disabled
                            >
                                <span
                                    class="chat-attach-glyph"
                                    aria-hidden="true"
                                >
                                    <span class="chat-attach-ready">
                                        <Icon name="attach" />
                                    </span>
                                    <span class="chat-attach-spinner">
                                        <Icon name="spinner" />
                                    </span>
                                </span>
                            </button>
                            <label for="chat-draft" class="sr-only">
                                消息内容
                            </label>
                            <textarea
                                id="chat-draft"
                                class="chat-draft"
                                rows={1}
                                placeholder="发送消息给 Heimdall…"
                                aria-describedby="chat-composer-hint"
                                disabled
                            />
                            <div class="chat-composer-action-slot">
                                <button
                                    class="chat-send chat-send-action"
                                    type="submit"
                                    aria-label="发送消息"
                                    title="发送消息"
                                    disabled
                                >
                                    <Icon name="send" />
                                </button>
                                <button
                                    class="chat-send chat-stop-action"
                                    type="button"
                                    aria-label="停止生成"
                                    aria-hidden="true"
                                    tabindex={-1}
                                    disabled
                                >
                                    <Icon name="stop" />
                                </button>
                            </div>
                        </div>
                    </form>
                    <div class="chat-composer-meta">
                        <p class="chat-composer-hint" id="chat-composer-hint">
                            {hint}
                        </p>
                        {messages.some((message) => message.role === "user") &&
                            (
                                <button
                                    class="chat-regenerate"
                                    type="button"
                                    aria-label="重新生成回复"
                                    disabled
                                >
                                    <Icon name="refresh" />重新生成
                                </button>
                            )}
                    </div>
                    <noscript>
                        <p class="chat-notice">
                            发送消息需要启用 JavaScript；已有会话仍可阅读。
                        </p>
                    </noscript>
                </div>
            </section>
        </div>
    );
}
