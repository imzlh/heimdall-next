import { type JsonObject, ProtocolError } from "@heimdall/contracts";
import { asObject, isObject } from "../wire.ts";

export async function parseJsonBody(request: Request): Promise<JsonObject> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        throw new ProtocolError(400, "request body must be valid JSON");
    }
    if (!isObject(body)) {
        throw new ProtocolError(400, "request body must be an object");
    }
    return body as JsonObject;
}

/** Reject values that the OpenAI wire schema would reject instead of
 * silently turning them into a different HIP request. */
export function validateRequestTypes(
    body: JsonObject,
    isResponses: boolean,
): void {
    if (body.stream !== undefined && typeof body.stream !== "boolean") {
        throw new ProtocolError(400, "stream must be a boolean");
    }
    const numericFields = [
        "temperature",
        "top_p",
        "presence_penalty",
        "frequency_penalty",
        "seed",
        "n",
        "max_tokens",
        "max_completion_tokens",
        "max_output_tokens",
    ];
    for (const field of numericFields) {
        const value = body[field];
        if (
            value !== undefined &&
            (typeof value !== "number" || !Number.isFinite(value))
        ) {
            throw new ProtocolError(400, `${field} must be a finite number`);
        }
    }
    for (
        const field of [
            "max_tokens",
            "max_completion_tokens",
            "max_output_tokens",
        ]
    ) {
        const value = body[field];
        if (
            value !== undefined &&
            (!Number.isInteger(value as number) || (value as number) <= 0)
        ) {
            throw new ProtocolError(400, `${field} must be a positive integer`);
        }
    }
    if (
        body.n !== undefined &&
        (!Number.isInteger(body.n as number) || (body.n as number) <= 0)
    ) {
        throw new ProtocolError(400, "n must be a positive integer");
    }
    if (body.logprobs !== undefined && typeof body.logprobs !== "boolean") {
        throw new ProtocolError(400, "logprobs must be a boolean");
    }
    if (
        body.top_logprobs !== undefined &&
        (typeof body.top_logprobs !== "number" ||
            !Number.isInteger(body.top_logprobs) || body.top_logprobs < 0)
    ) {
        throw new ProtocolError(
            400,
            "top_logprobs must be a non-negative integer",
        );
    }
    if (body.stream_options !== undefined) {
        const streamOptions = asObject(body.stream_options);
        if (!streamOptions) {
            throw new ProtocolError(400, "stream_options must be an object");
        }
        if (
            streamOptions.include_usage !== undefined &&
            typeof streamOptions.include_usage !== "boolean"
        ) {
            throw new ProtocolError(
                400,
                "stream_options.include_usage must be a boolean",
            );
        }
    }
    if (isResponses && body.text !== undefined && !asObject(body.text)) {
        throw new ProtocolError(400, "text must be an object");
    }
}
