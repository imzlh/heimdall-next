/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { createElement, useEffect, useMemo, useState } from "hono/jsx/dom";
import type { Child } from "hono/jsx";
import { parseChatMarkdown } from "../../shared/chat-markdown.ts";
import { renderChatMarkdown } from "../../shared/chat-markdown-view.ts";
import { copyChatText } from "./clipboard.ts";
import { Icon } from "../../shared/icons.tsx";

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

export function ChatMarkdown({ text }: { text: string }) {
    const blocks = useMemo(() => parseChatMarkdown(text), [text]);
    return (
        <div class="chat-markdown">
            {renderChatMarkdown<Child>(blocks, {
                text: (value) => value,
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
