import type {
    JsonValue,
    OperationRequest,
    StreamEvent,
    StreamFrame,
} from "@heimdall/contracts";
import {
    type OpenAICompatibleSourceConfig,
    upstreamHeaders,
} from "./config.ts";
import {
    invalidUpstreamResponse,
    OpenAIUpstreamError,
    parseJsonResponse,
    responseError,
} from "./errors.ts";
import { parseUsage } from "./response.ts";
import { readSse } from "./stream.ts";
import {
    type FetchLike,
    type FrameEmitter,
    isJsonValue,
    isRecord,
    SSE_DONE,
    type WireObject,
} from "./types.ts";

const PATHS: Record<string, string> = {
    "completion.create": "/completions",
    "embedding.create": "/embeddings",
    "image.generate": "/images/generations",
    "image.edit": "/images/edits",
};

const VOCABULARY: Record<string, string> = {
    "completion.create": "openai.completion",
    "embedding.create": "openai.embedding",
    "image.generate": "openai.image.generate",
    "image.edit": "openai.image.edit",
};

interface UpstreamCall {
    readonly url: string;
    readonly headers: Headers;
    readonly body: BodyInit;
    readonly stream: boolean;
}

interface BinaryFile {
    readonly field: string;
    readonly filename: string;
    readonly mediaType: string;
    readonly dataBase64: string;
}

/**
 * Execute an OpenAI endpoint that is not Chat Completions.
 *
 * The operation id selects the upstream path. The HIP payload is already
 * validated by the protocol plugin; this module only maps it back to the
 * provider body and the provider JSON back to HIP events.
 */
