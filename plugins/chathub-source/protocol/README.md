# ChatHub Protocol for Deno

A standalone Deno and TypeScript implementation of the M365 Copilot ChatHub
WebSocket protocol described by `M365-Copilot2API/SPEC.md`.

## Scope

The module provides:

- ChatHub WebSocket URL construction
- SignalR JSON handshake and Record Separator framing
- Chat stream invocations and metrics frames
- Ping, update, stream-item, completion, and unknown-frame handling
- Streaming text aggregation (snapshot + delta accumulation)
- Semantic stream-event classification for text, progress, reasoning, and tool
  calls
- Nested tool-event extraction with deterministic deduplication
- Reference and suggestion extraction from stream events
- Structured protocol and transport errors
- `AttachToSession` recovery
- Abort signals and configurable timeouts
- Per-turn token latency metrics (`ReceivedTokenMetrics`)

It intentionally does not implement OpenAI or Anthropic compatibility APIs,
account pools, administration interfaces, authentication flows, or file upload
workflows.

## Module layout

| File               | Responsibilities                                                        |
| ------------------ | ----------------------------------------------------------------------- |
| `constants.ts`     | Record separator, endpoint, SignalR enum, chat targets, default plugins |
| `codec.ts`         | Record encoding and incremental `0x1e`-framed decoding                  |
| `frames.ts`        | Frame builders (handshake / ping / chat / metrics / attach / cancel)    |
| `url.ts`           | Authenticated WebSocket URL construction                                |
| `session.ts`       | Session identifier lifecycle and `AttachToSession` reconnect            |
| `events.ts`        | Frame normalization, event classification, text accumulator             |
| `stream-events.ts` | Semantic update classification and nested tool-event extraction         |
| `client.ts`        | `ChatHubClient` run loop, timers, abort, result assembly                |
| `types.ts`         | Public types and interfaces                                             |

## Import

```ts
import {
    ChatHubClient,
    createSessionIds,
    nextChatSessionId,
    resumeChatHubSession,
} from "./src/protocol/mod.ts";
```

## Identifier lifetimes

ChatHub uses three distinct identifiers:

- `sessionId`: page or logical-session scope and may span several user turns.
- `conversationId`: conversation scope and is reused for multi-turn context.
- `chatSessionId`: one ChatHub invocation. Reuse it only when reconnecting with
  `AttachToSession`.

Use `createSessionIds()` for a new conversation and `nextChatSessionId()` before
a new user turn in the same conversation.

## Basic chat

```ts
import { ChatHubClient, createSessionIds, nextChatSessionId } from "./mod.ts";

const client = new ChatHubClient();
let ids = createSessionIds();

const connection = {
    oid: Deno.env.get("M365_OID")!,
    tid: Deno.env.get("M365_TID")!,
    accessToken: Deno.env.get("M365_ACCESS_TOKEN")!,
    ...ids,
};

const result = await client.chat(
    connection,
    { text: "Summarize the current conversation." },
    {
        onEvent(event) {
            if (event.kind === "update" && event.text) {
                console.log(event.text);
            }
        },
    },
);

console.log(result.text);

// Preserve sessionId and conversationId, but use a new invocation ID.
ids = nextChatSessionId(ids);
```

Running this example requires network and environment permissions:

```sh
deno run --allow-net --allow-env src/protocol/examples/chat.ts
```

## Cancellation

```ts
const controller = new AbortController();

const pending = client.chat(connection, { text: "Explain this document." }, {
    signal: controller.signal,
});

controller.abort();
await pending;
```

Cancellation rejects with `ChatHubAbortError`, whose error name is `AbortError`.

## Streaming and final text

`ChatHubClient.chat` emits events as frames arrive. The `onEvent` callback is
invoked for every record after the handshake. Events expose the normalized text,
messages, references, and suggestions of each update.

The final `ChatHubResult` includes:

- `text`: the accumulated text (snapshot plus delta channels).
- `finalText`: the authoritative text from the stream item (`type:2`), when one
  was received.
- `references`: deduplicated references collected across all updates (both the
  argument-level and the message-level `references` dictionaries).
- `suggestions`: deduplicated suggested responses collected from bot messages.
- `receivedTokenMetrics`: token latency statistics when more than one frame was
  received (`TokenCount`, `CharCount`, `TimeBetweenTokens`, ...). Used to build
  the optional response-phase `Metrics` frame.

## Resume an interrupted invocation

`AttachToSession` must reuse the original `chatSessionId`. It performs a new
SignalR handshake and sends only Ping plus `AttachToSession`; it does not resend
the original chat request.

```ts
const result = await resumeChatHubSession(client, connection, {
    maxReconnectAttempts: 3,
    reconnectDelayMs: 500,
});
```

## Testing

```sh
deno fmt --check src/protocol tests/protocol
deno lint src/protocol tests/protocol
deno check main.ts src/protocol/mod.ts tests/protocol/chathub.test.ts tests/protocol/stream-events.test.ts
deno test -A tests/protocol
```

Tests use an injected `webSocketFactory` and a fake `EventTarget` socket rather
than real M365 credentials or external network access.

## Protocol notes

- Handshake: after the upgrade, the client sends
  `{"protocol":"json","version":1}` followed by a Ping; the server ack is `{}`.
- One WebSocket connection carries one user turn. Multi-turn conversations open
  a new connection per turn and reuse `ConversationId`.
- `invocationId` defaults to `"0"`; do not reuse a socket for a second chat.
- The idle timeout defaults to 120 s, comfortably above the observed 15 s ping
  cadence; long image-generation turns can exceed 60 s between content frames
  without indicating a failure.
- The decoder preserves raw frames and tolerates unknown fields and message
  types. For a full description of frames, identifiers, throttling, references,
  and evidence boundaries see `M365-Copilot2API/SPEC.md`.

## Stability notice

ChatHub is a private, undocumented protocol. Fields and behavior can vary by
tenant, license, experiment ring, and Microsoft client version. The module
therefore preserves raw frames and tolerates unknown fields and message types
wherever possible.
