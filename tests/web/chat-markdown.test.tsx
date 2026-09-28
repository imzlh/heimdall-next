import {
    assert,
    assertEquals,
    assertFalse,
    assertStringIncludes,
} from "@std/assert";
import { ChatMarkdown } from "@heimdall/core/web/components/chat-markdown.tsx";
import { ChatPageView } from "@heimdall/core/web/pages/chat.tsx";
import {
    chatCitationLabel,
    markdownLink,
    parseChatMarkdown,
    splitChatCitations,
} from "@heimdall/core/web/shared/chat-markdown.ts";
import type { ChatInitial } from "@heimdall/admin-contracts/chat.ts";

const html = (text: string) => (<ChatMarkdown text={text} />).toString();

Deno.test("chat Markdown renders GFM structure in SSR before the island loads", () => {
    const output = html([
        "## 连接方式",
        "",
        "支持 **加粗**、*强调*、~~删除~~ 和 `api_key`。",
        "保持换行。",
        "",
        "> 可离线访问。",
        "",
        "3. 名称",
        "4. 参数",
        "   - 嵌套列表",
        "",
        "| 参数 | 值 |",
        "| :--- | ---: |",
        "| `a\\|b` | 2 |",
        "",
        "- [x] 已配置",
        "- [ ] 待验证",
        "",
        "---",
    ].join("\n"));
    for (
        const expected of [
            "<h2>连接方式</h2>",
            "<strong>加粗</strong>",
            "<em>强调</em>",
            "<del>删除</del>",
            '<code class="chat-inline-code">api_key</code>',
            "<br/>",
            "<blockquote>",
            '<ol start="3">',
            "<ul>",
            'class="chat-table-scroll"',
            "<table>",
            'class="chat-align-right"',
            '<code class="chat-inline-code">a|b</code>',
            'aria-label="已完成"',
            'aria-label="未完成"',
            "<hr/>",
        ]
    ) assertStringIncludes(output, expected);
});

Deno.test("chat fenced code preserves its payload during streaming and normalizes CRLF", () => {
    const source = 'const data = "<unsafe>";\n  console.log(data);';
    for (const fence of ["```", "~~~~"]) {
        const open = `${fence}ts filename=example.ts\n${source}`;
        const closed = `${open}\n${fence}`;
        assertEquals(parseChatMarkdown(open), [{
            kind: "code",
            language: "ts",
            text: source,
        }]);
        assertEquals(parseChatMarkdown(closed), parseChatMarkdown(open));
        assertEquals(
            parseChatMarkdown(closed.replaceAll("\n", "\r\n")),
            parseChatMarkdown(open),
        );
    }
    const output = html(`\`\`\`ts\n${source}\n\`\`\``);
    assertStringIncludes(output, 'class="chat-code-language">ts</span>');
    assertStringIncludes(output, 'aria-label="复制代码"');
    assertStringIncludes(output, "disabled");
    assertStringIncludes(output, "&lt;unsafe&gt;");
    assertFalse(output.includes("<unsafe>"));
});

Deno.test("chat Markdown never interprets raw HTML, copy controls or remote images", () => {
    const output = html([
        '<button class="chat-code-copy" data-copy="hidden()">复制代码</button>',
        "",
        "<script>alert(1)</script>",
        "",
        "![remote](https://tracking.example/image.png)",
        "",
        "![svg](data:image/svg+xml;base64,abc)",
        "",
        "```html",
        "</code><script>attack()</script>",
        "```",
    ].join("\n"));
    assertFalse(output.includes("<script>"));
    assertFalse(output.includes("<img"));
    assertFalse(output.includes('data-copy="hidden()"'));
    assertEquals((output.match(/<button\b/g) ?? []).length, 1);
    assertStringIncludes(output, "&lt;script&gt;attack()&lt;/script&gt;");
    assertStringIncludes(
        output,
        "![remote](https://tracking.example/image.png)",
    );
});

Deno.test("chat links allow explicit web/mail destinations and reject executable or ambiguous schemes", () => {
    for (
        const unsafe of [
            "javascript:alert(1)",
            "JaVaScRiPt:alert(1)",
            "java\nscript:alert(1)",
            "javascript&#58;alert(1)",
            "javascript&colon;alert(1)",
            "data:text/html,unsafe",
            "vbscript:run",
            "file:///tmp/file",
            "//evil.example",
            "/\\evil.example",
            "https:\\evil.example",
            "https://a.example\u0000/path",
            "https://user:password@example.com",
            "relative/path",
            "mailto:",
        ]
    ) {
        assertEquals(markdownLink(unsafe), undefined, unsafe);
        assertFalse(html(`[链接](${unsafe})`).includes("<a "), unsafe);
    }
    for (
        const safe of [
            "https://example.com/a_(b)?x=1&y=2",
            "http://localhost:8080",
            "mailto:team@example.com",
        ]
    ) {
        assertEquals(markdownLink(safe), safe);
        const output = html(`[**文档**](${safe})`);
        assertStringIncludes(output, '<a href="');
        assertStringIncludes(output, 'target="_blank"');
        assertStringIncludes(output, 'rel="noopener noreferrer"');
        assertStringIncludes(output, "<strong>文档</strong>");
    }
    assertStringIncludes(
        html("[说明][docs]\n\n[docs]: https://example.com/docs"),
        'href="https://example.com/docs"',
    );
});

