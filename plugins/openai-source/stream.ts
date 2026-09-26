import type { StreamFrame, Usage } from "@heimdall/contracts";
import {
    canonicalUpstreamError,
    invalidUpstreamResponse,
    OpenAIUpstreamError,
} from "./errors.ts";
import { parseUsage } from "./response.ts";
import {
    type FrameEmitter,
    isRecord,
    SSE_DONE,
    type WireObject,
} from "./types.ts";

interface SseTool {
    readonly id: string;
    readonly name: string;
    readonly partId: string;
}

interface SseAccumulator {
    nextPart: number;
    textPartId?: string;
    refusalPartId?: string;
    reasoningPartId?: string;
    readonly tools: Map<number, SseTool>;
    usage?: Usage;
    finishReason?: string;
    sawChoice: boolean;
}

/** Map a Chat Completions SSE response to append-only HIP events. */
export async function* streamResponse(
    response: Response,
    emit: FrameEmitter,
    messageId: string,
    signal: AbortSignal,
): AsyncGenerator<StreamFrame, "cancelled" | undefined> {
    if (response.body === null) {
        throw new OpenAIUpstreamError({
            code: "upstream_invalid_response",
            message: "upstream returned an empty streaming body",
            retryable: false,
            status: 502,
        });
    }
    const state: SseAccumulator = {
        nextPart: 0,
        tools: new Map(),
        sawChoice: false,
    };
    let done = false;
    for await (const item of readSse(response.body)) {
        if (signal.aborted) {
            yield emit({ kind: "run.cancelled", reason: "request aborted" });
            return "cancelled";
        }
        if (item === SSE_DONE) {
            done = true;
            break;
        }
        if (isRecord(item) && isRecord(item.error)) {
            throw new OpenAIUpstreamError(canonicalUpstreamError(item.error));
        }
        if (!isRecord(item)) continue;

        const choice = parseChoice(item, state);
        if (choice === undefined) {
            if (Object.hasOwn(item, "usage") && isRecord(item.usage)) {
                state.usage = parseUsage(item.usage);
                continue;
            }
            throw invalidUpstreamResponse(
                "SSE event has neither choices nor usage",
            );
        }
        const delta = isRecord(choice.delta) ? choice.delta : undefined;
        if (delta !== undefined) {
            yield* emitText(delta, state, emit, messageId);
            yield* emitRefusal(delta, state, emit, messageId);
            yield* emitReasoning(delta, state, emit, messageId);
            yield* emitTools(delta, state, emit, messageId);
        }
        if (typeof choice.finish_reason === "string") {
            state.finishReason = choice.finish_reason;
        }
        if (Object.hasOwn(item, "usage") && isRecord(item.usage)) {
            state.usage = parseUsage(item.usage);
        }
    }
    if (!done) {
        throw new OpenAIUpstreamError({
            code: "stream_incomplete",
            message: "upstream SSE stream ended without [DONE]",
            retryable: true,
            status: 502,
        });
    }
    if (!state.sawChoice) {
        throw invalidUpstreamResponse(
            "upstream SSE stream contained no choices",
        );
    }
    if (signal.aborted) {
        yield emit({ kind: "run.cancelled", reason: "request aborted" });
        return "cancelled";
    }
    for (
        const partId of [
            state.textPartId,
            state.refusalPartId,
            state.reasoningPartId,
        ]
    ) {
        if (partId !== undefined) {
            yield emit({ kind: "part.completed", messageId, partId });
        }
    }
    for (const tool of state.tools.values()) {
        yield emit({ kind: "part.completed", messageId, partId: tool.partId });
    }
    yield emit({
        kind: "message.completed",
        messageId,
        finishReason: state.finishReason ?? "stop",
    });
    if (state.usage !== undefined) {
        yield emit({ kind: "usage", usage: state.usage });
    }
}

function parseChoice(
    item: WireObject,
    state: SseAccumulator,
): WireObject | undefined {
    if (!Object.hasOwn(item, "choices")) return undefined;
    if (!Array.isArray(item.choices)) {
        throw invalidUpstreamResponse("SSE choices must be an array");
    }
    if (item.choices.length === 0) {
        if (Object.hasOwn(item, "usage")) return undefined;
        throw invalidUpstreamResponse("SSE choices cannot be empty");
    }
    const choice = item.choices[0];
    if (!isRecord(choice)) {
        throw invalidUpstreamResponse("SSE choice must be an object");
    }
    state.sawChoice = true;
    if (Object.hasOwn(choice, "delta") && !isRecord(choice.delta)) {
        throw invalidUpstreamResponse("SSE choice.delta must be an object");
    }
    if (
        !Object.hasOwn(choice, "delta") &&
        typeof choice.finish_reason !== "string" &&
        choice.finish_reason !== null
    ) {
        throw invalidUpstreamResponse(
            "SSE choice must contain delta or finish_reason",
        );
    }
    return choice;
}

function* emitText(
    delta: WireObject,
    state: SseAccumulator,
    emit: FrameEmitter,
    messageId: string,
): Generator<StreamFrame> {
    if (typeof delta.content !== "string") return;
    if (state.textPartId === undefined) {
        state.textPartId = `${messageId}:text:${state.nextPart++}`;
        yield emit({
            kind: "part.started",
            messageId,
            part: { id: state.textPartId, type: "text", text: "" },
        });
    }
    if (delta.content.length > 0) {
        yield emit({
            kind: "part.delta",
            messageId,
            partId: state.textPartId,
            delta: delta.content,
        });
    }
}

