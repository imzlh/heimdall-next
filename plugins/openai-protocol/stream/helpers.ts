import type { Message } from "@heimdall/contracts";
import type { ResponsesTracker } from "./types.ts";

export type ResponsesEvent = { event: string; data: unknown };

export function ensureResponseMessage(
    outputs: ResponsesEvent[],
    tracker: ResponsesTracker,
    message: Message | undefined,
): number {
    if (!message) throw new TypeError("part references an unknown message");
    const existing = tracker.outputIndexes.get(message.id);
    if (existing !== undefined) return existing;
    const outputIndex = responseOutputIndex(tracker, message.id);
    outputs.push({
        event: "response.output_item.added",
        data: {
            type: "response.output_item.added",
            sequence_number: tracker.nextSequenceNumber++,
            output_index: outputIndex,
            item: {
                id: message.id,
                type: "message",
                status: "in_progress",
                role: "assistant",
                content: [],
            },
        },
    });
    return outputIndex;
}

export function responseOutputIndex(
    tracker: ResponsesTracker,
    id: string,
): number {
    const existing = tracker.outputIndexes.get(id);
    if (existing !== undefined) return existing;
    const index = tracker.nextOutputIndex++;
    tracker.outputIndexes.set(id, index);
    return index;
}
