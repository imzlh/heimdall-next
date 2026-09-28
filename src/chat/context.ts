import type { RequestContext } from "@heimdall/contracts";

/** Transport metadata survives while the service supplies canonical chat identity. */
export function chatCommandContext(
    context: RequestContext,
    conversationId: string,
    command: string,
): RequestContext {
    return {
        ...context,
        metadata: {
            ...context.metadata,
            conversationId,
            sessionId: conversationId,
            traceId: nonEmpty(context.metadata.traceId) ?? context.requestId,
            purpose: nonEmpty(context.metadata.purpose) ?? "chat",
            command,
        },
    };
}

/** Child generations share a trace and cancellation but have their own journal id. */
export function chatChildContext(
    context: RequestContext,
    suffix: string,
    purpose?: string,
): RequestContext {
    return {
        ...context,
        requestId: `${context.requestId}:${suffix}`,
        ...(purpose ? { metadata: { ...context.metadata, purpose } } : {}),
    };
}

function nonEmpty(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
}
