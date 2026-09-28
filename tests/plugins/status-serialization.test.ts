import { assert, assertEquals } from "@std/assert";
import type { ContentPart, Message } from "@heimdall/contracts";
import {
    toChatMessage,
    toResponsesContent,
} from "../../plugins/openai-protocol/response.ts";
import { toAnthropicContent } from "../../plugins/anthropic-protocol/output.ts";

const parts: ContentPart[] = [
    {
        id: "s",
        type: "custom",
        name: "status",
        value: { summary: "🔍 搜索：北京 天气", kind: "search" },
    },
    { id: "t", type: "text", text: "北京今天晴。" },
];

const message: Message = {
    id: "m",
    role: "assistant",
    parts,
};

Deno.test("OpenAI chat output folds a status summary into the reply text", () => {
    const wire = toChatMessage(message);
    assertEquals(wire.content, "🔍 搜索：北京 天气\n北京今天晴。");
});

Deno.test("OpenAI responses output emits the status summary as output_text", () => {
    const content = toResponsesContent(parts);
    const texts = content
        .filter((item) => item.type === "output_text")
        .map((item) => item.text);
    assertEquals(texts, ["🔍 搜索：北京 天气", "北京今天晴。"]);
});

Deno.test("Anthropic output emits the status summary as a text block", () => {
    const blocks = toAnthropicContent(parts);
    const texts = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text);
    assert(texts.includes("🔍 搜索：北京 天气"));
    assert(texts.includes("北京今天晴。"));
});
