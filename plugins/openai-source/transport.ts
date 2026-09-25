import type {
    InferenceSource,
    OperationRequest,
    SourceCapability,
    SourceProbeResult,
    StreamEvent,
    StreamFrame,
} from "@heimdall/contracts";
import {
    advertisedCapabilities,
    type OpenAICompatibleSourceConfig,
    type OpenAICompatibleSourceOptions,
    upstreamHeaders,
    upstreamUrl,
    validateOpenAICompatibleSourceConfig,
} from "./config.ts";
import {
    isAbortError,
    OpenAIUpstreamError,
    parseJsonResponse,
    responseError,
    transportError,
} from "./errors.ts";
import { generationPayload, toWireRequest } from "./request.ts";
import { executePassthrough } from "./operations.ts";
import { jsonEvents } from "./response.ts";
import { streamResponse } from "./stream.ts";
import type { SourceContext } from "./types.ts";

/** Source plugin that speaks the OpenAI Chat Completions upstream dialect. */
export class OpenAICompatibleSource implements InferenceSource {
    readonly id: string;
    readonly capabilities: readonly SourceCapability[];
    readonly config: OpenAICompatibleSourceConfig;
    readonly #fetch: NonNullable<OpenAICompatibleSourceOptions["fetch"]>;
    readonly #now: () => Date;
    readonly #streamId: (requestId: string) => string;

    constructor(
        config: OpenAICompatibleSourceConfig,
        options: OpenAICompatibleSourceOptions = {},
    ) {
        this.config = validateOpenAICompatibleSourceConfig(config);
        this.id = this.config.id ?? "openai-compatible";
        this.capabilities = advertisedCapabilities(this.config);
        this.#fetch = options.fetch ?? fetch;
        this.#now = options.now ?? (() => new Date());
        this.#streamId = options.streamId ??
            ((requestId) => `openai:${requestId}:${crypto.randomUUID()}`);
    }

    async probe(signal: AbortSignal): Promise<SourceProbeResult> {
        try {
            const headers = new Headers(this.config.headers);
            headers.set("accept", "application/json");
            if (this.config.apiKey !== undefined) {
                headers.set("authorization", `Bearer ${this.config.apiKey}`);
            }
            const response = await this.#fetch(
                `${this.config.baseUrl}/models`,
                {
                    method: "GET",
                    headers,
                    redirect: "error",
                    signal,
                },
            );
            if (response.ok) {
                const models = await readModelIds(response, this.config.apiKey);
                return {
                    ok: true,
                    message: "models endpoint reachable",
                    ...(models.length === 0 ? {} : { models }),
                };
            }
            return {
                ok: false,
                message: `models probe failed with status ${response.status}`,
            };
        } catch (error) {
            const raw = error instanceof Error ? error.message : String(error);
            const secret = this.config.apiKey;
            return {
                ok: false,
                message: secret === undefined
                    ? raw
                    : raw.replaceAll(secret, "[redacted]"),
            };
        }
    }

    execute(
        input: OperationRequest,
        context: SourceContext,
    ): AsyncIterable<StreamFrame> {
        return this.#execute(input, context);
    }

    async *#execute(
        input: OperationRequest,
        context: SourceContext,
    ): AsyncIterable<StreamFrame> {
        const streamId = this.#streamId(input.requestId);
        const emit = frameFactory(streamId, input.requestId, this.#now);
        yield emit({ kind: "run.started", request: input });

        try {
            if (input.operation !== "generation.create") {
                const outcome = yield* executePassthrough(
                    input,
                    this.config,
                    this.#fetch,
                    emit,
                    context.signal,
                );
                if (outcome === "cancelled") return;
            } else {
                const request = generationPayload(input);
                const response = await this.#fetch(upstreamUrl(this.config), {
                    method: "POST",
                    headers: upstreamHeaders(
                        this.config,
                        request.stream === true,
                    ),
                    body: JSON.stringify(toWireRequest(request, this.config)),
                    signal: context.signal,
                    redirect: "error",
                });
                if (!response.ok) {
                    throw new OpenAIUpstreamError(
                        await responseError(response),
                    );
                }
                if (context.signal.aborted) {
                    yield emit({
                        kind: "run.cancelled",
                        reason: "request aborted",
                    });
                    return;
                }

                const messageId = `${streamId}:message:0`;
                yield emit({
                    kind: "message.started",
                    message: {
                        id: messageId,
                        role: "assistant",
                        parts: [],
                        status: "in_progress",
                    },
                });
                const contentType = response.headers.get("content-type")
                    ?.toLowerCase() ?? "";
                if (contentType.includes("text/event-stream")) {
                    const result = yield* streamResponse(
                        response,
                        emit,
                        messageId,
                        context.signal,
                    );
                    if (result === "cancelled") return;
                } else {
                    const body = await parseJsonResponse(response);
                    for (const event of jsonEvents(body, messageId)) {
                        yield emit(event);
                    }
                }
            }
        } catch (error) {
            if (isAbortError(error) || context.signal.aborted) {
                yield emit({
                    kind: "run.cancelled",
                    reason: "request aborted",
                });
                return;
            }
            const canonical = error instanceof OpenAIUpstreamError
                ? error.error
                : transportError(error);
            yield emit({ kind: "run.error", error: canonical });
            return;
        }
        yield emit({ kind: "run.completed" });
    }
}

function frameFactory(
    streamId: string,
    requestId: string,
    now: () => Date,
): (event: StreamEvent) => StreamFrame {
    let seq = 0;
    return (event) => {
        const current = ++seq;
        return {
            version: 1,
            streamId,
            requestId,
            seq: current,
            eventId: `${streamId}:${current}`,
            timestamp: now().toISOString(),
            event,
        };
    };
}

export function createOpenAICompatibleSource(
    config: OpenAICompatibleSourceConfig,
    options: OpenAICompatibleSourceOptions = {},
): OpenAICompatibleSource {
    return new OpenAICompatibleSource(config, options);
}

async function readModelIds(
    response: Response,
    apiKey: string | undefined,
): Promise<readonly string[]> {
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        return [];
    }
    if (!isRecord(body) || !Array.isArray(body.data)) return [];
    const ids: string[] = [];
    for (const item of body.data) {
        if (!isRecord(item) || typeof item.id !== "string") continue;
        const id = item.id.trim();
        if (id.length === 0 || id.length > 200) continue;
        if (apiKey !== undefined && id.includes(apiKey)) continue;
        ids.push(id);
        if (ids.length === 500) break;
    }
    return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
