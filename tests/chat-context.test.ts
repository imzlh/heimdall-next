import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type {
    GenerationRequest,
    RequestContext,
    StreamFrame,
} from "@heimdall/contracts";
import {
    KernelRuntime,
    MiddlewareRegistry,
    SourceRegistry,
} from "@heimdall/kernel";
import { executeCommand } from "@heimdall/core/chat/service.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";
import { createServer } from "../main.ts";
import { createChatHubSource } from "../plugins/chathub-source/mod.ts";
import { createOpenAICompatibleSource } from "../plugins/openai-source/mod.ts";
import { encodeRecord } from "../plugins/chathub-source/protocol/codec.ts";
import type { WebSocketLike } from "../plugins/chathub-source/protocol/types.ts";

const timestamp = "2026-09-28T00:00:00.000Z";

Deno.test("chat context stays at the host boundary while explicit provider metadata survives middleware", async () => {
    const store = openSqliteChatStore(":memory:");
    const middleware = new MiddlewareRegistry();
    middleware.register({
        manifest: {
            id: "fixture.provider.metadata",
            name: "Provider metadata",
            version: "1.0.0",
            apiVersion: "1",
            kind: "middleware",
            trust: "trusted",
        },
        transformRequest(input) {
            assert(input.metadata?.sessionId);
            return {
                ...input,
                payload: {
                    ...input.payload as GenerationRequest,
                    metadata: { provider_tag: "kept" },
                },
            };
        },
    });
    const requests: Record<string, unknown>[] = [];
    const source = createOpenAICompatibleSource({
        id: "context-openai",
        baseUrl: "https://provider.invalid/v1",
    }, {
        fetch: (_input, init) => {
            requests.push(JSON.parse(String(init?.body)));
            return Promise.resolve(Response.json({
                choices: [{
                    message: { role: "assistant", content: "answer" },
                    finish_reason: "stop",
                }],
            }));
        },
    });
    const app = createServer({
        sources: [source],
        middleware,
        chat: { store },
    });
    try {
        const conversation = store.createConversation("existing", timestamp);
        const response = await app.request(
            "http://localhost/api/chat/message",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    conversationId: conversation.id,
                    model: "m",
                    text: "question",
                }),
            },
        );
        assertEquals(response.status, 200, await response.text());
        assertEquals(requests.length, 1);
        assertEquals(requests[0]!.metadata, { provider_tag: "kept" });
        assert(!JSON.stringify(requests).includes(conversation.id));
    } finally {
        store.close();
    }
});

Deno.test("chat service preserves host/plugin metadata while deriving canonical conversation identity", async () => {
    const store = openSqliteChatStore(":memory:");
    const seen: RequestContext[] = [];
    const middleware = new MiddlewareRegistry();
    middleware.register({
        manifest: {
            id: "fixture.context",
            name: "Context observer",
            version: "1.0.0",
            apiVersion: "1",
            kind: "middleware",
            trust: "trusted",
        },
        transformRequest(input, context) {
            seen.push(context.request);
            assertEquals(input.metadata, context.request.metadata);
            assertEquals(
                (input.payload as GenerationRequest).metadata,
                undefined,
            );
            return input;
        },
    });
    const sources = new SourceRegistry();
    sources.register({
        id: "context-source",
        capabilities: [{ operation: "generation.create", streaming: false }],
        execute(input, context) {
            assertEquals(context.metadata, seen.at(-1)!.metadata);
            return (async function* () {
                const events = [
                    { kind: "run.started", request: input },
                    {
                        kind: "part.delta",
                        messageId: "m",
                        partId: "p",
                        delta: "answer",
                    },
                    { kind: "run.completed" },
                ] as const;
                for (const [index, event] of events.entries()) {
                    yield {
                        version: 1,
                        requestId: input.requestId,
                        streamId: `run:${input.requestId}`,
                        seq: index + 1,
                        eventId: `${input.requestId}:${index}`,
                        timestamp,
                        event,
                    } satisfies StreamFrame;
                }
            })();
        },
    });
    try {
        const conversation = store.createConversation("新对话", timestamp);
        const request = new Request("http://localhost/api/chat/message", {
            method: "POST",
        });
        const context: RequestContext = {
            request,
            requestId: "command-1",
            signal: request.signal,
            route: {
                method: "POST",
                path: "/api/chat/message",
                operation: "generation.create",
            },
            metadata: {
                conversationId: "stale-conversation",
                sessionId: "stale-session",
                traceId: "existing-trace",
                purpose: "plugin.workflow",
                "source.options": { tenant: "fixture", flags: [true, "value"] },
            },
        };
        await executeCommand(
            { store, runtime: new KernelRuntime({ sources, middleware }) },
            {
                type: "send",
                conversationId: conversation.id,
                model: "m",
                text: "question",
            },
            context,
        );
        assertEquals(seen.map((item) => item.requestId), [
            "command-1",
            "command-1:title",
        ]);
        for (const [index, item] of seen.entries()) {
            assertEquals(item.request, request);
            assertEquals(item.signal, request.signal);
            assertEquals(item.metadata, {
                ...context.metadata,
                conversationId: conversation.id,
                sessionId: conversation.id,
                command: "send",
                purpose: index === 0 ? "plugin.workflow" : "chat.title",
            });
        }
        assertEquals(context.metadata.conversationId, "stale-conversation");
    } finally {
        store.close();
    }
});

