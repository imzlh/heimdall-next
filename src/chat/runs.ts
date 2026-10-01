import type { ChatStore } from "@heimdall/storage";

const activeRuns = new WeakMap<ChatStore, Set<string>>();

/** Synchronous retention work must not delete a conversation owned by a command. */
export function isConversationRunning(
    store: ChatStore,
    conversationId: string,
): boolean {
    return activeRuns.get(store)?.has(conversationId) === true;
}

class ChatRunConflictError extends Error {
    override readonly name = "ChatRunConflictError";
    readonly status = 409;
    readonly code = "run_in_progress";

    constructor() {
        super("a run is already active for this conversation");
    }
}

/** Serialize turns, renames, and deletion before they can mutate shared history. */
export async function withConversationRun<T>(
    store: ChatStore,
    conversationId: string,
    run: () => T | Promise<T>,
): Promise<T> {
    let runs = activeRuns.get(store);
    if (runs === undefined) {
        runs = new Set();
        activeRuns.set(store, runs);
    }
    if (runs.has(conversationId)) throw new ChatRunConflictError();
    runs.add(conversationId);
    try {
        return await run();
    } finally {
        runs.delete(conversationId);
    }
}
