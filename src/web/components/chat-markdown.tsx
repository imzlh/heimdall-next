import type { Child } from "hono/jsx";
import { jsx } from "hono/jsx/jsx-runtime";
import { parseChatMarkdown } from "../shared/chat-markdown.ts";
import { renderChatMarkdown } from "../shared/chat-markdown-view.ts";
import { Icon } from "../shared/icons.tsx";

/** Readable formatted history before the browser island becomes available. */
export function ChatMarkdown({ text }: { text: string }) {
    return (
        <div class="chat-markdown">
            {renderChatMarkdown<Child>(parseChatMarkdown(text), {
                text: (value) => value,
                element: (tag, { key, ...props }, children) =>
                    jsx(tag, { ...props, children }, key?.toString()),
                code: (block, key) => (
                    <div key={key} class="chat-code-block">
                        <div class="chat-code-header">
                            <span class="chat-code-language">
                                {block.language}
                            </span>
                            <button
                                type="button"
                                class="chat-small-button chat-code-copy"
                                aria-label="复制代码"
                                title="交互加载完成后可复制代码"
                                disabled
                            >
                                <Icon name="copy" />
                            </button>
                        </div>
                        <pre
                            tabindex={0}
                            aria-label={`${block.language} 代码`}
                        ><code>{block.text}</code></pre>
                    </div>
                ),
            })}
        </div>
    );
}
