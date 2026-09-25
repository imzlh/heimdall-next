import {
    type GenerateRequest,
    type OperationRequest,
} from "@heimdall/contracts";
import type { RequestContext } from "@heimdall/contracts";
import {
    asObject,
    compactUndefined,
    inferInputModalities,
    nonEmptyString,
    optionalString,
    parseModalities,
    requiredCapabilities,
    unknownFields,
} from "./wire.ts";
import { dialectForRoute, isGenerationDialect } from "./contract.ts";
import { parseChatMessages, parseResponsesInput } from "./request/messages.ts";
import {
    parseMetadata,
    parseResponseFormat,
    parseSampling,
    parseToolChoice,
    parseTools,
} from "./request/options.ts";
import { parseJsonBody, validateRequestTypes } from "./request/validation.ts";
import { parseSimpleOpenAIRequest } from "./request/simple.ts";

const CHAT_REQUEST_FIELDS = new Set([
    "model",
    "messages",
    "stream",
    "tools",
    "tool_choice",
    "response_format",
    "metadata",
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "presence_penalty",
    "frequency_penalty",
    "seed",
    "n",
    "modalities",
]);
const RESPONSES_REQUEST_FIELDS = new Set([
    "model",
    "input",
    "instructions",
    "stream",
    "tools",
    "tool_choice",
    "text",
    "metadata",
    "temperature",
    "top_p",
    "max_output_tokens",
    "modalities",
]);

export async function parseOpenAIRequest(
    context: RequestContext,
): Promise<OperationRequest> {
    const dialect = dialectForRoute(context.route);
    if (!isGenerationDialect(dialect)) {
        return await parseSimpleOpenAIRequest(context, dialect);
    }
    const body = await parseJsonBody(context.request);
    const model = nonEmptyString(body.model, "model is required");
    const isResponses = dialect === "responses";
    validateRequestTypes(body, isResponses);
    const messages = isResponses
        ? parseResponsesInput(body.input, context.requestId)
        : parseChatMessages(body.messages, context.requestId);
    const knownFields = isResponses
        ? RESPONSES_REQUEST_FIELDS
        : CHAT_REQUEST_FIELDS;
    const raw = unknownFields(body, knownFields);
    const responseFormat = isResponses
        ? parseResponseFormat(asObject(body.text)?.format)
        : parseResponseFormat(body.response_format);
    const request: GenerateRequest = {
        messages,
        model,
        instructions: optionalString(body.instructions, "instructions"),
        tools: parseTools(body.tools),
        toolChoice: parseToolChoice(body.tool_choice),
        responseFormat,
        outputModalities: parseModalities(body.modalities),
        sampling: parseSampling(body, isResponses),
        stream: body.stream === true,
        metadata: parseMetadata(body.metadata),
        extensions: Object.keys(raw).length > 0 ? { raw } : undefined,
    };
    return compactUndefined({
        version: 1,
        requestId: context.requestId,
        operation: context.route.operation,
        payload: request,
        traits: {
            model,
            streaming: request.stream === true,
            inputModalities: inferInputModalities(request.messages),
            outputModalities: request.outputModalities,
            requiredCapabilities: requiredCapabilities(request),
            idempotent: false,
        },
    });
}

// Keep the historical module surface stable while implementations stay split.
export {
    parseChatMessage,
    parseChatMessages,
    parseResponsesInput,
} from "./request/messages.ts";
export { parseContent, parseContentPart } from "./request/content.ts";
export { parseJsonBody, validateRequestTypes } from "./request/validation.ts";
export {
    parseMetadata,
    parseResponseFormat,
    parseSampling,
    parseToolCall,
    parseToolChoice,
    parseTools,
} from "./request/options.ts";
