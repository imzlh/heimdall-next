import { assertEquals, assertMatch } from "@std/assert";
import { conversationToMarkdown } from "@heimdall/core/web/client/chat/export.ts";
import type { ChatMessage } from "@heimdall/core/web/client/api/chat.ts";

function message(
    overrides: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text">,
): ChatMessage {
    return {
        id: overrides.id ?? crypto.randomUUID(),
        conversationId: "conv-1",
        createdAt: "2026-09-26T08:30:00.000Z",
        ...overrides,
    };
}

Deno.test("exported markdown keeps user and assistant turns in order", () => {
    const markdown = conversationToMarkdown(
        { title: "推理模型对比", updatedAt: "2026-09-26T09:00:00.000Z" },
        [
            message({ role: "user", text: "对比一下各家推理模型" }),
            message({ role: "assistant", text: "主要差别在深度和速度。" }),
        ],
    );
    assertEquals(
        markdown,
        [
            "# 推理模型对比",
            "",
            "## 你 · 2026-09-26 08:30",
            "",
            "对比一下各家推理模型",
            "",
            "## Heimdall · 2026-09-26 08:30",
            "",
            "主要差别在深度和速度。",
            "",
            "---",
            "",
            markdown.split("\n").at(-1)!,
        ].join("\n"),
    );
    assertMatch(markdown, /^导出于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m);
});

Deno.test("exported markdown skips tool traffic and empty messages", () => {
    const markdown = conversationToMarkdown(
        { title: "", updatedAt: "2026-09-26T09:00:00.000Z" },
        [
            message({ role: "user", text: "查一下天气" }),
            message({
                role: "assistant",
                text: "",
                name: "serp",
                callId: "c1",
            }),
            message({ role: "tool", text: "晴", name: "serp", callId: "c1" }),
            message({ role: "assistant", text: "今天是晴天。" }),
        ],
    );
    assertEquals(markdown.includes("插件"), false);
    assertEquals(markdown.startsWith("# 新对话"), true);
    assertEquals(markdown.includes("今天是晴天。"), true);
});
