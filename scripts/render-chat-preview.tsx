import { raw } from "hono/html";
import { ChatShell } from "../src/web/components/chat-shell.tsx";
import { ChatPageView } from "../src/web/pages/chat.tsx";
import { chatPreview } from "./chat-preview-data.ts";
import {
    ChatComposerStates,
    composerPreviewCss,
} from "./chat-preview-composer.tsx";

const previewCss = `
.chat-body { height: auto; min-height: 100dvh; overflow: auto; }
.chat-preview-banner { flex: 0 0 auto; padding: 12px 24px; border-bottom: 1px solid var(--border); background: var(--accent-soft); }
.chat-preview-banner h2 { font-size: 14px; }
.chat-preview-banner p { margin-top: 3px; font-size: 12px; }
.chat-preview-banner a { margin-left: 12px; white-space: nowrap; }
.chat-body #heimdall-chat { height: min(880px, calc(100dvh - 112px)); min-height: 640px; }
.chat-body .chat-layout { height: 100%; min-height: 0; }
.chat-body .chat-composer-hint, .chat-body noscript { display: none; }
@media (max-width: 700px) {
    .chat-preview-banner { padding: 12px 16px; }
    .chat-preview-banner a { display: inline-block; margin-left: 0; margin-right: 12px; }
    .chat-body #heimdall-chat { height: 800px; min-height: 720px; }
}
`;

function PreviewDocument(
    { theme, css }: { theme: "light" | "dark"; css: string },
) {
    return (
        <ChatShell
            theme={theme}
            stylesheet=""
            head={
                <>
                    <meta
                        http-equiv="Content-Security-Policy"
                        content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"
                    />
                    <style>{raw(css)}</style>
                </>
            }
        >
            <aside
                id="preview-top"
                class="chat-preview-banner"
                aria-labelledby="preview-title"
            >
                <h2 id="preview-title">
                    Heimdall Chat · 设计预览 · 示例数据 ·{" "}
                    {theme === "light" ? "浅色主题" : "深色主题"}
                </h2>
                <p>
                    可离线阅读，所有操作已禁用。历史条目仅定位当前示例。
                    <a href="#chat-messages">查看消息、代码与表格</a>
                    <a href="#composer-states">查看输入框状态</a>
                </p>
                <p>
                    复用实际服务端组件与样式；未加载浏览器交互，不代表真实浏览器验收。
                </p>
            </aside>
            <div id="heimdall-chat">
                <ChatPageView initial={chatPreview} />
            </div>
            <ChatComposerStates />
        </ChatShell>
    );
}

const root = new URL("../", import.meta.url);
const css = (await Promise.all(
    ["style.css", "chat/messages.css", "chat/composer.css", "chat.css"].map((
        name,
    ) => Deno.readTextFile(new URL(`src/web/client/${name}`, root))),
)).join("\n") + previewCss + composerPreviewCss;
if (/@import\b|url\s*\(/i.test(css)) {
    throw new Error("Chat preview CSS must be self-contained");
}
const output = new URL("docs/previews/", root);
await Deno.mkdir(output, { recursive: true });
for (const theme of ["light", "dark"] as const) {
    const rendered = (<PreviewDocument theme={theme} css={css} />).toString();
    const html = "<!doctype html>\n" + rendered.replace(
        /href="(\/admin(?:\/chat)?(?:\?[^"]*)?)"/g,
        (_, href: string) =>
            `href="${
                href.startsWith("/admin/chat")
                    ? "#chat-messages"
                    : "#preview-top"
            }"`,
    );
    if (/<script\b|<link\b|\bsrc=/i.test(html)) {
        throw new Error("Chat preview must not load external resources");
    }
    if (
        /<(?:button|input|select|textarea)\b(?![^>]*\bdisabled\b)/i.test(html)
    ) {
        throw new Error("Chat preview controls must be disabled");
    }
    const ids = new Set(
        [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]),
    );
    for (const [, href] of html.matchAll(/\bhref="([^"]+)"/g)) {
        if (!href?.startsWith("#") || !ids.has(href.slice(1))) {
            throw new Error(`Invalid chat preview link: ${href}`);
        }
    }
    await Deno.writeTextFile(new URL(`chat-${theme}.html`, output), html);
    console.log(`Generated docs/previews/chat-${theme}.html`);
}
