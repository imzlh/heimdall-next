import {
    assert,
    assertEquals,
    assertRejects,
    assertStringIncludes,
} from "@std/assert";
import type {
    GenerationRequest,
    OperationRequest,
    StreamEvent,
} from "@heimdall/contracts";
import { bytesToBase64 } from "@heimdall/contracts";
import { createChatHubSource } from "../../plugins/chathub-source/mod.ts";
import {
    collectImages,
    uploadFileEndpoint,
    uploadImages,
} from "../../plugins/chathub-source/images.ts";
import { encodeRecord } from "../../plugins/chathub-source/protocol/codec.ts";
import type { WebSocketLike } from "../../plugins/chathub-source/protocol/types.ts";

const config = {
    id: "chathub",
    oid: "account-id",
    tid: "tenant-id",
    accessToken: "access-token-secret",
    endpoint: "wss://chathub.invalid/Chathub",
    models: ["test-model"],
};

async function run(
    source: ReturnType<typeof createChatHubSource>,
    request: OperationRequest<GenerationRequest>,
): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (
        const frame of source.execute(request, {
            requestId: request.requestId,
            signal: new AbortController().signal,
            metadata: {},
        })
    ) events.push(frame.event);
    return events;
}

Deno.test("collectImages takes inline images from the newest user message", () => {
    const request: GenerationRequest = {
        model: "m",
        messages: [
            {
                id: "u1",
                role: "user",
                parts: [{
                    id: "i0",
                    type: "image",
                    source: {
                        mediaType: "image/png",
                        data: new Uint8Array([9]),
                    },
                }],
            },
            {
                id: "a1",
                role: "assistant",
                parts: [{ id: "t1", type: "text", text: "hi" }],
            },
            {
                id: "u2",
                role: "user",
                parts: [
                    { id: "t2", type: "text", text: "what is this" },
                    {
                        id: "i1",
                        type: "image",
                        source: {
                            mediaType: "image/jpeg",
                            data: new Uint8Array([1, 2, 3]),
                        },
                    },
                    {
                        id: "i2",
                        type: "image",
                        source: {
                            mediaType: "image/png",
                            uri: `data:image/webp;base64,${
                                bytesToBase64(new Uint8Array([4, 5, 6]))
                            }`,
                        },
                    },
                    {
                        id: "i3",
                        type: "image",
                        source: {
                            mediaType: "image/png",
                            uri: "https://x/y.png",
                        },
                    },
                ],
            },
        ],
    };
    assertEquals(collectImages(request), [
        { mediaType: "image/jpeg", data: new Uint8Array([1, 2, 3]) },
        { mediaType: "image/webp", data: new Uint8Array([4, 5, 6]) },
    ]);
});

Deno.test("uploadFileEndpoint derives the HTTPS UploadFile URL", () => {
    assertEquals(
        uploadFileEndpoint(),
        "https://substrate.office.com/m365Copilot/UploadFile",
    );
    assertEquals(
        uploadFileEndpoint("wss://chathub.invalid/Chathub"),
        "https://chathub.invalid/UploadFile",
    );
});

Deno.test("uploadImages posts a form-encoded FileBase64 and maps docId to an annotation", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init: init! };
        return Promise.resolve(
            new Response(
                JSON.stringify({
                    docId: "doc-123",
                    fileName: "pic.jpg",
                    fileType: ".jpeg",
                    result: { value: "Success" },
                }),
                { status: 200 },
            ),
        );
    }) as typeof fetch;
    const annotations = await uploadImages(
        fetchImpl,
        {
            accessToken: "tok",
            conversationId: "conv-1",
            endpoint: "wss://chathub.invalid/Chathub",
        },
        [{ mediaType: "image/jpeg", data: new Uint8Array([1, 2, 3]) }],
        new AbortController().signal,
    );
    assertEquals(captured!.url, "https://chathub.invalid/UploadFile");
    assertEquals(captured!.init.method, "POST");
    const headers = new Headers(captured!.init.headers);
    assertEquals(
        headers.get("X-Variants"),
        "feature.EnableImageSupportInUploadFile",
    );
    assertEquals(headers.get("Authorization"), "Bearer tok");
    const form = new URLSearchParams(captured!.init.body as string);
    assertEquals(form.get("scenario"), "UploadImage");
    assertEquals(form.get("conversationId"), "conv-1");
    assertEquals(
        form.get("FileBase64"),
        `data:image/jpeg;base64,${bytesToBase64(new Uint8Array([1, 2, 3]))}`,
    );
    assertEquals(form.getAll("optionsSets"), [
        "cwcgptvsan",
        "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
    ]);
    assertEquals(annotations, [{
        id: "doc-123",
        messageAnnotationMetadata: {
            "@type": "File",
            annotationType: "File",
            fileType: "jpg",
            fileName: "pic.jpg",
        },
        messageAnnotationType: "ImageFile",
    }]);
});

