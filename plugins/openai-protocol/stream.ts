// Compatibility facade for the OpenAI stream serializers.
export { chatStreamEvents } from "./stream/chat.ts";
export {
    ensureResponseMessage,
    responseOutputIndex,
    responsesStreamEvents,
} from "./stream/responses.ts";
export {
    createResponsesTracker,
    type ResponsesTracker,
} from "./stream/types.ts";
