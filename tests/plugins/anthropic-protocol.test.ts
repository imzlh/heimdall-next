import {
    assert,
    assertEquals,
    assertRejects,
    assertStringIncludes,
} from "@std/assert";
import {
    type GenerationRequest,
    type OperationRequest,
    type PluginRoute,
    type RequestContext,
    type StreamEvent,
    type StreamFrame,
} from "@heimdall/contracts";
import { AnthropicProtocolPlugin } from "../../plugins/anthropic-protocol/mod.ts";

const plugin = new AnthropicProtocolPlugin();

function route(): PluginRoute {
    const value = plugin.manifest.routes?.find((candidate) =>
        candidate.path === "/v1/messages"
    );
    if (!value) throw new Error("missing Anthropic messages route");
    return value;
}

function context(
    body: unknown,
    stream = false,
    signal = new AbortController().signal,
): RequestContext {
    return {
        requestId: "req-anthropic-1",
        route: route(),
        request: new Request("http://localhost/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                ...body as Record<string, unknown>,
                stream,
            }),
        }),
        signal,
        metadata: {},
    };
}

function eventFrames(
    events: readonly StreamEvent[],
): AsyncIterable<StreamFrame> {
    return (async function* () {
        for (let index = 0; index < events.length; index++) {
            yield {
                version: 1,
                streamId: "msg-stream-1",
                requestId: "req-anthropic-1",
                seq: index + 1,
                eventId: `event-${index + 1}`,
                timestamp: "2026-09-18T00:00:00.000Z",
                event: events[index]!,
            } satisfies StreamFrame;
        }
    })();
}

function input(stream = false): OperationRequest<GenerationRequest> {
    return {
        version: 1,
        requestId: "req-anthropic-1",
        operation: "generation.create",
        payload: {
            model: "claude-3-7-sonnet",
            messages: [],
            stream,
        },
        traits: { model: "claude-3-7-sonnet", streaming: stream },
    };
}

function serializationContext(stream = false): RequestContext {
    return context({ model: "claude-3-7-sonnet", max_tokens: 128 }, stream);
}

function textAndToolEvents(
    request: OperationRequest<GenerationRequest>,
): readonly StreamEvent[] {
    return [
        { kind: "run.started", request },
        {
            kind: "message.started",
            message: {
                id: "assistant-1",
                role: "assistant",
                parts: [],
                status: "in_progress",
            },
        },
        {
            kind: "part.started",
            messageId: "assistant-1",
            part: { id: "text-1", type: "text", text: "" },
        },
        {
            kind: "part.delta",
            messageId: "assistant-1",
            partId: "text-1",
            delta: "Hello",
        },
        {
            kind: "part.delta",
            messageId: "assistant-1",
            partId: "text-1",
            delta: " from Claude",
        },
        { kind: "part.completed", messageId: "assistant-1", partId: "text-1" },
        {
            kind: "part.started",
            messageId: "assistant-1",
            part: {
                id: "tool-1",
                type: "tool_call",
                callId: "tool-1",
                name: "lookup",
                argumentsText: "",
                status: "in_progress",
            },
        },
        {
            kind: "part.delta",
            messageId: "assistant-1",
            partId: "tool-1",
            delta: '{"id":7}',
        },
        { kind: "part.completed", messageId: "assistant-1", partId: "tool-1" },
        {
            kind: "message.completed",
            messageId: "assistant-1",
            finishReason: "tool_use",
        },
        {
            kind: "usage",
            usage: {
                inputTokens: 21,
                outputTokens: 8,
                cachedInputTokens: 4,
                cacheWriteTokens: 2,
                totalTokens: 29,
            },
        },
        { kind: "run.completed", finishReason: "tool_use" },
    ];
}

