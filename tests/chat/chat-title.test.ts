import { assert, assertEquals } from "@std/assert";
import type { InferenceSource } from "@heimdall/contracts";
import type { StreamEvent, StreamFrame } from "@heimdall/hip";
import { SourceRegistry } from "@heimdall/kernel";
import { createServer } from "../../main.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";

const origin = "http://localhost";
const createdAt = "2026-09-22T00:00:00.000Z";

/** A minimal streaming source: one text part, plus any extra trailing events. */
function textSource(
    id: string,
    models: string[],
    reply: (model: string) => { text: string; extra?: StreamEvent[] },
): InferenceSource {
    return {
        id,
        capabilities: [{
            operation: "generation.create",
            models,
            streaming: true,
        }],
        execute(request) {
            const model = (request.payload as { model?: string }).model ?? "";
            const { text, extra = [] } = reply(model);
            let seq = 0;
            const frame = (event: StreamEvent): StreamFrame => ({
                version: 1,
                streamId: "run:" + request.requestId,
                requestId: request.requestId,
                seq: ++seq,
                eventId: `${request.requestId}:${seq}`,
                timestamp: createdAt,
                event,
            });
            return (async function* () {
                yield frame({ kind: "run.started", request });
                yield frame({
                    kind: "message.started",
                    message: {
                        id: "m",
                        role: "assistant",
                        parts: [],
                        status: "in_progress",
                    },
                });
                yield frame({
                    kind: "part.started",
                    messageId: "m",
                    part: { id: "p", type: "text", text: "" },
                });
                yield frame({
                    kind: "part.delta",
                    messageId: "m",
                    partId: "p",
                    delta: text,
                });
                yield frame({
                    kind: "part.completed",
                    messageId: "m",
                    partId: "p",
                });
                for (const event of extra) yield frame(event);
                yield frame({
                    kind: "message.completed",
                    messageId: "m",
                    finishReason: "stop",
                });
                yield frame({ kind: "run.completed", finishReason: "stop" });
            })();
        },
    };
}

async function send(
    app: ReturnType<typeof createServer>,
    conversationId: string,
    model: string,
): Promise<{ title: string }> {
    const response = await app.request(`${origin}/api/chat/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, model, text: "你好" }),
    });
    assertEquals(response.status, 200);
    const body = await response.json();
    return { title: body.conversation.title };
}

Deno.test("chat adopts a source-provided title over the first-message heuristic", async () => {
    const store = openSqliteChatStore(":memory:");
    try {
        const registry = new SourceRegistry();
        registry.register(textSource("srv", ["m-title"], () => ({
            text: "回答内容",
            extra: [{ kind: "title", title: "关于猫的对话" }],
        })));
        const app = createServer({
            sources: [registry.get("srv")!],
            chat: { store },
        });
        const conversation = store.createConversation("新对话", createdAt);
        const { title } = await send(app, conversation.id, "m-title");
        assertEquals(title, "关于猫的对话");
    } finally {
        store.close();
    }
});

Deno.test("chat generates a title with the configured cheap model when the source has none", async () => {
    const store = openSqliteChatStore(":memory:");
    try {
        const registry = new SourceRegistry();
        registry.register(
            textSource(
                "multi",
                ["m-chat", "m-title"],
                (model) =>
                    model === "m-title"
                        ? { text: "猫咪笑话合集" }
                        : { text: "这是一个关于猫的笑话……" },
            ),
        );
        const app = createServer({
            sources: [registry.get("multi")!],
            chat: { store, titleModel: () => "m-title" },
        });
        const conversation = store.createConversation("新对话", createdAt);
        const { title } = await send(app, conversation.id, "m-chat");
        assertEquals(title, "猫咪笑话合集");
        assert(title !== "新对话");
    } finally {
        store.close();
    }
});