export async function* executePassthrough(
    input: OperationRequest,
    config: OpenAICompatibleSourceConfig,
    fetchImpl: FetchLike,
    emit: FrameEmitter,
    signal: AbortSignal,
): AsyncGenerator<StreamFrame, "cancelled" | undefined> {
    const call = buildUpstreamCall(input, config);
    const response = await fetchImpl(call.url, {
        method: "POST",
        headers: call.headers,
        body: call.body,
        signal,
        redirect: "error",
    });
    if (!response.ok) {
        throw new OpenAIUpstreamError(await responseError(response));
    }
    if (signal.aborted) {
        yield emit({ kind: "run.cancelled", reason: "request aborted" });
        return "cancelled";
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ??
        "";
    if (call.stream && contentType.includes("text/event-stream")) {
        return yield* completionStream(
            response,
            emit,
            signal,
            publicModel(input),
        );
    }
    const body = await parseJsonResponse(response);
    for (
        const event of passthroughEvents(
            input.operation,
            withPublicModel(body, publicModel(input)),
        )
    ) {
        yield emit(event);
    }
    return undefined;
}

export function buildUpstreamCall(
    input: OperationRequest,
    config: OpenAICompatibleSourceConfig,
): UpstreamCall {
    const path = PATHS[input.operation];
    const vocabulary = VOCABULARY[input.operation];
    if (path === undefined || vocabulary === undefined) {
        throw new OpenAIUpstreamError({
            code: "unsupported_operation",
            message: `OpenAI source cannot execute ${input.operation}`,
            retryable: false,
            status: 400,
        });
    }
    const value = payloadValue(input, vocabulary);
    const url = `${config.baseUrl}${path}`;
    if (input.operation === "image.edit") {
        return {
            url,
            headers: multipartHeaders(config),
            body: imageEditBody(value, input.traits.model),
            stream: false,
        };
    }
    const model = typeof value.model === "string" ? value.model : undefined;
    const body: WireObject = {
        ...value,
        model: input.traits.model ?? model ?? "",
    };
    const stream = input.operation === "completion.create" &&
        value.stream === true;
    return {
        url,
        headers: upstreamHeaders(config, stream),
        body: JSON.stringify(body),
        stream,
    };
}

export function passthroughEvents(
    operation: string,
    body: unknown,
): readonly StreamEvent[] {
    if (!isRecord(body) || !isJsonValue(body)) {
        throw invalidUpstreamResponse(
            "upstream JSON response must be an object",
        );
    }
    const list = operation === "completion.create" ? body.choices : body.data;
    if (!Array.isArray(list)) {
        throw invalidUpstreamResponse(
            operation === "completion.create"
                ? "upstream completion response has no choices"
                : "upstream response has no data",
        );
    }
    const events: StreamEvent[] = [];
    if (isRecord(body.usage)) {
        events.push({ kind: "usage", usage: parseUsage(body.usage) });
    }
    events.push({
        kind: "custom",
        name: "openai.wire",
        value: operation.startsWith("image.") ? hideImageBytes(body) : body,
    });
    return events;
}

async function* completionStream(
    response: Response,
    emit: FrameEmitter,
    signal: AbortSignal,
    model: string | undefined,
): AsyncGenerator<StreamFrame, "cancelled" | undefined> {
    if (response.body === null) {
        throw invalidUpstreamResponse(
            "upstream returned an empty streaming body",
        );
    }
    for await (const item of readSse(response.body)) {
        if (signal.aborted) {
            yield emit({ kind: "run.cancelled", reason: "request aborted" });
            return "cancelled";
        }
        if (item === SSE_DONE) {
            yield emit({
                kind: "custom",
                name: "openai.sse.done",
                value: null,
            });
            return undefined;
        }
        if (isRecord(item) && isRecord(item.error)) {
            throw new OpenAIUpstreamError({
                code: "upstream_error",
                message: typeof item.error.message === "string"
                    ? item.error.message
                    : "upstream stream failed",
                retryable: false,
                status: 502,
            });
        }
        if (!isRecord(item) || !isJsonValue(item)) continue;
        if (isRecord(item.usage)) {
            yield emit({ kind: "usage", usage: parseUsage(item.usage) });
        }
        yield emit({
            kind: "custom",
            name: "openai.sse",
            value: withPublicModel(item, model) as JsonValue,
        });
    }
    return undefined;
}

function payloadValue(
    input: OperationRequest,
    vocabulary: string,
): WireObject {
    const payload = input.payload;
    if (
        !isRecord(payload) || payload.vocabulary !== vocabulary ||
        !isRecord(payload.value)
    ) {
        throw new OpenAIUpstreamError({
            code: "invalid_internal_request",
            message: `${input.operation} payload is not ${vocabulary}`,
            retryable: false,
            status: 500,
        });
    }
    return payload.value;
}

function imageEditBody(
    value: WireObject,
    executionModel: string | undefined,
): FormData {
    const form = new FormData();
    const model = typeof value.model === "string" ? value.model : "";
    form.set("model", executionModel ?? model);
    if (typeof value.prompt === "string") form.set("prompt", value.prompt);
    if (isRecord(value.fields)) {
        for (const [key, field] of Object.entries(value.fields)) {
            if (typeof field === "string") form.set(key, field);
        }
    }
    for (const file of fileList(value.images)) {
        form.append(file.field, blob(file), file.filename);
    }
    const mask = fileRecord(value.mask);
    if (mask !== undefined) form.append(mask.field, blob(mask), mask.filename);
    for (const file of fileList(value.files)) {
        form.append(file.field, blob(file), file.filename);
    }
    return form;
}

/** Provider responses use the public request identity, independent of routing. */
function publicModel(input: OperationRequest): string | undefined {
    const payload = input.payload;
    return "value" in payload && isRecord(payload.value) &&
            typeof payload.value.model === "string"
        ? payload.value.model
        : undefined;
}

function withPublicModel(value: unknown, model: string | undefined): unknown {
    return model !== undefined && isRecord(value) &&
            typeof value.model === "string"
        ? { ...value, model }
        : value;
}

function multipartHeaders(config: OpenAICompatibleSourceConfig): Headers {
    const headers = new Headers(config.headers);
    headers.set("accept", "application/json");
    if (config.apiKey !== undefined) {
        headers.set("authorization", `Bearer ${config.apiKey}`);
    }
    return headers;
}

function hideImageBytes(body: WireObject): JsonValue {
    if (!Array.isArray(body.data)) return body as JsonValue;
    return {
        ...body,
        data: body.data.map((item) => {
            if (!isRecord(item) || typeof item.b64_json !== "string") {
                return item;
            }
            const { b64_json, ...rest } = item;
            return { ...rest, dataBase64: b64_json };
        }),
    } as JsonValue;
}

function fileList(value: unknown): BinaryFile[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        const file = fileRecord(item);
        return file === undefined ? [] : [file];
    });
}

function fileRecord(value: unknown): BinaryFile | undefined {
    if (!isRecord(value) || typeof value.dataBase64 !== "string") {
        return undefined;
    }
    return {
        field: typeof value.field === "string" ? value.field : "image",
        filename: typeof value.filename === "string" ? value.filename : "image",
        mediaType: typeof value.mediaType === "string"
            ? value.mediaType
            : "application/octet-stream",
        dataBase64: value.dataBase64,
    };
}

function blob(file: BinaryFile): Blob {
    return new Blob([decodeBase64(file.dataBase64)], { type: file.mediaType });
}

function decodeBase64(value: string): ArrayBuffer {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return copy;
}
