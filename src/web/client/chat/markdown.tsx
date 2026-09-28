/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { createElement, useEffect, useMemo, useState } from "hono/jsx/dom";
import type { Child } from "hono/jsx";
import type { ChatCitation } from "@heimdall/admin-contracts/chat.ts";
import {
    chatCitationAria,
    type ChatCitationItem,
    chatCitationLabel,
    parseChatMarkdown,
    splitChatCitations,
} from "../../shared/chat-markdown.ts";
import { renderChatMarkdown } from "../../shared/chat-markdown-view.ts";
import { copyChatText } from "./clipboard.ts";
import { Icon } from "../../shared/icons.tsx";

/** Index the reply's sources by the marker id inline `cite…` badges point at. */
function citationsByRef(
    citations: readonly ChatCitation[],
): Map<string, ChatCitation> {
    const map = new Map<string, ChatCitation>();
    for (const citation of citations) {
        if (citation.ref && citation.url) map.set(citation.ref, citation);
    }
    return map;
}

/** One inline citation badge, linked to its source when the marker resolves. */
function CitationBadge(
    { item, citation, order }: {
        item: ChatCitationItem;
        citation?: ChatCitation;
        order: number;
    },
) {
    const label = chatCitationLabel([item]);
    const aria = chatCitationAria([item]);
    const inner = (
        <>
            <Icon name="search" size={11} />
            {label}
        </>
    );
    // A resolved source becomes a real hyperlink whose tooltip is the site
    // title; an unresolved marker stays the plain round-number badge.
    return citation?.url
        ? (
            <a
                key={order}
                class="chat-cite chat-cite-link"
                href={citation.url}
                title={citation.label ?? citation.url}
                aria-label={citation.label ?? aria}
                target="_blank"
                rel="noreferrer noopener"
            >
                {inner}
            </a>
        )
        : (
            <span
                key={order}
                class="chat-cite"
                role="img"
                aria-label={aria}
                title={aria}
            >
                {inner}
            </span>
        );
}

/**
 * Split prose from citation runs. Each marker in a run becomes its own badge so
 * it can link to the exact source it cites; when the reply carries the matching
 * source the badge is a hyperlink, otherwise it stays a plain round-number tag.
 */
function textWithCitations(
    value: string,
    byRef: Map<string, ChatCitation>,
): Child {
    const parts = splitChatCitations(value);
    const first = parts[0];
    if (parts.length === 1 && first?.kind === "text") return first.text;
    let order = 0;
    return parts.flatMap((part): Child[] =>
        part.kind === "text"
            ? [part.text]
            : part.items.map((item) => (
                <CitationBadge
                    item={item}
                    citation={byRef.get(item.id)}
                    order={order++}
                />
            ))
    );
}

function CodeBlock({ language, text }: { language: string; text: string }) {
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 1400);
        return () => clearTimeout(timer);
    }, [copied]);
    useEffect(() => {
        setCopied(false);
        setError("");
    }, [text]);
    async function copy() {
        try {
            // The payload is the displayed code, never a model-supplied attribute.
            await copyChatText(text);
            setCopied(true);
            setError("");
        } catch {
            setError("复制失败，请选中代码后复制。");
        }
    }
    return (
        <div class="chat-code-block">
            <div class="chat-code-header">
                <span class="chat-code-language">{language}</span>
                <button
                    type="button"
                    class={`chat-small-button chat-code-copy${
                        copied ? " is-copied" : ""
                    }`}
                    aria-label={copied ? "代码已复制" : "复制代码"}
                    title={copied ? "已复制" : "复制代码"}
                    onClick={() => void copy()}
                >
                    <Icon name={copied ? "check" : "copy"} />
                </button>
            </div>
            <pre
                tabindex={0}
                aria-label={`${language} 代码`}
            ><code>{text}</code></pre>
            {error && <p class="chat-code-error" role="status">{error}</p>}
        </div>
    );
}

export function ChatMarkdown(
    { text, citations }: {
        text: string;
        citations?: readonly ChatCitation[];
    },
) {
    const blocks = useMemo(() => parseChatMarkdown(text), [text]);
    const byRef = useMemo(
        () => citationsByRef(citations ?? []),
        [citations],
    );
    return (
        <div class="chat-markdown">
            {renderChatMarkdown<Child>(blocks, {
                text: (value) => textWithCitations(value, byRef),
                element: (tag, props, children) =>
                    createElement(tag, props, ...children),
                code: (block, key) => (
                    <CodeBlock
                        key={key}
                        language={block.language}
                        text={block.text}
                    />
                ),
            })}
        </div>
    );
}
