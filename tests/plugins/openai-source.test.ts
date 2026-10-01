import { assertEquals, assertThrows } from "@std/assert";
import {
    jsonEvents,
    validateOpenAICompatibleSourceConfig,
} from "../../plugins/openai-source/mod.ts";

Deno.test("OpenAI source config rejects unsafe transport overrides", () => {
    assertThrows(() =>
        validateOpenAICompatibleSourceConfig({
            baseUrl: "https://provider.example/v1",
            headers: { authorization: "Bearer bypass" },
        })
    );
    assertThrows(() =>
        validateOpenAICompatibleSourceConfig({
            baseUrl: "https://provider.example/v1",
            headers: { "x-api-key": "bypass" },
        })
    );
    assertThrows(() =>
        validateOpenAICompatibleSourceConfig({
            baseUrl: "https://provider.example/v1",
            endpoint: "/v1/%2e%2e/admin",
        })
    );
    assertThrows(() =>
        validateOpenAICompatibleSourceConfig({
            baseUrl: "https://provider.example/v1",
            ...{ modelMap: { public: "upstream" } },
        })
    );
});

Deno.test("OpenAI source config normalizes safe headers and paths", () => {
    const config = validateOpenAICompatibleSourceConfig({
        baseUrl: "https://provider.example/v1/",
        endpoint: "//chat/completions//",
        headers: { "X-Tenant": " tenant " },
    });
    assertEquals(config.baseUrl, "https://provider.example/v1");
    assertEquals(config.endpoint, "/chat/completions");
    assertEquals(config.headers, { "X-Tenant": "tenant" });
});

Deno.test("OpenAI source preserves upstream response content blocks", () => {
    const events = jsonEvents({
        choices: [{
            message: {
                content: [
                    { type: "text", text: "hello" },
                    { type: "output_text", text: " world" },
                    { type: "refusal", refusal: "no" },
                ],
                reasoning_content: "private",
            },
            finish_reason: "stop",
        }],
    }, "message-1");

    assertEquals(
        events.filter((event) => event.kind === "part.started").map((event) =>
            event.kind === "part.started" ? event.part.type : ""
        ),
        ["text", "text", "refusal", "reasoning"],
    );
    const reasoning = events.find((event) =>
        event.kind === "part.started" && event.part.type === "reasoning"
    );
    assertEquals(
        reasoning?.kind === "part.started" &&
            reasoning.part.type === "reasoning"
            ? reasoning.part.visibility
            : undefined,
        "private",
    );
});
