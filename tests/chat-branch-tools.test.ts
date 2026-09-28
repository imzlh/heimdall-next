import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type { InferenceSource, ToolPlugin } from "@heimdall/contracts";
import type {
    GenerationRequest,
    OperationRequest,
    StreamFrame,
} from "@heimdall/hip";
import type { ChatMessageRecord } from "@heimdall/storage";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";
import {
    loadChatConversation,
    switchChatBranch,
} from "@heimdall/core/web/client/api/chat.ts";
import { configureAdminTransport } from "@heimdall/core/web/client/api/transport.ts";
import { createServer } from "../main.ts";

const NOW = "2026-09-27T10:00:00.000Z";
const MODEL = "tool-branch-model";
const PREFIX = "Original reply prefix";

function fixture(firstText = "") {
    const store = openSqliteChatStore(":memory:");
    const conversation = store.createConversation("Tool branch", NOW);
    const base = { conversationId: conversation.id, createdAt: NOW };
    const original: ChatMessageRecord[] = [
        { ...base, id: "user", role: "user", text: "Question" },
        { ...base, id: "reply", role: "assistant", text: PREFIX },
        { ...base, id: "later-user", role: "user", text: "Later question" },
        { ...base, id: "later-reply", role: "assistant", text: "Later answer" },
    ];
    store.appendMessages(original);
    const requests: OperationRequest[] = [];
    const calls: string[] = [];
    const source: InferenceSource = {
        id: "tool-branch-source",
        capabilities: [{
            operation: "generation.create",
            models: [MODEL],
            streaming: false,
        }],
        async *execute(input) {
            requests.push(input);
            let seq = 0;
            const frame = (event: StreamFrame["event"]): StreamFrame => ({
                version: 1,
                streamId: input.requestId,
                requestId: input.requestId,
                seq: ++seq,
                eventId: `${input.requestId}-${seq}`,
                timestamp: NOW,
                event,
            });
            yield frame({ kind: "run.started", request: input });
            if (requests.length === 1) {
                if (firstText) {
                    yield frame({
                        kind: "part.delta",
                        messageId: "m",
                        partId: "p",
                        delta: firstText,
                    });
                }
                yield frame({
                    kind: "tool.call",
                    messageId: "m",
                    callId: "lookup-1",
                    name: "lookup_detail",
                    argumentsText: '{"query":"detail"}',
                });
            } else {
                yield frame({
                    kind: "part.delta",
                    messageId: "m",
                    partId: "p",
                    delta: "Final detail",
                });
            }
            yield frame({ kind: "run.completed" });
        },
    };
    const plugin: ToolPlugin = {
        manifest: {
            id: "test.lookup",
            version: "1.0.0",
            apiVersion: "1",
            name: "Test lookup",
            kind: "tool",
            trust: "trusted",
        },
        tools: [{
            definition: {
                name: "lookup_detail",
                description: "Look up a detail",
                inputSchema: { type: "object" },
            },
            execute(call) {
                calls.push(call.callId);
                return { text: "Looked-up detail", isError: false };
            },
        }],
    };
    const app = createServer({
        sources: [source],
        chat: { store, tools: [plugin] },
    });
    // Read the real endpoint through the production browser DTO decoder, so
    // hidden tool entries cannot accidentally leak into visible branch IDs.
    configureAdminTransport((input, init) =>
        Promise.resolve(
            app.request(new URL(String(input), "http://localhost"), init),
        )
    );
    return {
        store,
        conversation,
        original,
        requests,
        calls,
        async generate(action: "continue" | "regenerate") {
            const response = await app.request(
                `http://localhost/api/chat/${action}`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        conversationId: conversation.id,
                        messageId: "reply",
                        model: MODEL,
                    }),
                },
            );
            const body = await response.json();
            assertEquals(response.status, 200, JSON.stringify(body));
            return await loadChatConversation(conversation.id);
        },
        [Symbol.dispose]() {
            configureAdminTransport();
            store.close();
        },
    };
}

function modelMessages(request: OperationRequest) {
    return (request.payload as GenerationRequest).messages;
}

