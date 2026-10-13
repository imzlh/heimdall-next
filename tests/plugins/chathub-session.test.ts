import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type {
    GenerationRequest,
    Message,
    OperationRequest,
    StreamEvent,
} from "@heimdall/contracts";
import { estimateTokens } from "@heimdall/tokens";
import { createChatHubSource } from "../../plugins/chathub-source/mod.ts";
import { collectImages } from "../../plugins/chathub-source/images.ts";
import { encodeRecord } from "../../plugins/chathub-source/protocol/codec.ts";
import { RECORD_SEPARATOR } from "../../plugins/chathub-source/protocol/constants.ts";
import type { WebSocketLike } from "../../plugins/chathub-source/protocol/types.ts";

const config = {
    id: "chathub-session-test",
    oid: "account-id",
    tid: "tenant-id",
    accessToken: "test-access-token",
    endpoint: "wss://chathub.invalid/Chathub",
    models: ["test-model", "other-model", "gpt-5.6-sol"],
};

function message(
    id: string,
    role: "user" | "assistant",
    text: string,
): Message {
    return { id, role, parts: [{ id: `${id}:text`, type: "text", text }] };
}

function request(
    overrides: Partial<GenerationRequest> = {},
): OperationRequest<GenerationRequest> {
    return {
        version: 1,
        requestId: crypto.randomUUID(),
        operation: "generation.create",
        traits: {},
        payload: {
            model: "test-model",
            messages: [
                message("user-1", "user", "Remember the original task."),
            ],
            ...overrides,
        },
    };
}

function followup(
    previous: OperationRequest<GenerationRequest>,
    overrides: Partial<GenerationRequest> = {},
): OperationRequest<GenerationRequest> {
    return request({
        ...previous.payload,
        messages: [
            ...previous.payload.messages,
            message("assistant-1", "assistant", "Remembered."),
            message("user-2", "user", "Continue with the next step."),
        ],
        ...overrides,
    });
}

async function run(
    source: ReturnType<typeof createChatHubSource>,
    input: OperationRequest<GenerationRequest>,
    signal = new AbortController().signal,
): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (
        const frame of source.execute(input, {
            requestId: input.requestId,
            signal,
            metadata: {},
            conversationId: "stable-session",
        })
    ) events.push(frame.event);
    return events;
}

type Reply = string | Error | (() => void);

class ScriptedSocket extends EventTarget implements WebSocketLike {
    readyState = 0;
    #handshake = false;
    constructor(
        readonly reply: Reply,
        readonly prompts: string[],
        readonly annotationIds: string[][],
    ) {
        super();
        queueMicrotask(() => {
            if (this.readyState !== 0) return;
            this.readyState = 1;
            this.dispatchEvent(new Event("open"));
        });
    }
    send(data: string): void {
        if (!this.#handshake) {
            this.#handshake = true;
            this.#respond(encodeRecord({}));
            return;
        }
        const frames = data.split(RECORD_SEPARATOR).filter(Boolean).map((
            text,
        ) => JSON.parse(text));
        const chat = frames.find((frame) => frame.target === "chat");
        if (!chat) return;
        this.prompts.push(chat.arguments[0].message.text);
        this.annotationIds.push(
            chat.arguments[0].message.messageAnnotations.map((
                annotation: { id: string },
            ) => annotation.id),
        );
        queueMicrotask(() => {
            if (this.readyState !== 1) return;
            if (this.reply instanceof Error) {
                this.dispatchEvent(
                    new ErrorEvent("error", { error: this.reply }),
                );
            } else if (typeof this.reply === "function") {
                this.reply();
            } else {
                this.#respond(
                    encodeRecord({
                        type: 2,
                        item: {
                            messages: [{ author: "bot", text: this.reply }],
                        },
                    }) + encodeRecord({ type: 3 }),
                );
            }
        });
    }
    #respond(data: string): void {
        queueMicrotask(() => {
            if (this.readyState !== 1) return;
            this.dispatchEvent(new MessageEvent("message", { data }));
        });
    }
    close(): void {
        this.readyState = 3;
    }
}

