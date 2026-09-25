import type {
    JsonValue,
    OperationRequest,
    StreamFrame,
} from "@heimdall/contracts";
import { ProtocolError } from "@heimdall/contracts";
import { openAIErrorResponse } from "../response.ts";
import { openAIStreamError } from "../wire.ts";

/**
 * Serialize HIP frames for completions, embeddings, and images.
 *
 * Non-stream responses return the upstream JSON object carried in one
 * `openai.wire` event. Completion streams replay `openai.sse` chunks and emit
 * `[DONE]` only when the upstream sent it.
 */
export function serializeSimpleOpenAIResponse(
    input: OperationRequest,
    events: AsyncIterable<StreamFrame>,
): Promise<Response> {
    if (input.traits.streaming === true) {
        return Promise.resolve(serializeCompletionStream(events));
    }
    return serializeWireJson(events);
}

async function serializeWireJson(
    events: AsyncIterable<StreamFrame>,
): Promise<Response> {
    let wire: JsonValue | undefined;
    for await (const frame of events) {
        const event = frame.event;
        if (event.kind === "run.error") return openAIErrorResponse(event.error);
        if (event.kind === "run.cancelled") {
            return openAIErrorResponse({
                code: "request_cancelled",
                message: "request was cancelled",
                status: 499,
            });
        }
        if (event.kind === "custom" && event.name === "openai.wire") {
            wire = event.value;
        }
    }
    if (wire === undefined) {
        throw new ProtocolError(
            502,
            "source stream ended without a wire result",
            "stream_incomplete",
        );
    }
    return Response.json(restoreImageBytes(wire));
}

function serializeCompletionStream(
    events: AsyncIterable<StreamFrame>,
): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for await (const frame of events) {
                    const event = frame.event;
                    if (
                        event.kind === "custom" && event.name === "openai.sse"
                    ) {
                        controller.enqueue(encoder.encode(
                            `data: ${JSON.stringify(event.value ?? null)}\n\n`,
                        ));
                    } else if (
                        event.kind === "custom" &&
                        event.name === "openai.sse.done"
                    ) {
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    } else if (event.kind === "run.error") {
                        const streamError = openAIStreamError(event.error);
                        controller.enqueue(encoder.encode(
                            `data: ${
                                JSON.stringify({
                                    error: {
                                        message: streamError.message,
                                        type: streamError.type,
                                        code: streamError.code,
                                    },
                                })
                            }\n\n`,
                        ));
                        return;
                    }
                }
            } catch (error) {
                const streamError = openAIStreamError(error);
                controller.enqueue(encoder.encode(
                    `data: ${
                        JSON.stringify({
                            error: {
                                message: streamError.message,
                                type: streamError.type,
                                code: streamError.code,
                            },
                        })
                    }\n\n`,
                ));
            } finally {
                controller.close();
            }
        },
    });
    return new Response(body, {
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
        },
    });
}

function restoreImageBytes(value: JsonValue): JsonValue {
    if (!isRecord(value) || !Array.isArray(value.data)) return value;
    const data = value.data.map((item) => {
        if (!isRecord(item) || typeof item.dataBase64 !== "string") return item;
        const next: Record<string, JsonValue> = {};
        for (const [key, entry] of Object.entries(item)) {
            if (key !== "dataBase64") next[key] = entry;
        }
        next.b64_json = item.dataBase64;
        return next;
    });
    return { ...value, data };
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
