/**
 * Conversation chaining for the OpenAI Responses dialect.
 *
 * The Responses API lets a client continue a thread by sending the prior
 * response's id as `previous_response_id` instead of resending history. We use
 * that as the conversation identity for routing affinity and upstream session
 * reuse. To stay stateless across restarts, the identity rides inside the
 * response id we hand back, so the next turn's `previous_response_id` carries
 * it home again — no server-side response-id table to keep or evict.
 */

const PREFIX = "resp_c_";
const SEPARATOR = "_";

/** Embed a conversation id in the response id the client will echo back. */
export function encodeResponseId(conversationId: string, base: string): string {
    return `${PREFIX}${conversationId}${SEPARATOR}${base}`;
}

/**
 * The conversation id carried by one of our response ids, or undefined when the
 * value is absent or was not minted here. Our ids are `resp_c_<uuid>_<base>`,
 * and a uuid holds no separator, so the id ends at the first one.
 */
export function conversationIdFromResponseId(
    value: unknown,
): string | undefined {
    if (typeof value !== "string" || !value.startsWith(PREFIX)) {
        return undefined;
    }
    const rest = value.slice(PREFIX.length);
    const end = rest.indexOf(SEPARATOR);
    const id = end === -1 ? rest : rest.slice(0, end);
    return id.length > 0 && id.length <= 256 ? id : undefined;
}

/**
 * Resolve the conversation id for a Responses request, or undefined to defer to
 * the kernel's content anchor. An explicit id from the caller wins; otherwise a
 * recognized `previous_response_id` continues its chain. Failing both, only a
 * first/one-shot turn mints a fresh id (so its next turn can chain) — a resent
 * multi-turn history carries no id we can trust, and minting a per-turn one
 * there would defeat reuse, so we leave it to the anchor instead.
 */
export function responsesConversationId(options: {
    readonly clientId?: string;
    readonly previousResponseId?: unknown;
    readonly singleTurn: boolean;
}): string | undefined {
    if (options.clientId) return options.clientId;
    const chained = conversationIdFromResponseId(options.previousResponseId);
    if (chained) return chained;
    return options.singleTurn ? crypto.randomUUID() : undefined;
}