function scripted(replies: Reply[]) {
    const urls: URL[] = [];
    const prompts: string[] = [];
    const annotationIds: string[][] = [];
    const uploads: { conversationId: string | null; dataUrl: string | null }[] =
        [];
    const source = createChatHubSource(config, {
        pingIntervalMs: 0,
        webSocketFactory(url) {
            const reply = replies[urls.length];
            assert(
                reply !== undefined,
                "Unexpected additional upstream request",
            );
            urls.push(new URL(url));
            return new ScriptedSocket(reply, prompts, annotationIds);
        },
        fetch: ((url: string | URL | Request, init?: RequestInit) => {
            assertStringIncludes(String(url), "/UploadFile");
            const form = new URLSearchParams(init?.body as string);
            uploads.push({
                conversationId: form.get("conversationId"),
                dataUrl: form.get("FileBase64"),
            });
            return Promise.resolve(Response.json({
                docId: `uploaded-image-${uploads.length}`,
                fileName: "image.png",
                fileType: "png",
                result: { value: "Success" },
            }));
        }) as typeof fetch,
    });
    return { source, urls, prompts, uploads, annotationIds };
}

function assertFresh(urls: URL[], earlier = 0, later = 1): void {
    assert(
        urls[earlier]!.searchParams.get("ConversationId") !==
            urls[later]!.searchParams.get("ConversationId"),
        "A changed or contaminated context must start a fresh conversation",
    );
}

function assertUsage(
    events: StreamEvent[],
    prompts: string[],
    replies: string[],
) {
    const usages = events.filter((event) => event.kind === "usage");
    assert(usages.length > 0, "All completed upstream work must report usage");
    const input = prompts.reduce((sum, text) => sum + estimateTokens(text), 0);
    const output = replies.reduce((sum, text) => sum + estimateTokens(text), 0);
    assertEquals(
        usages.reduce((sum, event) => sum + (event.usage.inputTokens ?? 0), 0),
        input,
    );
    assertEquals(
        usages.reduce((sum, event) => sum + (event.usage.outputTokens ?? 0), 0),
        output,
    );
    assertEquals(
        usages.reduce((sum, event) => sum + (event.usage.totalTokens ?? 0), 0),
        input + output,
    );
    assert(usages.every((event) => event.usage.extensions?.estimated === true));
}

const tools: GenerationRequest["tools"] = [{
    name: "lookup",
    description: "Look up a record by its key.",
    inputSchema: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
    },
}];
const toolReply = 'CALL_TOOL: lookup({"key":"record-1"})';

Deno.test("ChatHub reuses unchanged soft thinking settings and matching history", async () => {
    const { source, urls, prompts } = scripted(["Remembered.", "Continued."]);
    const first = request({
        model: "gpt-5.6-sol",
        extensions: { raw: { reasoning_effort: "high" } },
    });
    assertEquals((await run(source, first)).at(-1)?.kind, "run.completed");
    assertEquals(
        (await run(source, followup(first))).at(-1)?.kind,
        "run.completed",
    );
    assertEquals(
        urls[0]!.searchParams.get("ConversationId"),
        urls[1]!.searchParams.get("ConversationId"),
    );
    assertEquals(prompts[1]!.includes("Remember the original task."), false);
    assertStringIncludes(prompts[1]!, "Continue with the next step.");
});

Deno.test("ChatHub rebuilds context when available tool schemas change", async () => {
    const { source, urls, prompts } = scripted(["Remembered.", "Continued."]);
    const first = request({ tools, toolChoice: "none" });
    assertEquals((await run(source, first)).at(-1)?.kind, "run.completed");
    const changed = followup(first, {
        tools: [{
            ...tools[0]!,
            inputSchema: {
                type: "object",
                properties: { key: { type: "integer" } },
                required: ["key"],
                additionalProperties: false,
            },
        }],
    });
    assertEquals((await run(source, changed)).at(-1)?.kind, "run.completed");
    assertFresh(urls);
    assertStringIncludes(prompts[1]!, "Remember the original task.");
});

