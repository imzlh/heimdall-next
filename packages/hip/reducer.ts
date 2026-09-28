import type {
    ContentPart,
    ConversationState,
    JsonValue,
    Message,
    StreamFrame,
    ToolCallPart,
    ToolResultPart,
} from "./mod.ts";
import { validateStreamFrame } from "./validation.ts";
import { computeStateHash, stableJson } from "./hash.ts";

/** Reducer invariant violation in the transport-neutral HIP runtime. */
export class HipProtocolError extends Error {
    // Keep the historical error name so protocol adapters can map reducer
    // failures without importing the HTTP-layer ProtocolError class.
    override readonly name = "ProtocolError";
}

/** @deprecated Use HipProtocolError. */
const ProtocolError = HipProtocolError;
export { HipProtocolError as ProtocolError };

export function initialState(
    streamId: string,
    requestId: string,
): ConversationState {
    return {
        streamId,
        requestId,
        seq: 0,
        status: "idle",
        messages: {},
        seenEventIds: [],
        seenEventSignatures: {},
    };
}

function withMessage(
    state: ConversationState,
    message: Message,
): ConversationState {
    return { ...state, messages: { ...state.messages, [message.id]: message } };
}

function updatePart(
    message: Message,
    partId: string,
    fn: (part: ContentPart) => ContentPart,
): Message {
    let found = false;
    const parts = message.parts.map((part) => {
        if (part.id !== partId) return part;
        found = true;
        return fn(part);
    });
    if (!found) {
        throw new ProtocolError(
            `part ${partId} does not exist in message ${message.id}`,
        );
    }
    return { ...message, parts };
}

function messageIsTerminal(message: Message): boolean {
    return message.status === "completed" || message.status === "failed";
}

function partIsTerminal(part: ContentPart): boolean {
    return part.done === true ||
        (part.type === "tool_call" && part.status !== undefined &&
            part.status !== "in_progress");
}

function requireOpenMessage(message: Message, eventKind: string): void {
    if (messageIsTerminal(message)) {
        throw new ProtocolError(
            `cannot append ${eventKind} to ${message.status} message ${message.id}`,
        );
    }
}

function requireOpenPart(part: ContentPart, eventKind: string): void {
    if (partIsTerminal(part)) {
        throw new ProtocolError(
            `cannot append ${eventKind} to completed part ${part.id}`,
        );
    }
}

function allMessagesCompleted(state: ConversationState): void {
    for (const message of Object.values(state.messages)) {
        if (message.status !== "completed") {
            throw new ProtocolError(
                `cannot complete run: message ${message.id} is not completed`,
            );
        }
        for (const part of message.parts) {
            if (!partIsTerminal(part)) {
                throw new ProtocolError(
                    `cannot complete run: part ${part.id} in message ${message.id} is not completed`,
                );
            }
        }
    }
}

function findToolCall(
    state: ConversationState,
    callId: string,
): { message: Message; part: ToolCallPart } | undefined {
    for (const message of Object.values(state.messages)) {
        for (const part of message.parts) {
            if (part.type === "tool_call" && part.callId === callId) {
                return { message, part };
            }
        }
    }
    return undefined;
}

function hasToolResult(state: ConversationState, callId: string): boolean {
    return Object.values(state.messages).some((message) =>
        message.parts.some((part) =>
            part.type === "tool_result" && part.callId === callId
        )
    );
}

/**
 * Return the HIP v1 state projection used by checkpoint hashes. Event delivery
 * bookkeeping is deliberately excluded so replaying the same state produces
 * the same digest.
 */

