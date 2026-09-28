import { assert, assertEquals } from "@std/assert";
import type { GenerateRequest, PluginRoute } from "@heimdall/contracts";
import type { RequestContext } from "@heimdall/contracts";
import plugin from "../../plugins/openai-protocol/mod.ts";
import {
    conversationIdFromResponseId,
    encodeResponseId,
    responsesConversationId,
} from "../../plugins/openai-protocol/conversation.ts";
import { buildResponsesResponse } from "../../plugins/openai-protocol/response.ts";

function responsesRoute(): PluginRoute {
    const route = plugin.manifest.routes?.find((candidate) =>
        candidate.path === "/v1/responses"
    );
    if (!route) throw new Error("missing /v1/responses route");
    return route;
}

function context(body: unknown, requestId = "req-responses"): RequestContext {
    return {
        requestId,
        route: responsesRoute(),
        request: new Request("http://localhost/v1/responses", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        }),
        signal: new AbortController().signal,
        metadata: {},
    };
}

async function conversationIdOf(body: unknown): Promise<unknown> {
    const operation = await plugin.parse(context(body));
    const metadata =
        (operation.payload as { metadata?: Record<string, unknown> })
            .metadata;
    return metadata?.conversationId;
}

Deno.test("encode/decode round-trips a conversation id through a response id", () => {
    const id = encodeResponseId("conv-abc", "run:stream-1");
    assertEquals(conversationIdFromResponseId(id), "conv-abc");
    // Only ids minted here decode; a foreign or absent value does not.
    assertEquals(conversationIdFromResponseId("resp_openai_xyz"), undefined);
    assertEquals(conversationIdFromResponseId(undefined), undefined);
});

Deno.test("previous_response_id continues a chain over minting", () => {
    assertEquals(
        responsesConversationId({
            previousResponseId: encodeResponseId("conv-1", "run:a"),
            singleTurn: true,
        }),
        "conv-1",
    );
    // An explicit caller id wins even over a chain.
    assertEquals(
        responsesConversationId({
            clientId: "caller",
            previousResponseId: encodeResponseId("conv-1", "run:a"),
            singleTurn: true,
        }),
        "caller",
    );
    // A resent multi-turn history with no chain defers to the kernel anchor.
    assertEquals(
        responsesConversationId({ singleTurn: false }),
        undefined,
    );
});

Deno.test("a first Responses turn is assigned a conversation id", async () => {
    const id = await conversationIdOf({ model: "m", input: "hello" });
    assert(typeof id === "string" && id.length > 0);
});

Deno.test("a resent multi-turn Responses request defers to the anchor", async () => {
    const id = await conversationIdOf({
        model: "m",
        input: ["hi", "hey", "again"],
    });
    assertEquals(id, undefined);
});

Deno.test("a chained Responses turn recovers the prior conversation id", async () => {
    const id = await conversationIdOf({
        model: "m",
        input: "continue",
        previous_response_id: encodeResponseId("thread-42", "run:earlier"),
    });
    assertEquals(id, "thread-42");
});

Deno.test("the responses envelope carries the id back and hides the routing key", () => {
    const request = {
        messages: [],
        model: "m",
        metadata: { conversationId: "conv-7", tag: "keep" },
    } as unknown as GenerateRequest;
    const response = buildResponsesResponse(request, undefined, "run:1", 100);
    assertEquals(conversationIdFromResponseId(response.id as string), "conv-7");
    const metadata = response.metadata as Record<string, unknown>;
    assertEquals(metadata.conversationId, undefined);
    assertEquals(metadata.tag, "keep");
});