Deno.test("Anthropic Messages request maps content blocks and controls into HIP", async () => {
    const parsed = await plugin.parse(context({
        model: "claude-3-7-sonnet",
        system: [{ type: "text", text: "Be precise" }],
        max_tokens: 256,
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "Look this up" },
                    {
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: "image/png",
                            data: "aGVsbG8=",
                        },
                    },
                    {
                        type: "tool_result",
                        tool_use_id: "tool-previous",
                        content: [{ type: "text", text: "found" }],
                        is_error: false,
                    },
                ],
            },
            {
                role: "assistant",
                content: [{
                    type: "tool_use",
                    id: "tool-previous",
                    name: "lookup",
                    input: { id: 7 },
                }],
            },
        ],
        tools: [{
            name: "lookup",
            description: "Look up a record",
            input_schema: {
                type: "object",
                properties: { id: { type: "number" } },
            },
        }],
        tool_choice: { type: "tool", name: "lookup" },
        temperature: 0.2,
        top_p: 0.8,
        stop_sequences: ["END"],
        thinking: { type: "enabled", budget_tokens: 128 },
        metadata: { user_id: "user-1" },
    }));

    assertEquals(parsed.operation, "generation.create");
    assertEquals(parsed.payload.model, "claude-3-7-sonnet");
    assertEquals(parsed.payload.instructions, "Be precise");
    assertEquals(parsed.payload.sampling, {
        maxOutputTokens: 256,
        temperature: 0.2,
        topP: 0.8,
    });
    assertEquals(parsed.payload.toolChoice, { name: "lookup" });
    assertEquals(parsed.payload.metadata, { user_id: "user-1" });
    assertEquals(parsed.payload.tools?.[0]?.name, "lookup");
    assertEquals(parsed.payload.messages[0]!.parts.map((part) => part.type), [
        "text",
        "image",
        "tool_result",
    ]);
    const image = parsed.payload.messages[0]!.parts[1]!;
    assertEquals(image.type, "image");
    if (image.type === "image") {
        assertEquals(image.source.data, new TextEncoder().encode("hello"));
        assertEquals(image.source.mediaType, "image/png");
    }
    const toolResult = parsed.payload.messages[0]!.parts[2]!;
    assertEquals(toolResult.type, "tool_result");
    if (toolResult.type === "tool_result") {
        assertEquals(toolResult.callId, "tool-previous");
        assertEquals(toolResult.isError, false);
    }
    const toolCall = parsed.payload.messages[1]!.parts[0]!;
    assertEquals(toolCall.type, "tool_call");
    if (toolCall.type === "tool_call") {
        assertEquals(toolCall.callId, "tool-previous");
        assertEquals(toolCall.arguments, { id: 7 });
    }
    const raw = parsed.payload.extensions?.raw as
        | Record<string, unknown>
        | undefined;
    assert(raw !== undefined);
    assertEquals(raw.stop_sequences, ["END"]);
    assertEquals(raw.thinking, { type: "enabled", budget_tokens: 128 });
});

Deno.test("Anthropic Messages JSON response maps text, tool use, and usage", async () => {
    const request = input();
    const response = await plugin.serialize(
        serializationContext(),
        request,
        eventFrames(textAndToolEvents(request)),
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.id, "msg-stream-1");
    assertEquals(body.type, "message");
    assertEquals(body.role, "assistant");
    assertEquals(body.model, "claude-3-7-sonnet");
    assertEquals(body.content, [
        { type: "text", text: "Hello from Claude" },
        {
            type: "tool_use",
            id: "tool-1",
            name: "lookup",
            input: { id: 7 },
        },
    ]);
    assertEquals(body.stop_reason, "tool_use");
    assertEquals(body.stop_sequence, null);
    assertEquals(body.usage, {
        input_tokens: 21,
        output_tokens: 8,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 4,
    });
});

Deno.test("Anthropic streaming emits message/content/message delta events", async () => {
    const request = input(true);
    const response = await plugin.serialize(
        serializationContext(true),
        request,
        eventFrames(textAndToolEvents(request)),
    );
    assertEquals(
        response.headers.get("content-type"),
        "text/event-stream; charset=utf-8",
    );
    const sse = await response.text();
    assertStringIncludes(sse, "event: message_start\n");
    assertStringIncludes(sse, '"type":"message_start"');
    assertStringIncludes(sse, "event: content_block_start\n");
    assertStringIncludes(sse, '"type":"text_delta","text":"Hello"');
    assertStringIncludes(
        sse,
        '"type":"input_json_delta","partial_json":"{\\"id\\":7}"',
    );
    assertStringIncludes(sse, "event: content_block_stop\n");
    assertStringIncludes(sse, "event: message_delta\n");
    assertStringIncludes(sse, '"stop_reason":"tool_use"');
    assertStringIncludes(sse, "event: message_stop\n");
    assertEquals(sse.includes("event: error\n"), false);
});

Deno.test("Anthropic adapter never exposes private reasoning", async () => {
    const request = input(true);
    const events: readonly StreamEvent[] = [
        { kind: "run.started", request },
        {
            kind: "message.started",
            message: {
                id: "assistant-1",
                role: "assistant",
                parts: [],
                status: "in_progress",
            },
        },
        {
            kind: "part.started",
            messageId: "assistant-1",
            part: {
                id: "reasoning-1",
                type: "reasoning",
                text: "",
                visibility: "private",
            },
        },
        {
            kind: "part.delta",
            messageId: "assistant-1",
            partId: "reasoning-1",
            delta: "secret chain of thought",
        },
        {
            kind: "part.completed",
            messageId: "assistant-1",
            partId: "reasoning-1",
        },
        {
            kind: "part.started",
            messageId: "assistant-1",
            part: { id: "text-1", type: "text", text: "" },
        },
        {
            kind: "part.delta",
            messageId: "assistant-1",
            partId: "text-1",
            delta: "visible",
        },
        { kind: "part.completed", messageId: "assistant-1", partId: "text-1" },
        { kind: "message.completed", messageId: "assistant-1" },
        { kind: "run.completed" },
    ];
    const response = await plugin.serialize(
        serializationContext(true),
        request,
        eventFrames(events),
    );
    const sse = await response.text();
    assertEquals(sse.includes("secret chain of thought"), false);
    assertEquals(sse.includes("thinking_delta"), false);
    assertStringIncludes(sse, '"index":0,"content_block":{"type":"text"');
    assertStringIncludes(sse, "event: message_stop\n");
});

