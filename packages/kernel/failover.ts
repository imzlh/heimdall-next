import type { CanonicalError, StreamFrame } from "../hip/mod.ts";

/** HIP errors that should try another source before any content is committed. */
export function failoverEligible(error: CanonicalError): boolean {
    if (error.retryable === false) return false;
    if (error.retryable === true) return true;
    const status = error.status;
    if (status === undefined) return false;
    if (status === 404 || status === 405 || status === 408 || status === 429) {
        return true;
    }
    return status >= 500 && status <= 599;
}

/** 5xx can be retried on the same source before the request moves on. */
export function sameSourceRetry(error: CanonicalError): boolean {
    const status = error.status;
    return status !== undefined && status >= 500 && status <= 599;
}
export function authCooldown(error: CanonicalError): boolean {
    return error.status === 401 || error.status === 403;
}

/**
 * A frame the client can observe as model output. Failover stops once one of
 * these has been produced; earlier lifecycle frames can still be discarded.
 */
export function isCommittedFrame(frame: StreamFrame): boolean {
    switch (frame.event.kind) {
        case "part.started":
        case "part.delta":
        case "part.completed":
        case "tool.call":
        case "tool.result":
        case "custom":
            return true;
        default:
            return false;
    }
}

export type AttemptOutcome =
    | { readonly kind: "ok" }
    | { readonly kind: "stop"; readonly cooldown: "auth" | undefined }
    | { readonly kind: "failover"; readonly error: CanonicalError };

/**
 * Yield a source attempt, holding lifecycle frames until the attempt is known
 * to be committable. Nothing is yielded when the result is `failover`.
 * `onCommit` runs before the first visible frame, including terminal frames:
 * errors thrown later by the source or its cleanup cannot safely be retried.
 */
export async function* attemptSource(
    frames: AsyncIterable<StreamFrame>,
    onCommit?: () => void,
): AsyncGenerator<StreamFrame, AttemptOutcome> {
    const buffered: StreamFrame[] = [];
    let committed = false;
    let failed = false;
    for await (const frame of frames) {
        if (
            frame.event.kind === "run.error" && !committed &&
            failoverEligible(frame.event.error)
        ) {
            return { kind: "failover", error: frame.event.error };
        }
        if (frame.event.kind === "run.error" && !committed) {
            onCommit?.();
            yield* buffered;
            yield frame;
            return {
                kind: "stop",
                cooldown: authCooldown(frame.event.error) ? "auth" : undefined,
            };
        }
        if (frame.event.kind === "run.cancelled" && !committed) {
            onCommit?.();
            yield* buffered;
            yield frame;
            return { kind: "stop", cooldown: undefined };
        }
        if (!committed && isCommittedFrame(frame)) {
            committed = true;
            onCommit?.();
            yield* buffered;
            buffered.length = 0;
        }
        if (committed) {
            yield frame;
            if (frame.event.kind === "run.error") failed = true;
        } else buffered.push(frame);
    }
    if (buffered.length > 0) onCommit?.();
    yield* buffered;
    return failed ? { kind: "stop", cooldown: undefined } : { kind: "ok" };
}
