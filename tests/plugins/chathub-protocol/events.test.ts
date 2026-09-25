import { assertEquals } from "@std/assert";
import { SignalRMessageType } from "../../../plugins/chathub-source/protocol/constants.ts";
import { normalizeFrame } from "../../../plugins/chathub-source/protocol/events.ts";

/** A SignalR StreamItem frame carrying the given bot turn messages. */
function streamItem(messages: unknown[]): unknown {
    return { type: SignalRMessageType.StreamItem, item: { messages } };
}

Deno.test("a chain-of-thought summary never surfaces as the answer text", () => {
    const event = normalizeFrame(streamItem([
        {
            author: "bot",
            text: "**Planning the answer**\n- gather tools",
            messageType: "Progress",
            contentOrigin: "ChainOfThoughtSummary",
        },
    ]));
    assertEquals(event.kind, "stream-item");
    // The only textual message is reasoning; the answer text must be absent, not
    // the leaked chain-of-thought.
    assertEquals(event.text, undefined);
});

Deno.test("the real bot answer wins even when a reasoning frame comes last", () => {
    const event = normalizeFrame(streamItem([
        {
            author: "bot",
            text: "Here are the tools you have.",
            messageType: "",
        },
        {
            author: "bot",
            text: "**Still thinking**",
            addToChainOfThought: true,
        },
    ]));
    assertEquals(event.text, "Here are the tools you have.");
});

Deno.test("progress and search-status frames are not treated as answer text", () => {
    const event = normalizeFrame(streamItem([
        { author: "bot", text: "searching...", messageType: "Progress" },
        { author: "bot", text: "found results", contentType: "SearchResults" },
    ]));
    assertEquals(event.text, undefined);
});

Deno.test("a plain bot answer message is returned unchanged", () => {
    const event = normalizeFrame(streamItem([
        { author: "bot", text: "The answer is 42.", messageType: "" },
    ]));
    assertEquals(event.text, "The answer is 42.");
});

Deno.test("the stream item exposes the quota table and suggested chat name", () => {
    const event = normalizeFrame({
        type: SignalRMessageType.StreamItem,
        item: {
            defaultChatName: "How do I reset my password",
            throttling: {
                maxNumUserMessagesInConversation: 600,
                numUserMessagesInConversation: 2,
                metering: { LLMOnly: { remainingAllowance: 100 } },
            },
            messages: [{
                author: "bot",
                text: "Here you go.",
                messageType: "",
            }],
        },
    });
    assertEquals(event.chatName, "How do I reset my password");
    assertEquals(event.throttling?.numUserMessagesInConversation, 2);
    assertEquals(event.throttling?.metering?.LLMOnly?.remainingAllowance, 100);
});

Deno.test("update frames carry no quota table (present only on the stream item)", () => {
    const event = normalizeFrame({
        type: SignalRMessageType.Invocation,
        target: "update",
        arguments: [{
            messages: [{ author: "bot", text: "partial", messageType: "" }],
        }],
    });
    assertEquals(event.kind, "update");
    assertEquals(event.throttling, undefined);
    assertEquals(event.chatName, undefined);
});