Deno.test("Anthropic JSON serialization maps HIP reducer failures to an error", async () => {
    const request = input();
    const response = await plugin.serialize(
        serializationContext(),
        request,
        eventFrames([
            { kind: "run.started", request },
            {
                kind: "part.delta",
                messageId: "missing-message",
                partId: "text-1",
                delta: "unexpected",
            },
        ]),
    );
    assertEquals(response.status, 502);
    const body = await response.json();
    assertEquals(body.type, "error");
    assertEquals(body.error.type, "api_error");
});

Deno.test("Anthropic errors and cancellation use native error envelopes", async () => {
    const request = input();
    const errorEvents: readonly StreamEvent[] = [
        { kind: "run.started", request },
        {
            kind: "run.error",
            error: {
                code: "rate_limit_error",
                message: "slow down",
                status: 429,
            },
        },
    ];
    const errorResponse = await plugin.serialize(
        serializationContext(),
        request,
        eventFrames(errorEvents),
    );
    assertEquals(errorResponse.status, 429);
    assertEquals(await errorResponse.json(), {
        type: "error",
        error: { type: "rate_limit_error", message: "slow down" },
    });

    const streamRequest = input(true);
    const cancellationResponse = await plugin.serialize(
        serializationContext(true),
        streamRequest,
        eventFrames([
            { kind: "run.started", request: streamRequest },
            { kind: "run.cancelled", reason: "client disconnected" },
        ]),
    );
    const sse = await cancellationResponse.text();
    assertStringIncludes(sse, "event: error\n");
    assertStringIncludes(sse, '"type":"timeout_error"');
    assertEquals(sse.includes("event: message_stop\n"), false);
});

Deno.test("Anthropic request requires positive max_tokens", async () => {
    let error: unknown;
    try {
        await plugin.parse(context({
            model: "claude-3-7-sonnet",
            messages: [{ role: "user", content: "hello" }],
        }));
    } catch (caught) {
        error = caught;
    }
    assert(error instanceof Error);
    assertStringIncludes((error as Error).message, "max_tokens");
});

Deno.test("Anthropic request rejects lossy wire types", async () => {
    await assertRejects(
        () =>
            plugin.parse(context({
                model: "claude-3-7-sonnet",
                max_tokens: 32,
                messages: [{ role: "user", content: "hello" }],
            }, "true" as unknown as boolean)),
        Error,
        "stream must be a boolean",
    );
    await assertRejects(
        () =>
            plugin.parse(context({
                model: "claude-3-7-sonnet",
                max_tokens: 32,
                messages: [{ role: "user", content: "hello" }],
                top_k: 1.5,
            })),
        Error,
        "top_k must be a non-negative integer",
    );
    await assertRejects(
        () =>
            plugin.parse(context({
                model: "claude-3-7-sonnet",
                max_tokens: 32,
                messages: [{ role: "user", content: "hello" }],
                stop_sequences: ["ok", 3],
            })),
        Error,
        "stop_sequences must be an array of strings",
    );
});

Deno.test("Anthropic raw extensions omit credential-shaped fields", async () => {
    const parsed = await plugin.parse(context({
        model: "claude-3-7-sonnet",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
        vendor_option: { trace_id: "trace-1", api_key: "do-not-retain" },
        access_token: "do-not-retain",
    }));
    const raw = parsed.payload.extensions?.raw as Record<string, unknown>;
    assertEquals(raw.vendor_option, { trace_id: "trace-1" });
    assertEquals("access_token" in raw, false);
});

Deno.test("Anthropic input preserves redacted reasoning without exposing it", async () => {
    const parsed = await plugin.parse(context({
        model: "claude-3-7-sonnet",
        max_tokens: 32,
        messages: [{
            role: "assistant",
            content: [{ type: "redacted_thinking", data: "opaque" }],
        }],
    }));
    const part = parsed.payload.messages[0]!.parts[0]!;
    assertEquals(part.type, "reasoning");
    if (part.type === "reasoning") {
        assertEquals(part.visibility, "redacted");
        assertEquals(part.text, "");
    }
});