Deno.test("uploadImages throws when the upload is rejected", async () => {
    const fetchImpl = (() =>
        Promise.resolve(
            new Response("nope", { status: 400 }),
        )) as typeof fetch;
    await assertRejects(
        () =>
            uploadImages(
                fetchImpl,
                { accessToken: "t", conversationId: "c" },
                [{ mediaType: "image/png", data: new Uint8Array([1]) }],
                new AbortController().signal,
            ),
        Error,
        "image upload failed",
    );
});

Deno.test("ChatHub uploads a turn's images and references them on the chat frame", async () => {
    const sends: string[] = [];
    let uploadCalls = 0;
    class CapturingSocket extends EventTarget implements WebSocketLike {
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
        send(data: string): void {
            sends.push(data);
            const reply = ++this.#sends === 1
                ? encodeRecord({})
                : encodeRecord({
                    type: 2,
                    item: { messages: [{ author: "bot", text: "看到了" }] },
                }) + encodeRecord({ type: 3 });
            queueMicrotask(() => {
                if (this.readyState !== 1) return;
                this.dispatchEvent(
                    new MessageEvent("message", { data: reply }),
                );
            });
        }
        close(): void {
            this.readyState = 3;
        }
    }
    const fetchImpl = ((url: string | URL | Request) => {
        uploadCalls++;
        assertStringIncludes(String(url), "/UploadFile");
        return Promise.resolve(
            new Response(
                JSON.stringify({
                    docId: "doc-xyz",
                    fileName: "pic.png",
                    fileType: "png",
                    result: { value: "Success" },
                }),
                { status: 200 },
            ),
        );
    }) as typeof fetch;
    const source = createChatHubSource(config, {
        fetch: fetchImpl,
        webSocketFactory: () => new CapturingSocket(),
    });
    const request: OperationRequest<GenerationRequest> = {
        version: 1,
        requestId: "chathub-image-test",
        operation: "generation.create",
        traits: {},
        payload: {
            model: "test-model",
            messages: [{
                id: "u1",
                role: "user",
                parts: [
                    { id: "t", type: "text", text: "这是什么" },
                    {
                        id: "i",
                        type: "image",
                        source: {
                            mediaType: "image/png",
                            data: new Uint8Array([1, 2, 3]),
                        },
                    },
                ],
            }],
        },
    };
    const events = await run(source, request);
    assertEquals(events.at(-1)?.kind, "run.completed");
    assertEquals(uploadCalls, 1);
    // The second websocket send is the chat frame; it must carry the uploaded
    // document as an ImageFile annotation.
    const chatSend = sends[1]!;
    assertStringIncludes(chatSend, "doc-xyz");
    assertStringIncludes(chatSend, "ImageFile");
    assert(events.some((event) => event.kind === "run.started"));
});

