/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useState } from "hono/jsx/dom";
import type {
    ChatActivity,
    ChatAttachment,
    ChatCitation,
    ChatMessage,
} from "@heimdall/admin-contracts/chat.ts";
import {
    chatAttachmentUrl,
    chatMessageStatus,
    chatRoleLabel,
} from "../../shared/chat-view.ts";
import type { ChatState } from "./types.ts";
import { Icon } from "../../shared/icons.tsx";
import { ChatMarkdown } from "./markdown.tsx";
import { copyChatText } from "./clipboard.ts";

/** One-line cloud-activity chips (e.g. "🔍 搜索：…") shown above a reply. */
function ChatActivityList(
    { items }: { items: readonly ChatActivity[] },
) {
    if (!items.length) return null;
    return (
        <ul class="chat-activity" aria-label="云端活动">
            {items.map((item, index) => (
                <li key={index} class="chat-activity-item">{item.summary}</li>
            ))}
        </ul>
    );
}

/** Collapsible public reasoning transcript shown above a reply. */
function ChatReasoning({ text }: { text: string }) {
    if (!text.trim()) return null;
    return (
        <details class="chat-reasoning">
            <summary>思考过程</summary>
            <ChatMarkdown text={text} />
        </details>
    );
}

/** The host shown beside a source link, e.g. "example.com"; empty when unparsable. */
function citationHost(url?: string): string {
    if (!url) return "";
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
}

/** Collapse repeated sources (same url, else same label) so the list stays tight. */
function dedupeCitations(
    items: readonly ChatCitation[],
): readonly ChatCitation[] {
    const seen = new Set<string>();
    const unique: ChatCitation[] = [];
    for (const item of items) {
        const key = (item.url ?? item.label ?? "").trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        unique.push(item);
    }
    return unique;
}

/**
 * Sources under a reply, folded into a collapsed disclosure so a long or
 * repetitive citation list never crowds the answer. Deduped first.
 */
