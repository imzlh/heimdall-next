import { assert, assertEquals } from "@std/assert";
import type { InferenceSource, OperationRequest } from "@heimdall/contracts";
import type { StreamFrame } from "@heimdall/hip";
import { createServer } from "../main.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";
import { createWebToolPlugin } from "../plugins/tool-web/mod.ts";
import {
    createChatToolset,
    newRunBudget,
} from "@heimdall/core/chat/tools/toolset.ts";

type RoundScript =
    | { readonly tool: { callId: string; name: string; argumentsText: string } }
    | { readonly text: string };

type TestApp = {
    request(url: string, init?: RequestInit): Response | Promise<Response>;
};

function frame(
    input: OperationRequest,
    seq: number,
    event: StreamFrame["event"],
): StreamFrame {
    return {
        version: 1,
        streamId: "chat-stream",
        requestId: input.requestId,
        seq,
        eventId: `chat-${seq}`,
        timestamp: "2026-09-22T00:00:00.000Z",
        event,
    };
}

/** A source that plays one scripted round per completion, capturing requests. */
function scriptedSource(
    scripts: readonly RoundScript[],
): { source: InferenceSource; requests: OperationRequest[] } {
    const requests: OperationRequest[] = [];
    let runs = 0;
    const source: InferenceSource = {
        id: "tool-source",
        capabilities: [{
            operation: "generation.create",
            models: ["chat-model"],
            streaming: false,
        }],
        execute(input) {
            requests.push(input);
            const script = scripts[runs] ?? { text: "done" };
            runs += 1;
            return (async function* (): AsyncIterable<StreamFrame> {
                yield frame(input, 1, { kind: "run.started", request: input });
                if ("tool" in script) {
                    yield frame(input, 2, {
                        kind: "tool.call",
                        messageId: "m",
                        callId: script.tool.callId,
                        name: script.tool.name,
                        argumentsText: script.tool.argumentsText,
                    });
                } else {
                    yield frame(input, 2, {
                        kind: "part.delta",
                        messageId: "m",
                        partId: "p",
                        delta: script.text,
                    });
                }
                yield frame(input, 3, { kind: "run.completed" });
            })();
        },
    };
    return { source, requests };
}
function tavilyFetch(calls: { url: string; query: unknown }[]): typeof fetch {
    return ((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const body = JSON.parse(String(init?.body ?? "{}"));
        calls.push({ url, query: body.query });
        return Promise.resolve(
            new Response(
                JSON.stringify({
                    results: [{
                        title: `Result for ${body.query}`,
                        url: "https://example.com/a",
                        content: "snippet text",
                    }],
                }),
                {
                    status: 200,
                    headers: { "content-type": "application/json" },
                },
            ),
        );
    }) as typeof fetch;
}

async function newConversation(
    app: TestApp,
): Promise<string> {
    const res = await app.request("http://localhost/api/chat/conversations", {
        method: "POST",
    });
    return (await res.json()).conversation.id as string;
}