Deno.test("ChatHub surfaces reasoning, search activity and citations as parts", async () => {
    class ScriptedSocket extends EventTarget implements WebSocketLike {
        readyState = 0;
        #sends = 0;
        constructor() {
            super();
            queueMicrotask(() => {
                this.readyState = 1;
                this.dispatchEvent(new Event("open"));
            });
        }
        send(): void {
            const reply = ++this.#sends === 1 ? encodeRecord({}) : (
                encodeRecord({
                    type: 2,
                    item: {
                        messages: [
                            {
                                author: "bot",
                                contentOrigin: "ChainOfThoughtSummary",
                                text: "先查一下北京的天气。",
                            },
                            {
                                author: "bot",
                                messageType: "Progress",
                                searchQueries: ["北京 天气"],
                            },
                            { author: "bot", text: "北京今天晴。" },
                        ],
                        references: [
                            {
                                id: "r1",
                                title: "天气来源",
                                url: "https://ref.example/a",
                            },
                        ],
                    },
                }) + encodeRecord({ type: 3 })
            );
            queueMicrotask(() => {
                if (this.readyState !== 1) return;
                this.dispatchEvent(
                    new MessageEvent("message", { data: reply }),
                );
            });
        }
        close(): void {
            this.readyState = 3;
        }
    }
    const source = createChatHubSource(config, {
        webSocketFactory: () => new ScriptedSocket(),
    });
    const request: OperationRequest<GenerationRequest> = {
        version: 1,
        requestId: "chathub-activity-test",
        operation: "generation.create",
        traits: {},
        payload: {
            model: "test-model",
            messages: [{
                id: "u1",
                role: "user",
                parts: [{ id: "t", type: "text", text: "北京天气如何" }],
            }],
        },
    };
    const events = await run(source, request);
    assertEquals(events.at(-1)?.kind, "run.completed");

    const status = events.find((event) =>
        event.kind === "part.started" && event.part.type === "custom" &&
        event.part.name === "status"
    );
    assert(status, "expected a status custom part");
    if (status?.kind === "part.started" && status.part.type === "custom") {
        assertStringIncludes(
            (status.part.value as { summary: string }).summary,
            "北京 天气",
        );
    }

    const reasoning = events.find((event) =>
        event.kind === "part.started" && event.part.type === "reasoning"
    );
    assert(reasoning, "expected a reasoning part");
    if (
        reasoning?.kind === "part.started" &&
        reasoning.part.type === "reasoning"
    ) {
        assertEquals(reasoning.part.visibility, "public");
    }

    const citation = events.find((event) =>
        event.kind === "part.started" && event.part.type === "citation"
    );
    assert(citation, "expected a citation part");
    if (
        citation?.kind === "part.started" && citation.part.type === "citation"
    ) {
        assertEquals(citation.part.url, "https://ref.example/a");
        assertEquals(citation.part.label, "天气来源");
    }

    // The answer text never carries the reasoning or the search query.
    const answer = events
        .filter((event) =>
            event.kind === "part.delta" &&
            typeof event.delta === "string" &&
            events.some((started) =>
                started.kind === "part.started" &&
                started.part.type === "text" &&
                started.messageId === event.messageId &&
                started.part.id === event.partId
            )
        )
        .map((event) => (event as { delta: string }).delta)
        .join("");
    assertStringIncludes(answer, "北京今天晴");
    assert(!answer.includes("先查一下"), "reasoning leaked into the answer");
});