function ChatCitations(
    { items }: { items: readonly ChatCitation[] },
) {
    const sources = dedupeCitations(items);
    if (!sources.length) return null;
    return (
        <details class="chat-sources">
            <summary>
                <Icon name="external-link" size={13} />
                <span>来源 · {sources.length}</span>
                <Icon
                    name="chevron-down"
                    size={12}
                    class="chat-sources-caret"
                />
            </summary>
            <ol class="chat-sources-list" aria-label="引用来源">
                {sources.map((item, index) => {
                    const label = item.label ?? item.url ?? `来源 ${index + 1}`;
                    const host = citationHost(item.url);
                    // Only append the host when the label is a real title, not
                    // the bare URL — otherwise it just repeats the domain.
                    const showHost = host && label !== item.url;
                    return (
                        <li key={index} class="chat-source">
                            <span class="chat-source-index" aria-hidden="true">
                                {index + 1}
                            </span>
                            {item.url
                                ? (
                                    <a
                                        class="chat-source-link"
                                        href={item.url}
                                        title={item.url}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                    >
                                        <span class="chat-source-label">
                                            {label}
                                        </span>
                                        {showHost && (
                                            <span class="chat-source-host">
                                                {host}
                                            </span>
                                        )}
                                    </a>
                                )
                                : (
                                    <span class="chat-source-label">
                                        {label}
                                    </span>
                                )}
                        </li>
                    );
                })}
            </ol>
        </details>
    );
}

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
    {
        message,
        latest,
        canChange,
        canGenerate,
        onRetry,
        onContinue,
        onEdit,
        onFork,
        onSwitchBranch,
        onReference,
        onDelete,
    }: {
        message: ChatMessage;
        latest: boolean;
        canChange: boolean;
        canGenerate: boolean;
        onRetry?: () => void;
        onContinue?: () => void;
        onEdit?: () => void;
        onFork?: () => void;
        onSwitchBranch?: (messageId: string) => void;
        onReference?: (attachment: ChatAttachment) => void;
        onDelete?: () => void;
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
    const branch = message.branch;
    const branchLabel = message.role === "user" ? "提问" : "回复";
    const previousId = branch?.messageIds[branch.index - 1];
    const nextId = branch?.messageIds[branch.index + 1];
    const showActions = !message.callId &&
        (message.text || message.attachments?.length || onRetry || onEdit ||
            onDelete || onFork || (branch && branch.count > 1));
    return (
        <article
            class={`chat-message role-${message.role}${
                latest ? " is-latest" : ""
            }`}
            data-status={message.status}
            data-message-id={message.id}
        >
            <p class="chat-message-author">
                {chatRoleLabel(message)}
                {time && <time>{time}</time>}
            </p>
            <div class="chat-message-body">
                {message.role === "assistant" && !message.callId && (
                    <>
                        {!!message.activity?.length && (
                            <ChatActivityList items={message.activity} />
                        )}
                        {message.reasoning && (
                            <ChatReasoning text={message.reasoning} />
                        )}
                    </>
                )}
                {message.role === "assistant" && message.callId
                    ? (
                        <details class="chat-tool-call">
                            <summary>
                                <Icon name="plugin" size={13} />
                                <span>{chatRoleLabel(message)}</span>
                                <Icon
                                    name="chevron-down"
                                    size={12}
                                    class="chat-tool-call-caret"
                                />
                            </summary>
                            <pre>{message.text || "无参数"}</pre>
                        </details>
                    )
                    : message.text && (message.role === "assistant"
                        ? (
                            <ChatMarkdown
                                text={message.text}
                                citations={message.citations}
                            />
                        )
                        : <p class="chat-message-text">{message.text}</p>)}
                {message.role === "assistant" && !message.callId &&
                    !!message.citations?.length && (
                    <ChatCitations items={message.citations} />
                )}
                {!!message.attachments?.length && (
                    <div class="chat-attachments">
                        {message.attachments.map((attachment, index) => {
                            const url = chatAttachmentUrl(attachment);
                            return url
                                ? (
                                    <figure class="chat-message-attachment">
                                        <button
                                            type="button"
                                            class="chat-image-preview"
                                            aria-label={`预览第 ${
                                                index + 1
                                            } 张图片`}
                                            onClick={() => setLightbox(url)}
                                        >
                                            <img
                                                class="chat-message-image"
                                                src={url}
                                                alt={`消息图片 ${index + 1}`}
                                                loading="lazy"
                                            />
                                        </button>
                                        {"assetId" in attachment &&
                                            attachment.assetId && onReference &&
                                            (
                                                <figcaption>
                                                    <button
                                                        type="button"
                                                        class="chat-small-button chat-reference-button"
                                                        disabled={!canChange}
                                                        title="将这张图片放入输入框，作为下一条消息的参考图"
                                                        aria-label={`将第 ${
                                                            index + 1
                                                        } 张图片作为参考图`}
                                                        onClick={() =>
                                                            onReference(
                                                                attachment,
                                                            )}
                                                    >
                                                        <Icon
                                                            name="image"
                                                            size={14}
                                                        />
                                                        作为参考图
                                                    </button>
                                                </figcaption>
                                            )}
                                    </figure>
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
            {showActions && (
                <div
                    class="chat-message-actions"
                    role="group"
                    aria-label="消息操作"
                >
                    {branch && branch.count > 1 && (
                        <div
                            class="chat-branch-controls"
                            role="group"
                            aria-label={`${branchLabel}版本`}
                        >
                            <button
                                type="button"
                                class="chat-small-button chat-message-icon"
                                disabled={!canChange || !previousId ||
                                    !onSwitchBranch}
                                title={`上一个${branchLabel}版本`}
                                aria-label={`上一个${branchLabel}版本`}
                                onClick={() =>
                                    previousId && onSwitchBranch?.(previousId)}
                            >
                                <Icon name="arrow-left" size={14} />
                            </button>
                            <span
                                class="chat-branch-counter"
                                role="status"
                                aria-label={`第 ${
                                    branch.index + 1
                                } 个${branchLabel}版本，共 ${branch.count} 个`}
                            >
                                {branch.index + 1}/{branch.count}
                            </span>
                            <button
                                type="button"
                                class="chat-small-button chat-message-icon"
                                disabled={!canChange || !nextId ||
                                    !onSwitchBranch}
                                title={`下一个${branchLabel}版本`}
                                aria-label={`下一个${branchLabel}版本`}
                                onClick={() =>
                                    nextId && onSwitchBranch?.(nextId)}
                            >
                                <Icon name="arrow-right" size={14} />
                            </button>
                        </div>
                    )}
                    {onContinue && (
                        <button
                            type="button"
                            class="chat-small-button chat-continue-button"
                            disabled={!canGenerate}
                            onClick={onContinue}
                            aria-label="继续生成这条回复"
                            title="接着这条回复继续生成"
                        >
                            <Icon name="chevron-right" size={14} />
                            继续
                        </button>
                    )}
                    {onRetry && (
                        <button
                            type="button"
                            class="chat-small-button chat-message-icon"
                            disabled={!canGenerate}
                            onClick={onRetry}
                            aria-label="重新生成这条回复"
                            title="重新生成，保留当前回复"
                        >
                            <Icon name="refresh" size={14} />
                        </button>
                    )}
                    {onEdit && (
                        <button
                            type="button"
                            class="chat-small-button chat-message-icon"
                            disabled={message.role === "user"
                                ? !canGenerate
                                : !canChange}
                            onClick={onEdit}
                            aria-label="编辑消息并新建分支"
                            title="编辑消息并新建分支"
                        >
                            <Icon name="edit" size={14} />
                        </button>
                    )}
                    {message.text && (
                        <button
                            type="button"
                            class={`chat-small-button chat-message-icon${
                                copied ? " is-copied" : ""
                            }`}
                            onClick={() => void copy()}
                            aria-label={copied ? "消息已复制" : "复制消息"}
                            title={copied ? "消息已复制" : "复制消息"}
                        >
                            <Icon name={copied ? "check" : "copy"} size={14} />
                        </button>
                    )}
                    {onFork && (
                        <button
                            type="button"
                            class="chat-small-button chat-message-icon"
                            disabled={!canChange}
                            onClick={onFork}
                            aria-label="从此处创建新会话"
                            title="将截至这条消息的内容复制到新会话"
                        >
                            <Icon name="chat" size={14} />
                        </button>
                    )}
                    {onDelete && (
                        <button
                            type="button"
                            class="chat-small-button chat-message-icon chat-message-delete"
                            disabled={!canChange}
                            onClick={onDelete}
                            aria-label={`删除这条${
                                message.role === "user" ? "提问" : "回复"
                            }`}
                            title="删除这条消息"
                        >
                            <Icon name="trash" size={14} />
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
                    <>
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
                        <p class="chat-empty-hint">
                            <kbd>Enter</kbd> 发送 · <kbd>Shift / Ctrl / ⌘</kbd>
                            + <kbd>Enter</kbd> 换行
                        </p>
                    </>
                )}
        </div>
    );
}

export function ChatMessages(
    {
        state,
        onStarter,
        onRetry,
        onContinue,
        onEditMessage,
        onForkMessage,
        onSwitchBranch,
        onReference,
        onDeleteMessage,
    }: {
        state: ChatState;
        onStarter?: (text: string) => void;
        onRetry?: (messageId: string) => void;
        onContinue?: (messageId: string) => void;
        onEditMessage?: (message: ChatMessage) => void;
        onForkMessage?: (messageId: string) => void;
        onSwitchBranch?: (messageId: string) => void;
        onReference?: (attachment: ChatAttachment) => void;
        onDeleteMessage?: (messageId: string) => void;
    },
) {
    const latestIndex = state.messages.length - 1;
    const canChange = state.available && state.authenticated &&
        !state.sending && !state.loading && !state.creating &&
        !state.managing && !state.attachmentsBusy;
    const canGenerate = canChange && !!state.model &&
        state.models.includes(state.model);
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
            {state.messages.map((message, index) => {
                const editable = !message.callId &&
                    (message.role === "user" || message.role === "assistant");
                return (
                    <Message
                        key={message.id}
                        message={message}
                        latest={index === latestIndex}
                        canChange={canChange}
                        canGenerate={canGenerate}
                        onRetry={editable && message.role === "assistant" &&
                                onRetry
                            ? () => onRetry(message.id)
                            : undefined}
                        onContinue={editable && message.role === "assistant" &&
                                index === latestIndex && message.text.trim() &&
                                onContinue
                            ? () => onContinue(message.id)
                            : undefined}
                        onEdit={editable && onEditMessage
                            ? () => onEditMessage(message)
                            : undefined}
                        onFork={editable && onForkMessage
                            ? () => onForkMessage(message.id)
                            : undefined}
                        onSwitchBranch={editable ? onSwitchBranch : undefined}
                        onReference={onReference}
                        onDelete={editable && onDeleteMessage
                            ? () => onDeleteMessage(message.id)
                            : undefined}
                    />
                );
            })}
            {(state.sending || state.streamText) && (
                <article
                    class="chat-message role-assistant is-streaming"
                    aria-busy={state.sending ? "true" : "false"}
                >
                    <p class="chat-message-author">
                        {state.sending ? "Heimdall" : "Heimdall · 未完成的回复"}
                    </p>
                    <div class="chat-message-body">
                        {!!state.streamActivity.length && (
                            <ChatActivityList items={state.streamActivity} />
                        )}
                        {state.streamReasoning && (
                            <ChatReasoning text={state.streamReasoning} />
                        )}
                        {state.streamText
                            ? (
                                <ChatMarkdown
                                    text={state.streamText}
                                    citations={state.streamCitations}
                                />
                            )
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
                        {!!state.streamCitations.length && (
                            <ChatCitations items={state.streamCitations} />
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
                                <Icon
                                    name="chevron-down"
                                    size={12}
                                    class="chat-tool-call-caret"
                                />
                            </summary>
                            <pre>{call.argumentsText || "等待参数…"}</pre>
                        </details>
                    ))}
                </div>
            )}
        </div>
    );
}
