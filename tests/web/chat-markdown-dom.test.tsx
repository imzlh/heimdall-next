/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { render, useState } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import { ChatMarkdown } from "../../src/web/client/chat/markdown.tsx";
import { ChatMessages } from "../../src/web/client/chat/messages.tsx";
import type { ChatState } from "../../src/web/client/chat/types.ts";
import { installTestDom } from "./helpers/jsx-dom.ts";

function clipboard(writeText: (text: string) => Promise<void>) {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { clipboard: { writeText } },
    });
    return () => {
        if (original) Object.defineProperty(globalThis, "navigator", original);
        else Reflect.deleteProperty(globalThis, "navigator");
    };
}

Deno.test("chat DOM code copy uses the displayed payload and cannot be forged by model HTML", async () => {
    const dom = installTestDom();
    const copied: string[] = [];
    const restore = clipboard((text) => {
        copied.push(text);
        return Promise.resolve();
    });
    const code = 'echo "visible"\n<button data-copy="hidden">copy</button>';
    try {
        await dom.act(() =>
            render(
                <ChatMarkdown
                    text={`<button class="chat-code-copy">forged</button>\n\n\`\`\`sh\n${code}\n\`\`\``}
                />,
                dom.root as unknown as HTMLElement,
            )
        );
        const button = dom.root.querySelector('button[aria-label="复制代码"]');
        assert(button);
        assertEquals(dom.root.querySelectorAll("button").length, 1);
        assertEquals(dom.root.querySelector("code")?.textContent, code);
        await dom.act(() => button.click());
        assertEquals(copied, [code]);
        assertEquals(button.getAttribute("aria-label"), "代码已复制");
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        restore();
        dom.restore();
    }
});

Deno.test("streaming Markdown keeps the code node and exposes only the current copy payload", async () => {
    const dom = installTestDom();
    const copied: string[] = [];
    const restore = clipboard((text) => {
        copied.push(text);
        return Promise.resolve();
    });
    let update: (text: string) => void = () => {};
    function Fixture() {
        const [text, setText] = useState("~~~ts\nconst value =");
        update = setText;
        return <ChatMarkdown text={text} />;
    }
    try {
        await dom.act(() =>
            render(
                <Fixture />,
                dom.root as unknown as HTMLElement,
            )
        );
        const code = dom.root.querySelector("code");
        await dom.act(() => update("~~~ts\nconst value = 1;\n~~~"));
        assertStrictEquals(dom.root.querySelector("code"), code);
        assertEquals(code?.textContent, "const value = 1;");
        const button = dom.root.querySelector('button[aria-label="复制代码"]');
        assert(button);
        await dom.act(() => button.click());
        assertEquals(copied, ["const value = 1;"]);
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        restore();
        dom.restore();
    }
});

Deno.test("chat code copy failure leaves selectable code and displays inline feedback", async () => {
    const dom = installTestDom();
    const restore = clipboard(() => Promise.reject(new Error("denied")));
    const source = "~~~\nkeep this\n~~~";
    try {
        await dom.act(() =>
            render(
                <ChatMarkdown text={source} />,
                dom.root as unknown as HTMLElement,
            )
        );
        const button = dom.root.querySelector('button[aria-label="复制代码"]');
        assert(button);
        await dom.act(() => button.click());
        assertEquals(dom.root.querySelector("code")?.textContent, "keep this");
        assertEquals(
            dom.root.querySelector('[role="status"]')?.textContent,
            "复制失败，请选中代码后复制。",
        );
        assertEquals(button.getAttribute("aria-label"), "复制代码");
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        restore();
        dom.restore();
    }
});

Deno.test("chat citation markers link to a resolved source and stay plain otherwise", async () => {
    const dom = installTestDom();
    try {
        await dom.act(() =>
            render(
                <ChatMarkdown
                    text="见 citeturn1search1 与 citeturn1search9。"
                    citations={[
                        {
                            label: "示例站点",
                            url: "https://example.com/a",
                            ref: "turn1search1",
                        },
                    ]}
                />,
                dom.root as unknown as HTMLElement,
            )
        );
        const links = dom.root.querySelectorAll("a");
        assertEquals(links.length, 1, "resolved marker should render one link");
        const link = links[0];
        assert(link);
        assert(
            (link.getAttribute("class") ?? "").includes("chat-cite-link"),
            "link carries the citation-link class",
        );
        assertEquals(link.getAttribute("href"), "https://example.com/a");
        assertEquals(link.getAttribute("title"), "示例站点");
        assertEquals(link.getAttribute("target"), "_blank");
        // The unresolved marker keeps the plain, non-linked badge (a span).
        const badges = dom.root.querySelectorAll('span[role="img"]');
        assertEquals(badges.length, 1);
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        dom.restore();
    }
});

Deno.test("chat message island formats assistant history and stream while whole-message copy retains Markdown", async () => {
    const dom = installTestDom();
    const copied: string[] = [];
    const restore = clipboard((text) => {
        copied.push(text);
        return Promise.resolve();
    });
    const state: ChatState = {
        conversations: [],
        conversation: null,
        selectedId: "demo",
        models: ["example"],
        model: "example",
        tools: [],
        draft: "",
        attachments: [],
        loading: false,
        creating: false,
        managing: false,
        sending: true,
        stopping: false,
        attachmentsBusy: false,
        streamText: "**流式**",
        toolCalls: [],
        streamReasoning: "",
        streamActivity: [],
        streamCitations: [],
        suggestions: [],
        pendingEffort: "medium",
        error: "",
        available: true,
        authenticated: true,
        messages: [
            {
                id: "user",
                conversationId: "demo",
                role: "user",
                text: "**原文**",
                createdAt: "",
            },
            {
                id: "assistant",
                conversationId: "demo",
                role: "assistant",
                text: "**回复**",
                createdAt: "",
            },
        ],
    };
    try {
        await dom.act(() =>
            render(
                <ChatMessages state={state} />,
                dom.root as unknown as HTMLElement,
            )
        );
        assertEquals(
            dom.root.querySelectorAll("strong").map((node) => node.textContent),
            ["回复", "流式"],
        );
        const buttons = dom.root.querySelectorAll(
            'button[aria-label="复制消息"]',
        );
        assertEquals(buttons.length, 2);
        await dom.act(() => buttons[1]!.click());
        assertEquals(copied, ["**回复**"]);
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        restore();
        dom.restore();
    }
});
