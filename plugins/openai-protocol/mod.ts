import { type OperationRequest, type StreamFrame } from "@heimdall/contracts";
import {
    type PluginManifest,
    type ProtocolPlugin,
    type RequestContext,
} from "@heimdall/contracts";
import manifest from "./manifest.json" with { type: "json" };
import { parseOpenAIRequest } from "./request.ts";
import { openAIErrorResponse } from "./response.ts";
import { serializeOpenAIResponse } from "./serializer.ts";

/**
 * OpenAI client wire adapter.
 *
 * The adapter deliberately contains no upstream I/O. It only maps the
 * OpenAI HTTP dialect to HIP and serializes HIP events back to that dialect.
 */
export class OpenAIProtocolPlugin implements ProtocolPlugin {
    readonly manifest = manifest as PluginManifest;

    parse(context: RequestContext): Promise<OperationRequest> {
        return parseOpenAIRequest(context);
    }

    serialize(
        context: RequestContext,
        input: OperationRequest,
        events: AsyncIterable<StreamFrame>,
    ): Promise<Response> {
        return serializeOpenAIResponse(context, input, events);
    }

    serializeError(_context: RequestContext, error: unknown): Response {
        return openAIErrorResponse(
            error as {
                readonly code: string;
                readonly message: string;
                readonly status?: number;
            },
        );
    }
}

export default new OpenAIProtocolPlugin();