for (
    const scenario of [
        {
            name: "model changes even when both models use the same tone",
            first: {},
            next: { model: "other-model" },
        },
        {
            name: "reasoning engine changes",
            first: {
                model: "gpt-5.6-sol",
                extensions: { raw: { reasoning_effort: "low" } },
            },
            next: { extensions: { raw: { reasoning_effort: "high" } } },
        },
        {
            name:
                "soft thinking effort changes within the same reasoning engine",
            first: {
                model: "gpt-5.6-sol",
                extensions: { raw: { reasoning_effort: "medium" } },
            },
            next: { extensions: { raw: { reasoning_effort: "xhigh" } } },
        },
    ] satisfies {
        name: string;
        first: Partial<GenerationRequest>;
        next: Partial<GenerationRequest>;
    }[]
) {
    Deno.test(`ChatHub rebuilds context when ${scenario.name}`, async () => {
        const { source, urls, prompts } = scripted([
            "Remembered.",
            "Continued.",
        ]);
        const first = request(scenario.first);
        assertEquals((await run(source, first)).at(-1)?.kind, "run.completed");
        const second = followup(first, scenario.next);
        assertEquals((await run(source, second)).at(-1)?.kind, "run.completed");
        assertFresh(urls);
        assertStringIncludes(prompts[1]!, "Remember the original task.");
        assertStringIncludes(prompts[1]!, "Remembered.");
    });
}

Deno.test("ChatHub rebuilds context when an earlier inline image changes", async () => {
    const { source, urls, uploads } = scripted(["Remembered.", "Continued."]);
    const imageMessage = (value: number): Message => ({
        id: "user-1",
        role: "user",
        parts: [
            { id: "text-1", type: "text", text: "Remember this image." },
            {
                id: "image-1",
                type: "image",
                source: {
                    mediaType: "image/png",
                    data: new Uint8Array([value]),
                },
            },
        ],
    });
    const first = request({ messages: [imageMessage(1)] });
    assertEquals((await run(source, first)).at(-1)?.kind, "run.completed");
    const second = followup(first);
    const changed = request({
        ...second.payload,
        messages: [imageMessage(2), ...second.payload.messages.slice(1)],
    });
    assertEquals((await run(source, changed)).at(-1)?.kind, "run.completed");
    assertFresh(urls);
    assertEquals(uploads.map((upload) => upload.dataUrl), [
        "data:image/png;base64,AQ==",
        "data:image/png;base64,Ag==",
    ]);
});

function imageMessage(
    id: string,
    role: "user" | "assistant",
    bytes: number[],
): Message {
    return {
        id,
        role,
        parts: bytes.map((value) => ({
            id: `${id}:image:${value}`,
            type: "image",
            source: { mediaType: "image/png", data: new Uint8Array([value]) },
        })),
    };
}

Deno.test("ChatHub image replay retains the newest ten user images across history", () => {
    const payload = request({
        messages: [
            imageMessage("user-1", "user", [1, 2, 3, 4, 5, 6]),
            imageMessage("assistant-1", "assistant", [99]),
            imageMessage("user-2", "user", [7, 8, 9, 10, 11, 12]),
            message("user-3", "user", "Compare the images I sent earlier."),
        ],
    }).payload;
    assertEquals(collectImages(payload), []);
    assertEquals(
        collectImages(payload, true).map((image) => [...image.data]),
        [[3], [4], [5], [6], [7], [8], [9], [10], [11], [12]],
    );
});

for (const routing of [false, true]) {
    Deno.test(`ChatHub replays historical user images on a fresh ${routing ? "tool router" : "answer"} request`, async () => {
        const { source, urls, uploads, annotationIds } = scripted([
            routing ? toolReply : "The earlier image contains the answer.",
        ]);
        const events = await run(
            source,
            request({
                messages: [
                    imageMessage("user-1", "user", [1]),
                    message("assistant-1", "assistant", "Remembered."),
                    message("user-2", "user", "Use the earlier image."),
                ],
                ...(routing ? { tools, toolChoice: "required" } : {}),
            }),
        );
        assertEquals(events.at(-1), {
            kind: "run.completed",
            finishReason: routing ? "tool_calls" : "stop",
        });
        assertEquals(uploads, [{
            conversationId: urls[0]!.searchParams.get("ConversationId"),
            dataUrl: "data:image/png;base64,AQ==",
        }]);
        assertEquals(annotationIds, [["uploaded-image-1"]]);
    });
}