async function sendMessage(
    app: TestApp,
    conversationId: string,
    text: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await app.request("http://localhost/api/chat/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, model: "chat-model", text }),
    });
    return { status: res.status, body: await res.json() };
}
Deno.test("chat runs web_search server-side and offers the tool", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-search-" });
    const store = openSqliteChatStore(`${directory}/chat.sqlite`);
    const calls: { url: string; query: unknown }[] = [];
    try {
        const { source, requests } = scriptedSource([
            {
                tool: {
                    callId: "c1",
                    name: "web_search",
                    argumentsText: '{"query":"heimdall gateway"}',
                },
            },
            { text: "final answer" },
        ]);
        const app = createServer({
            sources: [source],
            chat: {
                store,
                tools: [createWebToolPlugin({
                    fetch: tavilyFetch(calls),
                    tavilyApiKey: "test-key",
                })],
            },
        });
        const conversationId = await newConversation(app);
        const { status, body } = await sendMessage(
            app,
            conversationId,
            "look it up",
        );
        assertEquals(status, 200);
        assertEquals(body.toolCalls, []);
        assertEquals(calls.length, 1);
        assertEquals(calls[0]?.query, "heimdall gateway");
        const messages = body.messages as { role: string; text: string }[];
        assertEquals(messages.map((m) => m.role), [
            "user",
            "assistant",
            "tool",
            "assistant",
        ]);
        assertEquals(messages.at(-1)?.text, "final answer");
        assert(messages[2]?.text.includes("Result for heimdall gateway"));
        const firstTools =
            (requests[0]?.payload as { tools?: { name: string }[] }).tools ??
                [];
        assert(firstTools.some((tool) => tool.name === "web_search"));
    } finally {
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});
Deno.test("chat blocks fetch_url to a private host", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-fetch-" });
    const store = openSqliteChatStore(`${directory}/chat.sqlite`);
    let fetchCalls = 0;
    try {
        const { source } = scriptedSource([
            {
                tool: {
                    callId: "c1",
                    name: "fetch_url",
                    argumentsText: '{"url":"https://192.168.0.1/secret"}',
                },
            },
            { text: "could not read it" },
        ]);
        const guardFetch = (() => {
            fetchCalls += 1;
            return Promise.resolve(new Response("nope", { status: 200 }));
        }) as typeof fetch;
        const app = createServer({
            sources: [source],
            chat: {
                store,
                tools: [createWebToolPlugin({ fetch: guardFetch })],
            },
        });
        const conversationId = await newConversation(app);
        const { status, body } = await sendMessage(
            app,
            conversationId,
            "read it",
        );
        assertEquals(status, 200);
        assertEquals(body.toolCalls, []);
        assertEquals(fetchCalls, 0);
        const messages = body.messages as { role: string; text: string }[];
        const toolRow = messages.find((m) => m.role === "tool");
        assert(toolRow !== undefined);
        assert(toolRow.text.includes("page fetch failed"));
        assertEquals(messages.at(-1)?.text, "could not read it");
    } finally {
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});
Deno.test("chat returns an unknown tool call to the client", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-unknown-" });
    const store = openSqliteChatStore(`${directory}/chat.sqlite`);
    try {
        const { source, requests } = scriptedSource([
            {
                tool: {
                    callId: "c1",
                    name: "client_only",
                    argumentsText: "{}",
                },
            },
            { text: "unreached" },
        ]);
        const app = createServer({ sources: [source], chat: { store } });
        const conversationId = await newConversation(app);
        const { status, body } = await sendMessage(app, conversationId, "hi");
        assertEquals(status, 200);
        const toolCalls = body.toolCalls as { name: string }[];
        assertEquals(toolCalls.map((call) => call.name), ["client_only"]);
        assertEquals(requests.length, 1);
        const messages = body.messages as { role: string }[];
        assertEquals(messages.map((m) => m.role), ["user", "assistant"]);
    } finally {
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});
Deno.test("toolset caps web searches per run", async () => {
    const calls: { url: string; query: unknown }[] = [];
    const toolset = createChatToolset([createWebToolPlugin({
        fetch: tavilyFetch(calls),
        tavilyApiKey: "test-key",
    })]);
    const budget = newRunBudget();
    const signal = new AbortController().signal;
    const call = {
        callId: "c",
        name: "web_search",
        argumentsText: '{"query":"q"}',
    };
    const outcomes = [];
    for (let i = 0; i < 4; i++) {
        outcomes.push(await toolset.run(call, budget, signal));
    }
    assertEquals(outcomes.map((outcome) => outcome.isError), [
        false,
        false,
        false,
        true,
    ]);
    assert(outcomes[3]?.text.includes("budget"));
    assertEquals(calls.length, 3);
});

Deno.test("conversation can disable a tool plugin so upstream stops offering it", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-mute-tool-" });
    const store = openSqliteChatStore(`${directory}/chat.sqlite`);
    try {
        const { source, requests } = scriptedSource([{
            text: "no tools here",
        }]);
        const app = createServer({
            sources: [source],
            chat: {
                store,
                tools: [createWebToolPlugin({
                    fetch: () => Promise.resolve(new Response("x")),
                    tavilyApiKey: "test-key",
                })],
            },
        });
        const conversationId = await newConversation(app);
        const patch = await app.request(
            `http://localhost/api/chat/conversation?id=${conversationId}`,
            {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ disabledTools: ["heimdall.tool.web"] }),
            },
        );
        assertEquals(patch.status, 200);
        const patched = await patch.json();
        assertEquals(patched.conversation.disabledTools, ["heimdall.tool.web"]);

        const { status, body } = await sendMessage(
            app,
            conversationId,
            "look it up",
        );
        assertEquals(status, 200);
        const firstTools =
            (requests[0]?.payload as { tools?: { name: string }[] }).tools ??
                [];
        assertEquals(
            firstTools.some((tool) => tool.name === "web_search"),
            false,
        );
        const messages = body.messages as { role: string; text: string }[];
        assertEquals(messages.at(-1)?.text, "no tools here");

        const invalid = await app.request(
            `http://localhost/api/chat/conversation?id=${conversationId}`,
            {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ disabledTools: "web" }),
            },
        );
        assertEquals(invalid.status, 400);
    } finally {
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});
