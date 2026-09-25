import {
    type GenerationRequest,
    type OperationRequest,
    type PluginManifest,
    type ProtocolPlugin,
    type RequestContext,
    type StreamFrame,
} from "@heimdall/contracts";
import { ANTHROPIC_MANIFEST } from "./contract.ts";
import { parseAnthropicRequest } from "./input.ts";
import { anthropicErrorResponse, serializeAnthropicJson } from "./output.ts";
import { generationPayload } from "./shared.ts";
import { serializeAnthropicStream } from "./stream.ts";

/** Anthropic Messages wire adapter. Network access belongs to source plugins. */
export class AnthropicProtocolPlugin implements ProtocolPlugin {
    readonly manifest: PluginManifest = ANTHROPIC_MANIFEST;

    parse(
        context: RequestContext,
    ): Promise<OperationRequest<GenerationRequest>> {
        return parseAnthropicRequest(context);
    }

    serialize(
        context: RequestContext,
        input: OperationRequest,
        events: AsyncIterable<StreamFrame>,
    ): Promise<Response> {
        const request = generationPayload(input);
        if (request.stream === true) {
            return Promise.resolve(
                serializeAnthropicStream(context, input, events),
            );
        }
        return serializeAnthropicJson(input, events);
    }

    serializeError(_context: RequestContext, error: unknown): Response {
        return anthropicErrorResponse(
            error as {
                readonly code?: string;
                readonly message?: string;
                readonly status?: number;
            },
        );
    }
}

export default new AnthropicProtocolPlugin();