Deno.test("ChatHub resumes a truncated turn via AttachToSession without re-streaming delivered text", async () => {
    // A long/reasoning turn is truncated by Copilot before the type:3
    // Completion: the first socket streams a partial snapshot then drops; the
    // client must re-attach and finish the same turn, streaming only the tail.
    let sockets = 0;
    class ResumingSocket extends EventTarget implements WebSocketLike {
        readyState = 0;
        #sends = 0;
        readonly #which: number;
        constructor(which: number) {
            super();
            this.#which = which;
            queueMicrotask(() => {
                this.readyState = 1;
                this.dispatchEvent(new Event("open"));
            });
        }
        #emit(data: string): void {
            queueMicrotask(() => {
                if (this.readyState !== 1) return;
                this.dispatchEvent(new MessageEvent("message", { data }));
            });
        }
        send(): void {
            if (++this.#sends === 1) {
                this.#emit(encodeRecord({}));
                return;
            }
            if (this.#which === 0) {
                // First turn: a partial snapshot, then a mid-stream drop with no
                // Completion. setTimeout lets the partial finish publishing (so
                // the resume gate sees streamed content) before the close lands.
                this.#emit(
                    encodeRecord({
                        type: 2,
                        item: {
                            messages: [{ author: "bot", text: "北京今天" }],
                        },
                    }),
                );
                setTimeout(() => {
                    this.readyState = 3;
                    this.dispatchEvent(
                        new CloseEvent("close", { code: 1006 }),
                    );
                }, 0);
                return;
            }
            // Resumed turn: the full snapshot (a superset of the partial) plus
            // the Completion. The prefix-monotonic accumulator streams only "晴。".
            this.#emit(
                encodeRecord({
                    type: 2,
                    item: {
                        messages: [{ author: "bot", text: "北京今天晴。" }],
                    },
                }) + encodeRecord({ type: 3 }),
            );
        }
        close(): void {
            this.readyState = 3;
        }
    }
    const source = createChatHubSource(config, {
        webSocketFactory: () => new ResumingSocket(sockets++),
    });
    const request: OperationRequest<GenerationRequest> = {
        version: 1,
        requestId: "chathub-resume-test",
        operation: "generation.create",
        traits: {},
        payload: {
            model: "test-model",
            messages: [{
                id: "u1",
                role: "user",
                parts: [{ id: "t", type: "text", text: "北京天气如何" }],
            }],
        },
    };
    const events = await run(source, request);
    assertEquals(events.at(-1)?.kind, "run.completed");
    assert(sockets >= 2, "expected an AttachToSession resume socket");
    const answer = events
        .filter((event) =>
            event.kind === "part.delta" &&
            typeof event.delta === "string" &&
            events.some((started) =>
                started.kind === "part.started" &&
                started.part.type === "text" &&
                started.messageId === event.messageId &&
                started.part.id === event.partId
            )
        )
        .map((event) => (event as { delta: string }).delta)
        .join("");
    // The full answer arrives exactly once — the partial is not double-written.
    assertEquals(answer, "北京今天晴。");
});

Deno.test("ChatHub keeps account quota in its own public UI snapshot", async () => {
    class ScriptedSocket extends EventTarget implements WebSocketLike {
        readyState = 0;
        #sends = 0;
        constructor() {
            super();
            queueMicrotask(() => {
                this.readyState = 1;
                this.dispatchEvent(new Event("open"));
            });
        }
        send(): void {
            const reply = ++this.#sends === 1 ? encodeRecord({}) : (
                encodeRecord({
                    type: 2,
                    item: {
                        messages: [{ author: "bot", text: "你好。" }],
                        throttling: {
                            maxNumUserMessagesInConversation: 600,
                            numUserMessagesInConversation: 1,
                            metering: {
                                LLMOnly: { remainingAllowance: 100 },
                                ImageGeneration: { remainingAllowance: 0 },
                                CodeInterpreter: { remainingAllowance: 0 },
                            },
                        },
                        result: { value: "Success" },
                        turnState: "Completed",
                    },
                }) + encodeRecord({ type: 3 })
            );
            queueMicrotask(() => {
                if (this.readyState !== 1) return;
                this.dispatchEvent(
                    new MessageEvent("message", { data: reply }),
                );
            });
        }
        close(): void {
            this.readyState = 3;
        }
    }
    const source = createChatHubSource(config, {
        webSocketFactory: () => new ScriptedSocket(),
    });
    assertEquals(
        (source.uiSnapshot().account as Record<string, unknown>).meters,
        [],
    );
    const events = await run(source, {
        version: 1,
        requestId: "chathub-quota-test",
        operation: "generation.create",
        traits: {},
        payload: {
            model: "test-model",
            messages: [{
                id: "u1",
                role: "user",
                parts: [{ id: "t", type: "text", text: "你好" }],
            }],
        },
    });
    assertEquals(events.at(-1)?.kind, "run.completed");
    const usage = events.find((event) => event.kind === "usage");
    assert(usage && usage.kind === "usage", "expected a usage event");
    assertEquals(usage.usage.extensions, { estimated: true });
    const account = source.uiSnapshot().account as Record<string, unknown>;
    assertEquals(account.meters, [
        { name: "LLMOnly", remaining: 100 },
        { name: "ImageGeneration", remaining: 0, blocked: true },
    ]);
    assertEquals(typeof account.updatedAt, "string");
    assert(!JSON.stringify(source.uiSnapshot()).includes(config.accessToken));
    (account.meters as unknown[]).length = 0;
    assertEquals(
        (source.uiSnapshot().account as { meters: unknown[] }).meters.length,
        2,
    );
});

