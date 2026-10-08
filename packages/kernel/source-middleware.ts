import type { RequestContext } from "../contracts/mod.ts";
import { validateOperationRequest } from "../hip/mod.ts";
import { MiddlewareRegistry, SourceMiddlewareError } from "./hooks.ts";
import type { SourceExecution, SourceMiddlewareBindings } from "./mod.ts";
import { validateFrames } from "./sources.ts";

/** A request owns its bindings and active plugin set until all attempts finish. */
export interface ExecutionMiddleware {
    readonly global: MiddlewareRegistry;
    readonly bindings: SourceMiddlewareBindings;
    readonly perSource: boolean;
}

/**
 * Source selection uses the public request. Each attempt then gets its own
 * middleware input before the host source wrapper resolves the upstream model.
 * A failing source cannot carry another source's transformations into failover.
 */
export function sourceMiddlewareExecution(
    snapshot: ExecutionMiddleware,
    requestContext: RequestContext | undefined,
): SourceExecution {
    return async function* (source, input, context) {
        let directSource = false;
        let sourceFailed = false;
        let sourceError: unknown;
        let sourceErrorFrame = false;
        try {
            const binding = snapshot.bindings.get(source.id);
            const middleware = binding === undefined
                ? snapshot.global
                : snapshot.global.select(binding);
            const request = structuredClone(input);
            context.signal.throwIfAborted();
            if (middleware.list().length === 0) {
                // This path has no middleware to blame or intercept failures.
                directSource = true;
                yield* validateFrames(
                    source.execute(request, context),
                    request.requestId,
                    {
                        signal: context.signal,
                    },
                );
                return;
            }
            if (requestContext === undefined) {
                throw new TypeError(
                    "a RequestContext is required when source middleware is registered",
                );
            }
            const hookRequest: RequestContext = {
                ...requestContext,
                signal: context.signal,
                metadata: structuredClone(requestContext.metadata),
            };
            const transformed = await middleware.transformRequest(
                request,
                hookRequest,
            );
            validateOperationRequest(transformed);
            context.signal.throwIfAborted();
            const sourceContext = {
                ...context,
                metadata: {
                    ...hookRequest.metadata,
                    ...(transformed.metadata ?? {}),
                },
            };
            // Construct the provider lazily. A failing frame hook must not leave
            // a source that was opened but never pulled or closed.
            const upstream = (async function* () {
                try {
                    for await (
                        const item of validateFrames(
                            source.execute(transformed, sourceContext),
                            transformed.requestId,
                            { signal: context.signal },
                        )
                    ) {
                        if (item.event.kind === "run.error") {
                            sourceErrorFrame = true;
                        }
                        yield item;
                    }
                } catch (error) {
                    sourceFailed = true;
                    sourceError = error;
                    throw error;
                }
            })();
            const frames = await middleware.transformFrames(
                transformed,
                hookRequest,
                upstream,
            );
            context.signal.throwIfAborted();
            for await (const item of frames) {
                if (
                    item.event.kind === "run.error" && !sourceErrorFrame &&
                    !sourceFailed
                ) {
                    // A plugin policy failure is not evidence that an upstream
                    // failed. It must neither trigger failover nor cool a source.
                    throw new SourceMiddlewareError(item.event.error);
                }
                yield item;
            }
        } catch (error) {
            context.signal.throwIfAborted();
            if (
                directSource || error instanceof SourceMiddlewareError ||
                (sourceFailed && Object.is(sourceError, error))
            ) {
                throw error;
            }
            throw new SourceMiddlewareError(error);
        }
    };
}