Deno.test("chat HTTP plus middleware retains ChatHub warm context across an automatic title request", async () => {
    const store = openSqliteChatStore(":memory:");
    const urls: URL[] = [];
    const middleware = new MiddlewareRegistry();
    const purposes: unknown[] = [];
    middleware.register({
        manifest: {
            id: "fixture.chathub.context",
            name: "ChatHub context observer",
            version: "1.0.0",
            apiVersion: "1",
            kind: "middleware",
            trust: "trusted",
        },
        transformRequest(input, context) {
            assert(context.request.metadata.conversationId);
            assertEquals(
                context.request.metadata.sessionId,
                context.request.metadata.conversationId,
            );
            assertEquals(input.metadata, context.request.metadata);
            purposes.push(context.request.metadata.purpose);
            return input;
        },
    });
    const source = createChatHubSource({
        id: "chathub-context",
        oid: "test-account",
        tid: "test-tenant",
        accessToken: "fixture-token",
        endpoint: "wss://chathub.invalid/Chathub",
        models: ["test-model"],
    }, {
        webSocketFactory(url) {
            urls.push(new URL(url));
            return new ReplySocket();
        },
    });
    const app = createServer({
        sources: [source],
        middleware,
        chat: { store },
    });
    try {
        const conversation = store.createConversation("新对话", timestamp);
        for (const text of ["first question", "follow-up question"]) {
            const response = await app.request(
                "http://localhost/api/chat/message",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        conversationId: conversation.id,
                        model: "test-model",
                        text,
                    }),
                },
            );
            assertEquals(response.status, 200, await response.text());
        }
        assertEquals(purposes, ["chat", "chat.title", "chat"]);
        assertEquals(urls.length, 3);
        const ids = urls.map((url) => url.searchParams.get("ConversationId"));
        assert(ids.every((id) => id));
        assertNotEquals(ids[0], ids[1]);
        assertEquals(ids[0], ids[2]);
        assertEquals(
            urls[0]!.searchParams.get("X-SessionId"),
            urls[2]!.searchParams.get("X-SessionId"),
        );
    } finally {
        store.close();
    }
});

/** Deterministic provider transport: protocol and source remain their real implementations. */
class ReplySocket extends EventTarget implements WebSocketLike {
    readyState = 0;
    #sends = 0;

    constructor() {
        super();
        queueMicrotask(() => {
            if (this.readyState !== 0) return;
            this.readyState = 1;
            this.dispatchEvent(new Event("open"));
        });
    }

    send(): void {
        const data = ++this.#sends === 1 ? encodeRecord({}) : encodeRecord({
            type: 2,
            item: { messages: [{ author: "bot", text: "answer" }] },
        }) + encodeRecord({ type: 3 });
        queueMicrotask(() => {
            if (this.readyState !== 1) return;
            this.dispatchEvent(new MessageEvent("message", { data }));
        });
    }

    close(): void {
        this.readyState = 3;
    }
}
