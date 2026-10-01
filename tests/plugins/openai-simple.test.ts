import { assertEquals } from "@std/assert";
import type {
    InferenceSource,
    OperationRequest,
    StreamEvent,
    StreamFrame,
} from "@heimdall/contracts";
import { createServer } from "../../main.ts";
import openAIProtocol from "../../plugins/openai-protocol/mod.ts";
import { createOpenAICompatibleSource } from "../../plugins/openai-source/mod.ts";

function frames(
    requestId: string,
    events: readonly StreamEvent[],
): AsyncIterable<StreamFrame> {
    return (async function* () {
        for (let index = 0; index < events.length; index++) {
            yield {
                version: 1,
                streamId: "fixture-stream",
                requestId,
                seq: index + 1,
                eventId: `fixture-${index + 1}`,
                timestamp: "2026-09-22T00:00:00.000Z",
                event: events[index]!,
            };
        }
    })();
}

function sourceFor(
    operation: string,
    events: readonly StreamEvent[],
    seen: OperationRequest[],
): InferenceSource {
    return {
        id: `fixture.${operation}`,
        capabilities: [{
            operation,
            models: ["fixture-model"],
            streaming: operation === "completion.create",
        }],
        execute(input) {
            seen.push(input);
            return frames(input.requestId, [
                { kind: "run.started", request: input },
                ...events,
                { kind: "run.completed" },
            ]);
        },
    };
}

Deno.test("OpenAI completions and embeddings round trip through HIP", async () => {
    const seen: OperationRequest[] = [];
    const app = createServer({
        protocols: [openAIProtocol],
        sources: [
            sourceFor("completion.create", [{
                kind: "custom",
                name: "openai.wire",
                value: {
                    id: "cmpl-1",
                    choices: [{
                        text: "hello",
                        index: 0,
                        finish_reason: "stop",
                    }],
                },
            }, {
                kind: "usage",
                usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
            }], seen),
            sourceFor("embedding.create", [{
                kind: "custom",
                name: "openai.wire",
                value: {
                    object: "list",
                    data: [{ object: "embedding", index: 0, embedding: [0.5] }],
                    model: "fixture-model",
                },
            }], seen),
        ],
    });

    const completion = await app.fetch(
        new Request("http://localhost/v1/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: "fixture-model",
                prompt: "hi",
                apiKey: "nope",
            }),
        }),
    );
    assertEquals(completion.status, 400);

    const ok = await app.fetch(
        new Request("http://localhost/v1/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "fixture-model", prompt: "hi" }),
        }),
    );
    assertEquals(ok.status, 200);
    const completionBody = await ok.json();
    assertEquals(completionBody.choices[0].text, "hello");
    assertEquals(seen[0]?.operation, "completion.create");
    assertEquals(seen[0]?.traits.model, "fixture-model");

    const embeddings = await app.fetch(
        new Request("http://localhost/v1/embeddings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "fixture-model", input: "hi" }),
        }),
    );
    assertEquals(embeddings.status, 200);
    assertEquals((await embeddings.json()).data[0].embedding, [0.5]);
    assertEquals(seen[1]?.operation, "embedding.create");
});

Deno.test("OpenAI image routes keep bytes out of the wire field name", async () => {
    const seen: OperationRequest[] = [];
    const app = createServer({
        protocols: [openAIProtocol],
        sources: [
            sourceFor("image.generate", [{
                kind: "custom",
                name: "openai.wire",
                value: { created: 1, data: [{ dataBase64: "aGVsbG8=" }] },
            }], seen),
            sourceFor("image.edit", [{
                kind: "custom",
                name: "openai.wire",
                value: { created: 2, data: [{ dataBase64: "aGVsbG8=" }] },
            }], seen),
        ],
    });
    const generated = await app.fetch(
        new Request("http://localhost/v1/images/generations", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "fixture-model", prompt: "cat" }),
        }),
    );
    assertEquals((await generated.json()).data[0].b64_json, "aGVsbG8=");

    const form = new FormData();
    form.set("model", "fixture-model");
    form.set("prompt", "edit");
    form.set(
        "image",
        new File([new Uint8Array([1, 2, 3])], "cat.png", { type: "image/png" }),
    );
    const edited = await app.fetch(
        new Request("http://localhost/v1/images/edits", {
            method: "POST",
            body: form,
        }),
    );
    assertEquals(edited.status, 200);
    assertEquals((await edited.json()).data[0].b64_json, "aGVsbG8=");
    const payload = seen[1]?.payload as {
        value?: { images?: { dataBase64?: string }[] };
    };
    assertEquals(typeof payload.value?.images?.[0]?.dataBase64, "string");
    assertEquals(seen[1]?.operation, "image.edit");
});

Deno.test("OpenAI source posts embeddings and image edits to fixed paths", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const source = createOpenAICompatibleSource({
        baseUrl: "https://upstream.example/v1",
        apiKey: "sk-test",
    }, {
        fetch: (url, init) => {
            calls.push({ url: String(url), init: init ?? {} });
            const embedding = String(url).endsWith("/embeddings");
            return Promise.resolve(
                new Response(
                    JSON.stringify(
                        embedding
                            ? {
                                data: [{ index: 0, embedding: [1] }],
                                usage: { prompt_tokens: 4, total_tokens: 4 },
                            }
                            : { data: [{ b64_json: "aGVsbG8=" }] },
                    ),
                    {
                        headers: { "content-type": "application/json" },
                    },
                ),
            );
        },
    });
    const embeddingEvents = [];
    for await (
        const frame of source.execute({
            version: 1,
            requestId: "embed-1",
            operation: "embedding.create",
            payload: {
                vocabulary: "openai.embedding",
                value: { model: "fixture-model", input: "hi" },
            },
            traits: { model: "mapped-model", streaming: false },
        }, {
            requestId: "embed-1",
            signal: new AbortController().signal,
            metadata: {},
        })
    ) embeddingEvents.push(frame.event.kind);
    assertEquals(calls[0]?.url, "https://upstream.example/v1/embeddings");
    assertEquals(
        JSON.parse(String(calls[0]?.init.body)).model,
        "mapped-model",
    );
    assertEquals(
        new Headers(calls[0]?.init.headers).get("authorization"),
        "Bearer sk-test",
    );
    assertEquals(embeddingEvents.includes("usage"), true);

    const editEvents = [];
    for await (
        const frame of source.execute({
            version: 1,
            requestId: "edit-1",
            operation: "image.edit",
            payload: {
                vocabulary: "openai.image.edit",
                value: {
                    model: "fixture-model",
                    prompt: "draw",
                    images: [{
                        field: "image",
                        filename: "cat.png",
                        mediaType: "image/png",
                        dataBase64: "aGVsbG8=",
                    }],
                },
            },
            traits: { model: "mapped-model", streaming: false },
        }, {
            requestId: "edit-1",
            signal: new AbortController().signal,
            metadata: {},
        })
    ) editEvents.push(frame);
    assertEquals(calls[1]?.url, "https://upstream.example/v1/images/edits");
    const form = calls[1]?.init.body;
    if (!(form instanceof FormData)) throw new Error("expected multipart body");
    assertEquals(form.get("model"), "mapped-model");
    assertEquals(form.get("prompt"), "draw");
    assertEquals(form.get("image") instanceof File, true);
    const wire = editEvents.find((frame) => frame.event.kind === "custom");
    assertEquals(
        wire?.event.kind === "custom" ? wire.event.value : undefined,
        { data: [{ dataBase64: "aGVsbG8=" }] },
    );
});