function* emitRefusal(
    delta: WireObject,
    state: SseAccumulator,
    emit: FrameEmitter,
    messageId: string,
): Generator<StreamFrame> {
    if (typeof delta.refusal !== "string") return;
    if (state.refusalPartId === undefined) {
        state.refusalPartId = `${messageId}:refusal:${state.nextPart++}`;
        yield emit({
            kind: "part.started",
            messageId,
            part: { id: state.refusalPartId, type: "refusal", text: "" },
        });
    }
    if (delta.refusal.length > 0) {
        yield emit({
            kind: "part.delta",
            messageId,
            partId: state.refusalPartId,
            delta: delta.refusal,
        });
    }
}

function* emitReasoning(
    delta: WireObject,
    state: SseAccumulator,
    emit: FrameEmitter,
    messageId: string,
): Generator<StreamFrame> {
    const value = typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
        ? delta.reasoning
        : undefined;
    if (value === undefined) return;
    if (state.reasoningPartId === undefined) {
        state.reasoningPartId = `${messageId}:reasoning:${state.nextPart++}`;
        yield emit({
            kind: "part.started",
            messageId,
            part: {
                id: state.reasoningPartId,
                type: "reasoning",
                text: "",
                visibility: "private",
            },
        });
    }
    if (value.length > 0) {
        yield emit({
            kind: "part.delta",
            messageId,
            partId: state.reasoningPartId,
            delta: value,
        });
    }
}

function* emitTools(
    delta: WireObject,
    state: SseAccumulator,
    emit: FrameEmitter,
    messageId: string,
): Generator<StreamFrame> {
    const toolDeltas = Object.hasOwn(delta, "tool_calls")
        ? delta.tool_calls
        : [];
    if (!Array.isArray(toolDeltas)) {
        throw invalidUpstreamResponse("SSE delta.tool_calls must be an array");
    }
    for (const rawTool of toolDeltas) {
        if (!isRecord(rawTool)) {
            throw invalidUpstreamResponse("SSE tool call must be an object");
        }
        const index = rawTool.index;
        if (
            typeof index !== "number" || !Number.isSafeInteger(index) ||
            index < 0
        ) {
            throw invalidUpstreamResponse(
                "SSE tool call index must be a non-negative integer",
            );
        }
        const fn = Object.hasOwn(rawTool, "function")
            ? rawTool.function
            : undefined;
        if (fn !== undefined && !isRecord(fn)) {
            throw invalidUpstreamResponse(
                "SSE tool function must be an object",
            );
        }
        let tool = state.tools.get(index);
        if (tool === undefined) {
            const id = rawTool.id;
            const name = fn?.name;
            if (
                typeof id !== "string" || id.length === 0 ||
                typeof name !== "string" || name.length === 0
            ) {
                throw invalidUpstreamResponse(
                    "first SSE tool chunk must contain id and function.name",
                );
            }
            tool = { id, name, partId: `${messageId}:tool:${index}` };
            state.tools.set(index, tool);
            yield emit({
                kind: "part.started",
                messageId,
                part: {
                    id: tool.partId,
                    type: "tool_call",
                    callId: tool.id,
                    name: tool.name,
                    argumentsText: "",
                    status: "in_progress",
                },
            });
        } else {
            if (rawTool.id !== undefined && rawTool.id !== tool.id) {
                throw invalidUpstreamResponse(
                    `SSE tool ${index} changed its call id`,
                );
            }
            if (fn?.name !== undefined && fn.name !== tool.name) {
                throw invalidUpstreamResponse(
                    `SSE tool ${index} changed its function name`,
                );
            }
        }
        if (fn?.arguments !== undefined && typeof fn.arguments !== "string") {
            throw invalidUpstreamResponse(
                "SSE tool function.arguments must be a string",
            );
        }
        if (typeof fn?.arguments === "string" && fn.arguments.length > 0) {
            yield emit({
                kind: "part.delta",
                messageId,
                partId: tool.partId,
                delta: fn.arguments,
            });
        }
    }
}

/** Parse SSE records without coupling the source to a particular HTTP host. */
export async function* readSse(
    body: ReadableStream<Uint8Array>,
): AsyncIterable<WireObject | typeof SSE_DONE> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];

    const dispatch = (): WireObject | typeof SSE_DONE | undefined => {
        if (dataLines.length === 0) return undefined;
        const data = dataLines.join("\n");
        dataLines = [];
        if (data.trim() === "[DONE]") return SSE_DONE;
        let parsed: unknown;
        try {
            parsed = JSON.parse(data);
        } catch (error) {
            throw invalidUpstreamResponse(
                `upstream SSE data is not JSON: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        return isRecord(parsed) ? parsed : undefined;
    };

    const flushLine = function* (
        line: string,
    ): Generator<WireObject | typeof SSE_DONE> {
        if (line.length === 0) {
            const event = dispatch();
            if (event !== undefined) yield event;
        } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
        }
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            while (true) {
                const lf = buffer.indexOf("\n");
                const cr = buffer.indexOf("\r");
                const newline = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
                if (newline < 0) break;
                const width =
                    buffer[newline] === "\r" && buffer[newline + 1] === "\n"
                        ? 2
                        : 1;
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + width);
                yield* flushLine(line);
            }
            if (done) break;
        }
        if (buffer.length > 0) yield* flushLine(buffer);
        const event = dispatch();
        if (event !== undefined) yield event;
    } finally {
        // Providers may keep the connection open after their terminal frame.
        // Release it on early return, parse failure, and consumer cancellation.
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