function modelTexts(request: OperationRequest): string[] {
    return modelMessages(request).flatMap((message) =>
        message.parts.filter((part) => part.type === "text").map((part) =>
            part.text
        )
    );
}

for (const firstText of ["", " + intermediate"]) {
    Deno.test(
        `chat continuation ${
            firstText ? "with text and a tool" : "with only a tool"
        } retains its prefix exactly once across model rounds and saved branches`,
        async () => {
            using test = fixture(firstText);
            const result = await test.generate("continue");
            assertEquals(test.requests.length, 2);
            assertEquals(test.calls, ["lookup-1"]);
            assertEquals(modelTexts(test.requests[0]!), ["Question", PREFIX]);
            assertEquals(modelTexts(test.requests[1]!), [
                "Question",
                PREFIX + firstText,
            ]);
            assertEquals(result.messages.map((message) => message.text), [
                "Question",
                PREFIX + firstText,
                '{"query":"detail"}',
                "Looked-up detail",
                "Final detail",
            ]);
            assertEquals(
                modelMessages(test.requests[1]!).map((message) => message.id),
                result.messages.slice(0, -1).map((message) => message.id),
            );
            const newPrefix = result.messages[1]!;
            assertNotEquals(newPrefix.id, "reply");
            assertEquals(newPrefix.parentId, "user");
            assertEquals(newPrefix.branch, {
                index: 1,
                count: 2,
                messageIds: ["reply", newPrefix.id],
            });
            const secondParts = modelMessages(test.requests[1]!).flatMap((m) =>
                m.parts
            );
            assertEquals(secondParts.map((part) => part.type), [
                "text",
                "text",
                "tool_call",
                "tool_result",
            ]);
            const all = test.store.listAllMessages(test.conversation.id);
            assertEquals(all.length, 8);
            assertEquals(new Set(all.map((message) => message.id)).size, 8);
            assertEquals(
                all.find((message) => message.id === "reply")?.text,
                PREFIX,
            );
            const original = await switchChatBranch(
                test.conversation.id,
                "reply",
            );
            assertEquals(original.messages.map((message) => message.id), [
                "user",
                "reply",
                "later-user",
                "later-reply",
            ]);
            const selected = await switchChatBranch(
                test.conversation.id,
                newPrefix.id,
            );
            assertEquals(selected.messages, result.messages);
            assertEquals(test.store.listAllMessages(test.conversation.id), all);
            assertEquals(test.requests.length, 2);
        },
    );
}

Deno.test("chat regeneration through a tool-only round exposes visible reply variants and restores both descendant paths", async () => {
    using test = fixture();
    const result = await test.generate("regenerate");
    assertEquals(test.requests.length, 2);
    assertEquals(test.calls, ["lookup-1"]);
    assertEquals(modelTexts(test.requests[0]!), ["Question"]);
    assertEquals(modelTexts(test.requests[1]!), ["Question"]);
    assertEquals(result.messages.map((message) => message.text), [
        "Question",
        '{"query":"detail"}',
        "Looked-up detail",
        "Final detail",
    ]);
    const answer = result.messages.at(-1)!;
    assert(answer.branch);
    assertEquals(answer.branch, {
        index: 1,
        count: 2,
        messageIds: ["reply", answer.id],
    });
    const all = test.store.listAllMessages(test.conversation.id);
    assertEquals(all.length, 7);
    assertEquals(new Set(all.map((message) => message.id)).size, 7);
    for (const id of answer.branch.messageIds) {
        const visible = all.find((message) => message.id === id);
        assert(visible && visible.role === "assistant" && !visible.callId);
    }
    const original = await switchChatBranch(test.conversation.id, "reply");
    assertEquals(original.messages.map((message) => message.id), [
        "user",
        "reply",
        "later-user",
        "later-reply",
    ]);
    assertEquals(original.messages[1]?.branch, {
        ...answer.branch,
        index: 0,
    });
    const selected = await switchChatBranch(test.conversation.id, answer.id);
    assertEquals(selected.messages, result.messages);
    assertEquals(test.store.listAllMessages(test.conversation.id), all);
    assertEquals(test.requests.length, 2);
});
