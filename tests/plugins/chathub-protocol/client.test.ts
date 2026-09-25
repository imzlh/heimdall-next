import { assertEquals } from "@std/assert";
import { ChatHubClient } from "../../../plugins/chathub-source/protocol/client.ts";
import { encodeRecord } from "../../../plugins/chathub-source/protocol/codec.ts";
import { SignalRMessageType } from "../../../plugins/chathub-source/protocol/constants.ts";
import type {
    ChatHubUrlOptions,
    WebSocketLike,
} from "../../../plugins/chathub-source/protocol/types.ts";

/**
 * Minimal in-memory WebSocket that drives the client through a handshake and a
 * scripted set of SignalR frames. The first send is the handshake request; the
 * second is the chat payload, after which the scripted frames are delivered.
 */
class ScriptedSocket extends EventTarget implements WebSocketLike {
    readyState = 0;
    #sends = 0;
    constructor(private readonly frames: unknown[]) {
        super();
        setTimeout(() => {
            this.readyState = 1;
            this.dispatchEvent(new Event("open"));
        }, 0);
    }
    send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        this.#sends++;
        if (this.#sends === 1) {
            // Acknowledge the handshake with an empty record.
            setTimeout(() => this.#message(encodeRecord({})), 0);
            return;
        }
        if (this.#sends === 2) {
            setTimeout(() => {
                for (const frame of this.frames) {
                    this.#message(encodeRecord(frame));
                }
            }, 0);
        }
    }
    close(): void {
        this.readyState = 3;
    }
    #message(data: string): void {
        this.dispatchEvent(new MessageEvent("message", { data }));
    }
}

const CONNECTION: ChatHubUrlOptions = {
    oid: "oid",
    tid: "tid",
    accessToken: "token",
    sessionId: "s",
    conversationId: "c",
    chatSessionId: "cs",
    endpoint: "wss://example.test/Chathub",
};

Deno.test("the client separates the answer text from the chain-of-thought", async () => {
    const frames = [
        // Reasoning card streamed as a Progress / ChainOfThoughtSummary frame.
        {
            type: SignalRMessageType.Invocation,
            target: "update",
            arguments: [{
                messages: [{
                    author: "bot",
                    text: "Considering the available tools",
                    messageType: "Progress",
                    contentOrigin: "ChainOfThoughtSummary",
                }],
            }],
        },
        // The genuine answer arrives as the authoritative stream item, which also
        // carries the quota table and the server-suggested conversation title.
        {
            type: SignalRMessageType.StreamItem,
            item: {
                defaultChatName: "Available tools",
                throttling: {
                    maxNumUserMessagesInConversation: 600,
                    numUserMessagesInConversation: 1,
                    metering: { LLMOnly: { remainingAllowance: 100 } },
                },
                messages: [{
                    author: "bot",
                    text: "Here is the answer.",
                    messageType: "",
                }],
            },
        },
        { type: SignalRMessageType.Completion },
    ];
    const client = new ChatHubClient({
        webSocketFactory: () => new ScriptedSocket(frames),
    });
    const result = await client.chat(CONNECTION, { text: "hi" });
    assertEquals(result.finalText ?? result.text, "Here is the answer.");
    assertEquals(result.reasoning, "Considering the available tools");
    // The answer must never carry the thinking.
    assertEquals(
        (result.finalText ?? result.text).includes("Considering"),
        false,
    );
    // Quota table and suggested title ride the same terminal frame.
    assertEquals(result.chatName, "Available tools");
    assertEquals(result.throttling?.metering?.LLMOnly?.remainingAllowance, 100);
    assertEquals(result.throttling?.numUserMessagesInConversation, 1);
});