for (const failure of ["error", "cancel"] as const) {
    Deno.test(`ChatHub discards a reused session after ${failure}`, async () => {
        const abort = new AbortController();
        const { source, urls, prompts } = scripted([
            "Remembered.",
            failure === "error"
                ? new Error("upstream disconnected")
                : () => abort.abort(),
            "Continued.",
        ]);
        const first = request();
        assertEquals((await run(source, first)).at(-1)?.kind, "run.completed");
        const second = followup(first);
        assertEquals(
            (await run(source, second, abort.signal)).at(-1)?.kind,
            failure === "error" ? "run.error" : "run.cancelled",
        );
        assertEquals(
            urls[0]!.searchParams.get("ConversationId"),
            urls[1]!.searchParams.get("ConversationId"),
        );
        assertEquals(source.uiSnapshot().runtime, {
            warmContexts: 0,
            busyContexts: 0,
        });
        assertEquals((await run(source, second)).at(-1)?.kind, "run.completed");
        assertFresh(urls, 1, 2);
        assertStringIncludes(prompts[2]!, "Remember the original task.");
    });
}

Deno.test("ChatHub reports usage for a tool-routing-only turn", async () => {
    const { source, prompts } = scripted([toolReply]);
    const events = await run(
        source,
        request({ tools, toolChoice: "required" }),
    );
    assertEquals(events.at(-1), {
        kind: "run.completed",
        finishReason: "tool_calls",
    });
    assertUsage(events, prompts, [toolReply]);
});

Deno.test("ChatHub counts both no-tool routing and the final answer", async () => {
    const replies = ["NO_TOOL_NEEDED", "No lookup is needed for this answer."];
    const { source, prompts } = scripted(replies);
    const events = await run(source, request({ tools }));
    assertEquals(events.at(-1), {
        kind: "run.completed",
        finishReason: "stop",
    });
    assertEquals(prompts.length, 2);
    assertUsage(events, prompts, replies);
});

Deno.test("ChatHub repairs one invalid routing response and accounts for both attempts", async () => {
    const invalid = 'CALL_TOOL: lookup({"key":7})';
    const { source, prompts } = scripted([invalid, toolReply]);
    const events = await run(
        source,
        request({ tools, toolChoice: "required" }),
    );
    assertEquals(events.at(-1), {
        kind: "run.completed",
        finishReason: "tool_calls",
    });
    assertEquals(prompts.length, 2);
    assertStringIncludes(prompts[1]!, JSON.stringify(invalid));
    const calls = events.filter((event) =>
        event.kind === "part.started" && event.part.type === "tool_call"
    );
    assertEquals(calls.length, 1);
    assertUsage(events, prompts, [invalid, toolReply]);
});

Deno.test("ChatHub stops after a second invalid routing response", async () => {
    const { source, prompts } = scripted([
        "not a decision",
        "still not a decision",
    ]);
    const events = await run(
        source,
        request({ tools, toolChoice: "required" }),
    );
    assertEquals(prompts.length, 2);
    assertEquals(events.at(-1)?.kind, "run.error");
    assertEquals(events.some((event) => event.kind === "run.completed"), false);
    assertEquals(
        events.some((event) =>
            event.kind === "part.started" && event.part.type === "tool_call"
        ),
        false,
    );
});

Deno.test("ChatHub repairs parallel calls when parallel_tool_calls is false", async () => {
    const batch = JSON.stringify({
        calls: [
            { name: "lookup", arguments: { key: "record-1" } },
            { name: "lookup", arguments: { key: "record-2" } },
        ],
    });
    const { source, prompts } = scripted([batch, toolReply]);
    const events = await run(
        source,
        request({
            tools,
            toolChoice: "required",
            extensions: { raw: { parallel_tool_calls: false } },
        }),
    );
    assertEquals(events.at(-1), {
        kind: "run.completed",
        finishReason: "tool_calls",
    });
    assertEquals(prompts.length, 2);
    assertEquals(
        events.filter((event) =>
            event.kind === "part.started" && event.part.type === "tool_call"
        ).length,
        1,
    );
    assertUsage(events, prompts, [batch, toolReply]);
});
