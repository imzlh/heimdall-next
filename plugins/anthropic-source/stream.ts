import type { StreamFrame } from "@heimdall/contracts";
import {
    AnthropicUpstreamError,
    canonicalUpstreamError,
    invalidUpstreamResponse,
} from "./errors.ts";
import { parseUsage } from "./response.ts";
import {
    type FrameEmitter,
    isRecord,
    SSE_DONE,
    type WireObject,
} from "./types.ts";

type BlockKind = "text" | "reasoning" | "tool";

interface OpenBlock {
    readonly partId: string;
    readonly kind: BlockKind;
    closed: boolean;
}

interface SseState {
    readonly blocks: Map<number, OpenBlock>;
    rawUsage?: WireObject;
    finishReason?: string;
}

/** Map an Anthropic Messages SSE response to append-only HIP events. */
export async function* streamResponse(
    response: Response,
    emit: FrameEmitter,
    messageId: string,
    signal: AbortSignal,
): AsyncGenerator<StreamFrame, "cancelled" | undefined> {
    if (response.body === null) {
        throw invalidUpstreamResponse(
            "upstream returned an empty streaming body",
        );
    }
    const state: SseState = { blocks: new Map() };
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
        if (!isRecord(item)) continue;
        if (item.type === "error" && isRecord(item.error)) {
            throw new AnthropicUpstreamError(
                canonicalUpstreamError(item.error),
            );
        }
        if (item.type === "message_stop") {
            done = true;
            break;
        }
        yield* handleEvent(item, state, emit, messageId);
    }
    if (!done) {
        throw new AnthropicUpstreamError({
            code: "stream_incomplete",
            message: "upstream SSE stream ended without message_stop",
            retryable: true,
            status: 502,
        });
    }
    if (signal.aborted) {
        yield emit({ kind: "run.cancelled", reason: "request aborted" });
        return "cancelled";
    }
    for (const block of state.blocks.values()) {
        if (!block.closed) {
            block.closed = true;
            yield emit({
                kind: "part.completed",
                messageId,
                partId: block.partId,
            });
        }
    }
    yield emit({
        kind: "message.completed",
        messageId,
        finishReason: state.finishReason ?? "end_turn",
    });
    if (state.rawUsage !== undefined) {
        yield emit({ kind: "usage", usage: parseUsage(state.rawUsage) });
    }
}

function* handleEvent(
    item: WireObject,
    state: SseState,
    emit: FrameEmitter,
    messageId: string,
): Generator<StreamFrame> {
    switch (item.type) {
        case "ping":
            return;
        case "message_start":
            if (isRecord(item.message) && isRecord(item.message.usage)) {
                state.rawUsage = { ...state.rawUsage, ...item.message.usage };
            }
            return;
        case "message_delta":
            if (
                isRecord(item.delta) &&
                typeof item.delta.stop_reason === "string"
            ) {
                state.finishReason = item.delta.stop_reason;
            }
            if (isRecord(item.usage)) {
                state.rawUsage = { ...state.rawUsage, ...item.usage };
            }
            return;
        case "content_block_start":
            yield* startBlock(item, state, emit, messageId);
            return;
        case "content_block_delta":
            yield* deltaBlock(item, state, emit, messageId);
            return;
        case "content_block_stop":
            yield* stopBlock(item, state, emit, messageId);
            return;
        default:
            return;
    }
}

function* startBlock(
    item: WireObject,
    state: SseState,
    emit: FrameEmitter,
    messageId: string,
): Generator<StreamFrame> {
    const index = blockIndex(item.index);
    if (state.blocks.has(index)) {
        throw invalidUpstreamResponse(`duplicate content block index ${index}`);
    }
    const block = isRecord(item.content_block) ? item.content_block : undefined;
    if (block === undefined || typeof block.type !== "string") {
        throw invalidUpstreamResponse(
            "content_block_start requires content_block.type",
        );
    }
    if (block.type === "text") {
        const partId = `${messageId}:text:${index}`;
        state.blocks.set(index, { partId, kind: "text", closed: false });
        yield emit({
            kind: "part.started",
            messageId,
            part: { id: partId, type: "text", text: "" },
        });
        if (typeof block.text === "string" && block.text.length > 0) {
            yield emit({
                kind: "part.delta",
                messageId,
                partId,
                delta: block.text,
            });
        }
    } else if (
        block.type === "thinking" || block.type === "redacted_thinking"
    ) {
        const partId = `${messageId}:reasoning:${index}`;
        state.blocks.set(index, { partId, kind: "reasoning", closed: false });
        yield emit({
            kind: "part.started",
            messageId,
            part: {
                id: partId,
                type: "reasoning",
                text: "",
                visibility: block.type === "thinking" ? "private" : "redacted",
                ...(typeof block.signature === "string"
                    ? { signature: block.signature }
                    : {}),
                ...(typeof block.data === "string"
                    ? { extensions: { raw: { data: block.data } } }
                    : {}),
            },
        });
        if (typeof block.thinking === "string" && block.thinking.length > 0) {
            yield emit({
                kind: "part.delta",
                messageId,
                partId,
                delta: block.thinking,
            });
        }
    } else if (block.type === "tool_use") {
        if (typeof block.id !== "string" || block.id.length === 0) {
            throw invalidUpstreamResponse("tool_use block must contain id");
        }
        if (typeof block.name !== "string" || block.name.length === 0) {
            throw invalidUpstreamResponse("tool_use block must contain name");
        }
        const partId = `${messageId}:tool:${index}`;
        state.blocks.set(index, { partId, kind: "tool", closed: false });
        yield emit({
            kind: "part.started",
            messageId,
            part: {
                id: partId,
                type: "tool_call",
                callId: block.id,
                name: block.name,
                argumentsText: "",
                status: "in_progress",
            },
        });
    } else {
        throw invalidUpstreamResponse(
            `unsupported streaming content type: ${block.type}`,
        );
    }
}

function* deltaBlock(
    item: WireObject,
    state: SseState,
    emit: FrameEmitter,
    messageId: string,
): Generator<StreamFrame> {
    const index = blockIndex(item.index);
    const block = state.blocks.get(index);
    if (block === undefined) {
        throw invalidUpstreamResponse(
            `content_block_delta for unknown index ${index}`,
        );
    }
    const delta = isRecord(item.delta) ? item.delta : undefined;
    if (delta === undefined) {
        throw invalidUpstreamResponse("content_block_delta requires delta");
    }
    const text = typeof delta.text === "string"
        ? delta.text
        : typeof delta.thinking === "string"
        ? delta.thinking
        : typeof delta.partial_json === "string"
        ? delta.partial_json
        : undefined;
    if (text !== undefined && text.length > 0) {
        yield emit({
            kind: "part.delta",
            messageId,
            partId: block.partId,
            delta: text,
        });
    }
}

function* stopBlock(
    item: WireObject,
    state: SseState,
    emit: FrameEmitter,
    messageId: string,
): Generator<StreamFrame> {
    const index = blockIndex(item.index);
    const block = state.blocks.get(index);
    if (block === undefined) {
        throw invalidUpstreamResponse(
            `content_block_stop for unknown index ${index}`,
        );
    }
    if (!block.closed) {
        block.closed = true;
        yield emit({
            kind: "part.completed",
            messageId,
            partId: block.partId,
        });
    }
}

function blockIndex(value: unknown): number {
    if (
        typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
    ) {
        throw invalidUpstreamResponse(
            "content block index must be a non-negative integer",
        );
    }
    return value;
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