Deno.test("chat Markdown preserves incomplete syntax and unusually large messages as readable text", () => {
    assertEquals(parseChatMarkdown(""), []);
    assertStringIncludes(
        html("**未闭合 [链接]( 和 `代码"),
        "**未闭合 [链接]( 和 `代码",
    );
    const large = "长消息 [ ** ".repeat(15_000);
    assertEquals(parseChatMarkdown(large), [{
        kind: "paragraph",
        children: [{ kind: "text", text: large }],
    }]);
    const nested = `${"> ".repeat(100)}最深内容`;
    assertStringIncludes(html(nested), "最深内容");
    const dense = "*a ".repeat(2_000);
    assertEquals(parseChatMarkdown(dense), [{
        kind: "paragraph",
        children: [{ kind: "text", text: dense }],
    }]);
});

Deno.test("chat Markdown decodes prose and link entities once while preserving code and literal HTML", () => {
    const output = html(
        "**A &amp; B &#x4E2D; &copy;**\n\n[x](https://example.com/?a=1&amp;b=2)\n\n`&amp;`\n\n~~~html\n&amp;\n~~~\n\n<script>&amp;</script>",
    );
    assertStringIncludes(output, "<strong>A &amp; B 中 ©</strong>");
    assertStringIncludes(output, 'href="https://example.com/?a=1&amp;b=2"');
    assertStringIncludes(
        output,
        '<code class="chat-inline-code">&amp;amp;</code>',
    );
    assertStringIncludes(output, "<code>&amp;amp;</code>");
    assertStringIncludes(output, "&lt;script&gt;&amp;amp;&lt;/script&gt;");
    assertFalse(html("[x](java&#x73;cript:alert(1))").includes("<a "));
});

Deno.test("chat SSR formats assistant messages while preserving literal user input", () => {
    const initial: ChatInitial = {
        authenticated: true,
        available: true,
        models: ["example"],
        conversations: [],
        conversation: null,
        messages: [
            {
                id: "user",
                conversationId: "demo",
                role: "user",
                text: "**原样**",
                createdAt: "2026-09-25T00:00:00Z",
            },
            {
                id: "assistant",
                conversationId: "demo",
                role: "assistant",
                text: "**回复**",
                createdAt: "2026-09-25T00:00:01Z",
            },
        ],
    };
    const output = (<ChatPageView initial={initial} />).toString();
    assertStringIncludes(output, '<p class="chat-message-text">**原样**</p>');
    assertStringIncludes(output, "<strong>回复</strong>");
    assertFalse(output.includes("<strong>原样</strong>"));
    assert(output.includes("chat-markdown"));
});

Deno.test("chat Markdown renders citation markers as badges without links", () => {
    const output = html("结论如下。citeturn1search1turn1search6");
    assertStringIncludes(output, 'class="chat-cite"');
    assertStringIncludes(output, "检索 1 · 6");
    assertFalse(output.includes("citeturn"));
    assertFalse(output.includes("<a "));
});

Deno.test("citation splitting keeps prose gaps separate and verbs distinct", () => {
    assertEquals(splitChatCitations("普通文本"), [
        { kind: "text", text: "普通文本" },
    ]);
    assertEquals(
        splitChatCitations("来源 citeturn1search1，以及 citeturn2browser4。"),
        [
            { kind: "text", text: "来源" },
            {
                kind: "cites",
                items: [{ verb: "search", index: "1", id: "turn1search1" }],
            },
            { kind: "text", text: "，以及" },
            {
                kind: "cites",
                items: [{ verb: "browser", index: "4", id: "turn2browser4" }],
            },
            { kind: "text", text: "。" },
        ],
    );
    assertEquals(
        chatCitationLabel([{ verb: "search", index: "1", id: "turn1search1" }, {
            verb: "search",
            index: "6",
            id: "turn1search6",
        }]),
        "检索 1 · 6",
    );
    assertEquals(
        chatCitationLabel([{ verb: "search", index: "1", id: "turn1search1" }, {
            verb: "browser",
            index: "4",
            id: "turn1browser4",
        }]),
        "检索 1 · 浏览 4",
    );
});
