import type { StreamFrame } from "../hip/mod.ts";
import { withCancellation } from "./cancellation.ts";

interface OwnedStream {
    readonly iterator: AsyncIterator<StreamFrame>;
    done: boolean;
}

/**
 * The host owns every intermediate iterator, including streams eagerly opened
 * by a frame hook. Abort closes upstream independently of a hung outer hook.
 */
export class MiddlewareFrameStreams {
    readonly #streams: OwnedStream[] = [];
    readonly #signal: AbortSignal;
    readonly #onAbort: () => void;
    #closed = false;
    #closing: Promise<void> | undefined;

    constructor(signal: AbortSignal) {
        this.#signal = signal;
        this.#onAbort = () => {
            void this.close().catch(() => {});
        };
        signal.throwIfAborted();
        signal.addEventListener("abort", this.#onAbort, { once: true });
    }

    own(frames: AsyncIterable<StreamFrame>): AsyncIterable<StreamFrame> {
        const stream: OwnedStream = {
            iterator: frames[Symbol.asyncIterator](),
            done: false,
        };
        this.#streams.push(stream);
        // A cancelled hook can still resolve later with a live iterator.
        if (this.#closed) void this.#return(stream).catch(() => {});
        const managed: AsyncIterableIterator<StreamFrame> = {
            [Symbol.asyncIterator]() {
                return this;
            },
            next: async () => {
                if (stream.done) return { done: true, value: undefined };
                const next = await stream.iterator.next();
                if (next.done) stream.done = true;
                return next;
            },
            return: () => this.#return(stream),
        };
        return managed;
    }

    async #return(stream: OwnedStream): Promise<IteratorResult<StreamFrame>> {
        if (stream.done) return { done: true, value: undefined };
        stream.done = true;
        return stream.iterator.return === undefined
            ? { done: true, value: undefined }
            : await stream.iterator.return();
    }

    close(): Promise<void> {
        if (this.#closing !== undefined) return this.#closing;
        this.#closed = true;
        this.#signal.removeEventListener("abort", this.#onAbort);
        // Start every return before awaiting. A hung wrapper must not prevent
        // the provider and other intermediate streams from being closed.
        this.#closing = Promise.allSettled(
            [...this.#streams].reverse().map((stream) => this.#return(stream)),
        ).then((results) => {
            const failed = results.find((result) =>
                result.status === "rejected"
            );
            if (failed?.status === "rejected") throw failed.reason;
        });
        return this.#closing;
    }

    async dispose(): Promise<void> {
        // Initiate cleanup even if already aborted; cancellation only bounds
        // the caller's wait, never skips the owned iterators' return methods.
        const closing = this.close();
        if (this.#signal.aborted) {
            void closing.catch(() => {});
            return;
        }
        await withCancellation(() => closing, this.#signal);
    }

    async *finish(
        frames: AsyncIterable<StreamFrame>,
    ): AsyncIterable<StreamFrame> {
        let failed = false;
        try {
            yield* frames;
        } catch (error) {
            failed = true;
            throw error;
        } finally {
            if (failed) await this.dispose().catch(() => {});
            else await this.dispose();
        }
    }
}