/** Apply one frame. Duplicate event IDs are ignored, making at-least-once delivery safe. */
export function applyFrame(
    state: ConversationState,
    frame: StreamFrame,
): ConversationState {
    validateStreamFrame(frame);
    if (
        frame.streamId !== state.streamId || frame.requestId !== state.requestId
    ) {
        throw new ProtocolError("frame belongs to a different stream");
    }
    if (frame.version !== 1) {
        throw new ProtocolError(`unsupported HIP version ${frame.version}`);
    }
    if (!frame.eventId) throw new ProtocolError("eventId cannot be empty");
    if (!Number.isFinite(Date.parse(frame.timestamp))) {
        throw new ProtocolError("timestamp must be an RFC 3339 date-time");
    }
    const signature = stableJson(frame);
    if (state.seenEventIds.includes(frame.eventId)) {
        if (state.seenEventSignatures[frame.eventId] !== signature) {
            throw new ProtocolError(
                `eventId ${frame.eventId} was reused with different content`,
            );
        }
        return state;
    }
    if (frame.seq !== state.seq + 1) {
        throw new ProtocolError(
            `expected sequence ${state.seq + 1}, got ${frame.seq}`,
        );
    }

    let next: ConversationState = {
        ...state,
        seq: frame.seq,
        seenEventIds: [...state.seenEventIds, frame.eventId],
        seenEventSignatures: {
            ...state.seenEventSignatures,
            [frame.eventId]: signature,
        },
    };
    const event = frame.event;
    if (state.status === "idle" && event.kind !== "run.started") {
        throw new ProtocolError("the first event must be run.started");
    }
    if (
        state.status === "completed" || state.status === "error" ||
        state.status === "cancelled"
    ) {
        throw new ProtocolError(
            `cannot append ${event.kind} after terminal state ${state.status}`,
        );
    }
    switch (event.kind) {
        case "run.started":
            if (state.status !== "idle") {
                throw new ProtocolError(
                    "run.started may only be the first event",
                );
            }
            next = { ...next, status: "running" };
            break;
        case "message.started": {
            if (next.messages[event.message.id] !== undefined) {
                throw new ProtocolError(
                    `message ${event.message.id} already exists`,
                );
            }
            if (
                event.message.status !== undefined &&
                event.message.status !== "in_progress"
            ) {
                throw new ProtocolError(
                    `message.started cannot use terminal status ${event.message.status}`,
                );
            }
            next = withMessage(next, {
                ...event.message,
                status: "in_progress",
            });
            break;
        }
        case "part.started": {
            const message = next.messages[event.messageId];
            if (!message) {
                throw new ProtocolError(
                    `message ${event.messageId} does not exist`,
                );
            }
            requireOpenMessage(message, "part.started");
            if (
                event.part.done === true ||
                (event.part.type === "tool_call" &&
                    event.part.status !== undefined &&
                    event.part.status !== "in_progress")
            ) {
                throw new ProtocolError(
                    `part.started cannot use terminal part ${event.part.id}`,
                );
            }
            if (message.parts.some((part) => part.id === event.part.id)) {
                throw new ProtocolError(
                    `part ${event.part.id} already exists in message ${event.messageId}`,
                );
            }
            next = withMessage(next, {
                ...message,
                parts: [...message.parts, event.part],
                status: "in_progress",
            });
            break;
        }
        case "part.delta": {
            const message = next.messages[event.messageId];
            if (!message) {
                throw new ProtocolError(
                    `message ${event.messageId} does not exist`,
                );
            }
            requireOpenMessage(message, "part.delta");
            next = withMessage(
                next,
                updatePart(message, event.partId, (part) => {
                    requireOpenPart(part, "part.delta");
                    if (typeof event.delta !== "string") {
                        throw new ProtocolError(
                            `part.delta for ${part.type} part ${part.id} must be a string`,
                        );
                    }
                    if (
                        part.type === "text" || part.type === "reasoning" ||
                        part.type === "refusal"
                    ) {
                        return { ...part, text: part.text + event.delta };
                    }
                    if (part.type === "tool_call") {
                        return {
                            ...part,
                            argumentsText: part.argumentsText + event.delta,
                        };
                    }
                    if (part.type === "json") {
                        return {
                            ...part,
                            text: (part.text ?? "") + event.delta,
                        };
                    }
                    throw new ProtocolError(
                        `part.delta is not supported for ${part.type} part ${part.id}`,
                    );
                }),
            );
            break;
        }
        case "part.completed": {
            const message = next.messages[event.messageId];
            if (!message) {
                throw new ProtocolError(
                    `message ${event.messageId} does not exist`,
                );
            }
            requireOpenMessage(message, "part.completed");
            next = withMessage(
                next,
                updatePart(
                    message,
                    event.partId,
                    (part) => {
                        requireOpenPart(part, "part.completed");
                        return completePart(part, event.value);
                    },
                ),
            );
            break;
        }
        case "message.completed": {
            const message = next.messages[event.messageId];
            if (!message) {
                throw new ProtocolError(
                    `message ${event.messageId} does not exist`,
                );
            }
            requireOpenMessage(message, "message.completed");
            for (const part of message.parts) {
                if (!partIsTerminal(part)) {
                    throw new ProtocolError(
                        `cannot complete message ${message.id}: part ${part.id} is not completed`,
                    );
                }
            }
            next = withMessage(next, {
                ...message,
                status: "completed",
                finishReason: event.finishReason,
            });
            break;
        }
        case "tool.call": {
            const message = next.messages[event.messageId];
            if (!message) {
                throw new ProtocolError(
                    `message ${event.messageId} does not exist`,
                );
            }
            requireOpenMessage(message, "tool.call");
            if (findToolCall(next, event.callId) !== undefined) {
                throw new ProtocolError(
                    `tool call ${event.callId} already exists`,
                );
            }
            if (message.parts.some((part) => part.id === event.callId)) {
                throw new ProtocolError(
                    `part ${event.callId} already exists in message ${event.messageId}`,
                );
            }
            const part: ToolCallPart = {
                id: event.callId,
                type: "tool_call",
                callId: event.callId,
                name: event.name,
                argumentsText: event.argumentsText ?? "",
                arguments: event.arguments,
                status: "completed",
                done: true,
            };
            next = withMessage(next, {
                ...message,
                parts: [...message.parts, part],
            });
            break;
        }
        case "tool.result": {
            const message = next.messages[event.messageId];
            if (!message) {
                throw new ProtocolError(
                    `message ${event.messageId} does not exist`,
                );
            }
            requireOpenMessage(message, "tool.result");
            const call = findToolCall(next, event.callId);
            if (call === undefined) {
                throw new ProtocolError(
                    `tool call ${event.callId} does not exist`,
                );
            }
            if (!partIsTerminal(call.part)) {
                throw new ProtocolError(
                    `tool call ${event.callId} is not completed`,
                );
            }
            if (hasToolResult(next, event.callId)) {
                throw new ProtocolError(
                    `tool result ${event.callId} already exists`,
                );
            }
            if (
                message.parts.some((part) =>
                    part.id === `result:${event.callId}`
                )
            ) {
                throw new ProtocolError(
                    `part result:${event.callId} already exists in message ${event.messageId}`,
                );
            }
            const part: ToolResultPart = {
                id: `result:${event.callId}`,
                type: "tool_result",
                callId: event.callId,
                result: event.result,
                parts: event.parts,
                isError: event.isError,
                error: event.error,
                done: true,
            };
            next = withMessage(next, {
                ...message,
                parts: [...message.parts, part],
            });
            break;
        }
        case "usage":
            next = { ...next, usage: event.usage };
            break;
        case "suggestions":
            next = { ...next, suggestions: event.suggestions };
            break;
        case "title":
            next = { ...next, title: event.title };
            break;
        case "run.completed":
            allMessagesCompleted(next);
            next = {
                ...next,
                status: "completed",
                finishReason: event.finishReason,
            };
            break;
        case "run.error":
            next = { ...next, status: "error", error: event.error };
            break;
        case "run.cancelled":
            next = { ...next, status: "cancelled" };
            break;
        case "run.cancel.requested":
            // A request is an informational event; the run becomes cancelled only
            // after the executor acknowledges it with run.cancelled.
            break;
        case "checkpoint": {
            const expected = computeStateHash(next);
            if (event.stateHash !== expected) {
                throw new ProtocolError(
                    `checkpoint hash mismatch: expected ${expected}, got ${event.stateHash}`,
                );
            }
            next = { ...next, checkpointHash: event.stateHash };
            break;
        }
        case "custom":
            break;
    }
    return next;
}

function completePart(part: ContentPart, _value?: JsonValue): ContentPart {
    // `value` is an adapter hint. HIP's generic reducer only closes the part;
    // replacing accumulated content here would violate append-only semantics.
    return { ...part, done: true };
}
