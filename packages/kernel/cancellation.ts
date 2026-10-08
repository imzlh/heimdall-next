/** One abort listener per pending operation, released when either settles. */
export async function withCancellation<T>(
    operation: () => T | PromiseLike<T>,
    signal: AbortSignal,
): Promise<T> {
    signal.throwIfAborted();
    let onAbort!: () => void;
    const pending = new Promise<T>((resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            Promise.resolve(operation()).then(resolve, reject);
        } catch (error) {
            reject(error);
        }
    });
    try {
        return await pending;
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}