Deno.test("ChatHub reports a metering soft-reject as an error, not a blank reply", async () => {
    class ScriptedSocket extends EventTarget implements WebSocketLike {
        readyState = 0;
        #sends = 0;
        constructor() {
            super();
            queueMicrotask(() => {
                this.readyState = 1;
                this.dispatchEvent(new Event("open"));
            });
        }
        send(): void {
            // A soft-reject: HTTP/WS stay 200 and value is "Success", but the
            // turn produced no message and a meteringInformation entry denies it.
            const reply = ++this.#sends === 1 ? encodeRecord({}) : (
                encodeRecord({
                    type: 2,
                    item: {
                        messages: [],
                        result: {
                            value: "Success",
                            meteringInformation: [{
                                meterError:
                                    "ImageGenInsufficientTokensThrottled",
                                hasAccess: false,
                            }],
                        },
                        turnState: "Completed",
                    },
                }) + encodeRecord({ type: 3 })
            );
            queueMicrotask(() => {
                if (this.readyState !== 1) return;
                this.dispatchEvent(
                    new MessageEvent("message", { data: reply }),
                );
            });
        }
        close(): void {
            this.readyState = 3;
        }
    }
    const source = createChatHubSource(config, {
        webSocketFactory: () => new ScriptedSocket(),
    });
    const events = await run(source, {
        version: 1,
        requestId: "chathub-softreject-test",
        operation: "generation.create",
        traits: {},
        payload: {
            model: "test-model",
            messages: [{
                id: "u1",
                role: "user",
                parts: [{ id: "t", type: "text", text: "画一只猫" }],
            }],
        },
    });
    const error = events.find((event) => event.kind === "run.error");
    assert(error && error.kind === "run.error", "expected a run.error");
    assertStringIncludes(
        error.error.message,
        "ImageGenInsufficientTokensThrottled",
    );
    assert(
        !events.some((event) => event.kind === "run.completed"),
        "a soft-reject must not complete as a blank reply",
    );
});

Deno.test("only cited references surface, resolved by marker in text order", async () => {
    class CitingSocket extends EventTarget implements WebSocketLike {
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
            const reply = ++this.#sends === 1
                ? encodeRecord({})
                : encodeRecord({
                    type: 2,
                    item: {
                        // Cites search2 then search1; search9 is never referenced.
                        messages: [{
                            author: "bot",
                            text:
                                "先看\u{e200}cite\u{e202}turn1search2\u{e201}再看\u{e200}cite\u{e202}turn1search1\u{e201}",
                        }],
                        references: {
                            turn1search1: {
                                targetLink: "https://ref.example/1",
                                title: "来源一",
                            },
                            turn1search2: {
                                url: "https://ref.example/2",
                                title: "来源二",
                            },
                            turn1search9: {
                                url: "https://ref.example/9",
                                title: "未引用",
                            },
                        },
                    },
                }) + encodeRecord({ type: 3 });
            queueMicrotask(() => {
                if (this.readyState !== 1) return;
                this.dispatchEvent(
                    new MessageEvent("message", { data: reply }),
                );
            });
        }
        close(): void {
            this.readyState = 3;
        }
    }
    const source = createChatHubSource(config, {
        webSocketFactory: () => new CitingSocket(),
    });
    const request: OperationRequest<GenerationRequest> = {
        version: 1,
        requestId: "cite-order",
        operation: "generation.create",
        traits: {},
        payload: {
            model: "test-model",
            messages: [{
                id: "u1",
                role: "user",
                parts: [{ id: "t1", type: "text", text: "hi" }],
            }],
        },
    };
    const events = await run(source, request);
    const citations = events.flatMap((event) =>
        event.kind === "part.started" && event.part.type === "citation"
            ? [event.part]
            : []
    );
    // Only the two cited references, in the order their markers appear; the
    // uncited turn1search9 never surfaces.
    assertEquals(citations.length, 2);
    assertEquals(citations[0]?.url, "https://ref.example/2");
    assertEquals(citations[1]?.url, "https://ref.example/1");
});
