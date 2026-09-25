import { assertEquals, assertStringIncludes } from "@std/assert";
import type {
    InferenceSource,
    OperationRequest,
    StreamEvent,
    StreamFrame,
} from "@heimdall/contracts";
import { createServer } from "../main.ts";
import openAIProtocol from "../plugins/openai-protocol/mod.ts";

function sourceFor(text: string): InferenceSource {
    return {
        id: "fixture.source",
        capabilities: [{
            operation: "generation.create",
            models: ["fixture-model"],
            streaming: true,
        }],
        execute(input: OperationRequest): AsyncIterable<StreamFrame> {
            return frames([
                { kind: "run.started", request: input },
                {
                    kind: "message.started",
                    message: {
                        id: "message-1",
                        role: "assistant",
                        parts: [],
                        status: "in_progress",
                    },
                },
                {
                    kind: "part.started",
                    messageId: "message-1",
                    part: { id: "text-1", type: "text", text: "" },
                },
                {
                    kind: "part.delta",
                    messageId: "message-1",
                    partId: "text-1",
                    delta: text,
                },
                {
                    kind: "part.completed",
                    messageId: "message-1",
                    partId: "text-1",
                },
                {
                    kind: "message.completed",
                    messageId: "message-1",
                    finishReason: "stop",
                },
                {
                    kind: "usage",
                    usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
                },
                { kind: "run.completed", finishReason: "stop" },
            ]);
        },
    };
}

function frames(events: readonly StreamEvent[]): AsyncIterable<StreamFrame> {
    return (async function* () {
        for (let index = 0; index < events.length; index++) {
            yield {
                version: 1,
                streamId: "fixture-stream",
                requestId: "request-1",
                seq: index + 1,
                eventId: `fixture-${index + 1}`,
                timestamp: "2026-09-20T00:00:00.000Z",
                event: events[index]!,
            };
        }
    })();
}

Deno.test("server composes OpenAI protocol and source plugins", async () => {
    const app = createServer({
        protocols: [openAIProtocol],
        sources: [sourceFor("hello from HIP")],
    });
    const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-request-id": "request-1",
            },
            body: JSON.stringify({
                model: "fixture-model",
                messages: [{ role: "user", content: "hello" }],
            }),
        }),
    );

    assertEquals(response.status, 200);
    assertEquals(response.headers.get("x-heimdall-request-id"), "request-1");
    const body = await response.json();
    assertEquals(body.object, "chat.completion");
    assertEquals(body.choices[0].message.content, "hello from HIP");
    assertEquals(body.usage.total_tokens, 3);
});

Deno.test("server returns a protocol error when no source is configured", async () => {
    const app = createServer({
        protocols: [openAIProtocol],
        sources: [],
    });
    const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
            method: "POST",
            body: JSON.stringify({
                model: "fixture-model",
                messages: [{ role: "user", content: "hello" }],
            }),
            headers: { "content-type": "application/json" },
        }),
    );

    assertEquals(response.status, 503);
    const body = await response.json();
    assertStringIncludes(body.error.message, "upstream");
});
