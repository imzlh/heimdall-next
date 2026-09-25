import { type OperationRequest, type StreamFrame } from "@heimdall/contracts";
import {
    applyFrame,
    type ConversationState,
    initialState,
} from "@heimdall/hip";
import { ProtocolError, type RequestContext } from "@heimdall/contracts";
import {
    enqueueSse,
    generationPayload,
    isTerminalStatus,
    openAIStreamError,
} from "./wire.ts";
import {
    buildChatResponse,
    buildResponsesResponse,
    materialize,
    openAIErrorResponse,
} from "./response.ts";
import {
    chatStreamEvents,
    createResponsesTracker,
    responsesStreamEvents,
} from "./stream.ts";
import { dialectForRoute, isGenerationDialect } from "./contract.ts";
import { serializeSimpleOpenAIResponse } from "./response/simple.ts";

/** Serialize HIP events into the OpenAI chat or responses wire dialect. */
export function serializeOpenAIResponse(
    context: RequestContext,
    input: OperationRequest,
    events: AsyncIterable<StreamFrame>,
): Promise<Response> {
    if (!isGenerationDialect(dialectForRoute(context.route))) {
        return serializeSimpleOpenAIResponse(input, events);
    }
    const request = generationPayload(input);
    if (request.stream === true) {
        return Promise.resolve(serializeOpenAIStream(context, input, events));
    }
    return serializeOpenAIJson(context, input, events);
}

async function serializeOpenAIJson(
    context: RequestContext,
    input: OperationRequest,
    events: AsyncIterable<StreamFrame>,
): Promise<Response> {
    try {
        const materialized = await materialize(events, input.requestId);
        if (materialized.state?.error) {
            return openAIErrorResponse(materialized.state.error);
        }
        if (materialized.state?.status === "cancelled") {
            return openAIErrorResponse({
                code: "request_cancelled",
                message: "request was cancelled",
                status: 499,
            });
        }
        if (dialectForRoute(context.route) === "responses") {
            return Response.json(buildResponsesResponse(
                generationPayload(input),
                materialized.state,
                materialized.id,
                materialized.createdAt,
            ));
        }
        return Response.json(buildChatResponse(
            generationPayload(input),
            materialized.state,
            materialized.id,
            materialized.createdAt,
        ));
    } catch (error) {
        if (error instanceof ProtocolError) {
            return openAIErrorResponse({
                code: error.code,
                message: error.message,
                status: error.status,
            });
        }
        throw error;
    }
}

function serializeOpenAIStream(
    context: RequestContext,
    input: OperationRequest,
    events: AsyncIterable<StreamFrame>,
): Response {
    const encoder = new TextEncoder();
    const isResponses = dialectForRoute(context.route) === "responses";
    const responsesTracker = createResponsesTracker();
    const body = new ReadableStream<Uint8Array>({
        async start(controller) {
            let state: ConversationState | undefined;
            try {
                for await (const frame of events) {
                    const previous = state;
                    state ??= initialState(frame.streamId, frame.requestId);
                    state = applyFrame(state, frame);
                    if (state === previous) continue;

                    if (isResponses) {
                        for (
                            const output of responsesStreamEvents(
                                frame,
                                state,
                                generationPayload(input),
                                responsesTracker,
                            )
                        ) {
                            enqueueSse(
                                controller,
                                encoder,
                                output.data,
                                output.event,
                            );
                        }
                    } else {
                        for (
                            const output of chatStreamEvents(
                                frame,
                                state,
                                generationPayload(input),
                            )
                        ) {
                            enqueueSse(controller, encoder, output);
                        }
                    }
                }
                if (!state || !isTerminalStatus(state.status)) {
                    throw new ProtocolError(
                        502,
                        "source stream ended without a terminal event",
                        "stream_incomplete",
                    );
                }
                if (!isResponses && state.status === "completed") {
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                }
            } catch (error) {
                const streamError = openAIStreamError(error);
                if (isResponses) {
                    enqueueSse(controller, encoder, {
                        type: "error",
                        code: streamError.code,
                        message: streamError.message,
                        param: null,
                    }, "error");
                } else {
                    enqueueSse(controller, encoder, {
                        error: {
                            message: streamError.message,
                            type: streamError.type,
                            code: streamError.code,
                        },
                    });
                }
            } finally {
                controller.close();
            }
        },
    });
    return new Response(body, {
        headers: {
            "cache-control": "no-cache",
            "content-type": "text/event-stream; charset=utf-8",
        },
    });
}
