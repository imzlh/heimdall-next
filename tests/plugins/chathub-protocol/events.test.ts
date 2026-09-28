import { assertEquals } from "@std/assert";
import { SignalRMessageType } from "../../../plugins/chathub-source/protocol/constants.ts";
import {
    ChatHubTextAccumulator,
    normalizeFrame,
} from "../../../plugins/chathub-source/protocol/events.ts";

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

Deno.test("inline citation control markers collapse to the renderer's cite form", () => {
    const event = normalizeFrame(streamItem([
        {
            author: "bot",
            text:
                "秋季档热度较高作品之一。\u{e200}cite\u{e202}turn1search42\u{e201}",
            messageType: "",
        },
    ]));
    // The private-use delimiters are gone and `cite`/`turn…` sit contiguous, so
    // splitChatCitations recognizes the run instead of leaking tofu boxes.
    assertEquals(event.text, "秋季档热度较高作品之一。citeturn1search42");
});

Deno.test("a multi-entry citation run keeps every reference token", () => {
    const event = normalizeFrame(streamItem([
        {
            author: "bot",
            text:
                "见此\u{e200}cite\u{e202}turn1search1\u{e202}turn1search6\u{e201}。",
            messageType: "",
        },
    ]));
    assertEquals(event.text, "见此citeturn1search1turn1search6。");
});

Deno.test("citation markers are stripped from the reasoning transcript too", () => {
    const event = normalizeFrame(streamItem([
        {
            author: "bot",
            text: "依据\u{e200}cite\u{e202}turn2browser3\u{e201}推断",
            addToChainOfThought: true,
        },
    ]));
    assertEquals(event.reasoning, "依据citeturn2browser3推断");
});

Deno.test("references come only from reference dictionaries, keyed by id", () => {
    const event = normalizeFrame({
        type: SignalRMessageType.StreamItem,
        item: {
            messages: [
                { author: "bot", text: "答案。citeturn1search1" },
                // A search-results card carries a url but is not a citation.
                {
                    author: "bot",
                    contentType: "SearchResults",
                    cards: [{ url: "https://card.example/x" }],
                },
            ],
            references: {
                turn1search1: {
                    targetLink: "https://ref.example/1",
                    title: "来源一",
                },
            },
        },
    });
    // The stray card url is excluded; only the dictionary entry survives, with
    // its key stamped on so a marker can resolve to it.
    assertEquals(event.references?.length, 1);
    assertEquals(event.references?.[0]?.id, "turn1search1");
    assertEquals(event.references?.[0]?.targetLink, "https://ref.example/1");
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

Deno.test("the accumulator drops redundant writeAtCursor deltas and never doubles the reply", () => {
    const acc = new ChatHubTextAccumulator();
    // Interleaving observed on the wire (copilot2api docs 05 §3.2): the
    // snapshot channel grows monotonically while writeAtCursor re-sends the
    // same text as append fragments that do not prefix-match the snapshot.
    const frames = [
        "下面", // first snapshot token
        "是 10 个围绕如何让 Claude 不过度思考的想法", // writeAtCursor fragment (non-prefix)
        "下面是 10 个围绕如何让", // cumulative snapshot
        "。", // writeAtCursor fragment (non-prefix)
        "下面是 10 个围绕如何让 Claude 不过度思考的想法", // cumulative snapshot
        "下面是 10 个围绕如何让 Claude 不过度思考的想法\n\n1. 设置思考预算", // grows
    ];
    let streamed = "";
    for (const frame of frames) streamed += acc.update(frame);
    const expected =
        "下面是 10 个围绕如何让 Claude 不过度思考的想法\n\n1. 设置思考预算";
    // The concatenated deltas equal the final snapshot exactly once.
    assertEquals(streamed, expected);
    assertEquals(acc.text, expected);
});

Deno.test("the accumulator ignores shrinking and repeated snapshots", () => {
    const acc = new ChatHubTextAccumulator();
    assertEquals(acc.update("hello"), "hello");
    assertEquals(acc.update("hello"), ""); // identical repeat
    assertEquals(acc.update("hell"), ""); // shrink
    assertEquals(acc.update("hello world"), " world"); // extension
    assertEquals(acc.text, "hello world");
});
