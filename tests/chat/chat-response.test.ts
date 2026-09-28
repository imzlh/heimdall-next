import { assertEquals } from "@std/assert";
import { ChatResponse } from "@heimdall/core/chat/response.ts";

Deno.test("ChatResponse captures title and suggestions without touching text", () => {
    const response = new ChatResponse();
    response.append({
        kind: "part.started",
        messageId: "m",
        part: { id: "p", type: "text", text: "" },
    });
    response.append({
        kind: "part.delta",
        messageId: "m",
        partId: "p",
        delta: "Hello",
    });
    response.append({ kind: "title", title: "  Greetings  " });
    response.append({
        kind: "suggestions",
        suggestions: ["ask a", "", "ask b"],
    });

    assertEquals(response.text, "Hello");
    assertEquals(response.title, "Greetings");
    assertEquals(response.suggestions, ["ask a", "ask b"]);
});

Deno.test("ChatResponse title and suggestions default empty", () => {
    const response = new ChatResponse();
    response.append({
        kind: "part.started",
        messageId: "m",
        part: { id: "p", type: "text", text: "hi" },
    });
    assertEquals(response.title, "");
    assertEquals(response.suggestions, []);
});

Deno.test("ChatResponse captures reasoning, activity and citations off the answer", () => {
    const response = new ChatResponse();
    // Cloud activity status line.
    response.append({
        kind: "part.started",
        messageId: "m",
        part: {
            id: "s",
            type: "custom",
            name: "status",
            value: { summary: "🔍 搜索：北京 天气", kind: "search" },
        },
    });
    // Public reasoning streamed as started + delta.
    response.append({
        kind: "part.started",
        messageId: "m",
        part: {
            id: "r",
            type: "reasoning",
            text: "先想想。",
            visibility: "public",
        },
    });
    response.append({
        kind: "part.delta",
        messageId: "m",
        partId: "r",
        delta: "再查证。",
    });
    // The visible answer.
    response.append({
        kind: "part.started",
        messageId: "m",
        part: { id: "p", type: "text", text: "" },
    });
    response.append({
        kind: "part.delta",
        messageId: "m",
        partId: "p",
        delta: "北京今天晴。",
    });
    // A cited source.
    response.append({
        kind: "part.started",
        messageId: "m",
        part: {
            id: "c",
            type: "citation",
            label: "天气来源",
            url: "https://ref.example/a",
        },
    });

    assertEquals(response.text, "北京今天晴。");
    assertEquals(response.reasoning, "先想想。再查证。");
    assertEquals(response.activity, [{ summary: "🔍 搜索：北京 天气" }]);
    assertEquals(response.citations, [{
        label: "天气来源",
        url: "https://ref.example/a",
    }]);
});

Deno.test("ChatResponse ignores private reasoning", () => {
    const response = new ChatResponse();
    response.append({
        kind: "part.started",
        messageId: "m",
        part: {
            id: "r",
            type: "reasoning",
            text: "hidden",
            visibility: "private",
        },
    });
    assertEquals(response.reasoning, "");
});

Deno.test("ChatResponse captures the account quota off the usage extensions", () => {
    const response = new ChatResponse();
    response.append({
        kind: "usage",
        usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            extensions: {
                estimated: true,
                quota: {
                    meters: [
                        { name: "LLMOnly", remaining: 100 },
                        {
                            name: "ImageGeneration",
                            remaining: 0,
                            blocked: true,
                        },
                        {
                            name: "ImageGenInsufficientTokensThrottled",
                            blocked: true,
                            error: "ImageGenInsufficientTokensThrottled",
                        },
                    ],
                },
            },
        },
    });
    assertEquals(response.quota, {
        meters: [
            { name: "LLMOnly", remaining: 100 },
            { name: "ImageGeneration", remaining: 0, blocked: true },
            {
                name: "ImageGenInsufficientTokensThrottled",
                blocked: true,
                error: "ImageGenInsufficientTokensThrottled",
            },
        ],
    });
});

Deno.test("ChatResponse leaves quota undefined without a usage snapshot", () => {
    const response = new ChatResponse();
    response.append({
        kind: "part.started",
        messageId: "m",
        part: { id: "p", type: "text", text: "hi" },
    });
    assertEquals(response.quota, undefined);
});
