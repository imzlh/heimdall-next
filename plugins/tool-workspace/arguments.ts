export const MAX_ARGUMENT_CHARS = 32_768;
export const MAX_RESULT_CHARS = 18_000;

export function parseArguments(text: string): Record<string, unknown> {
    if (text.length > MAX_ARGUMENT_CHARS) {
        throw new Error("Tool arguments exceed 32768 characters");
    }
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error("Arguments must be a JSON object");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Arguments must be a JSON object");
    }
    return value as Record<string, unknown>;
}

export function fields(args: Record<string, unknown>, allowed: string[]): void {
    if (Object.keys(args).some((key) => !allowed.includes(key))) {
        throw new Error("Unknown tool argument");
    }
}

export function stringArg(
    args: Record<string, unknown>,
    key: string,
    fallback?: string,
): string {
    const value = args[key] === undefined ? fallback : args[key];
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    return value;
}

export function numberArg(
    args: Record<string, unknown>,
    key: string,
    fallback: number,
    min: number,
    max: number,
): number {
    const value = args[key] === undefined ? fallback : args[key];
    if (
        typeof value !== "number" || !Number.isSafeInteger(value) ||
        value < min || value > max
    ) throw new Error(`${key} must be an integer between ${min} and ${max}`);
    return value;
}

export function booleanArg(
    args: Record<string, unknown>,
    key: string,
    fallback = false,
): boolean {
    const value = args[key] === undefined ? fallback : args[key];
    if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
    return value;
}

export function revisionArg(
    args: Record<string, unknown>,
    required = true,
): string | undefined {
    const value = args.expectedRevision;
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
        throw new Error(
            "expectedRevision must be the SHA-256 revision from workspace_read",
        );
    }
    return value;
}

/** Leave room for result metadata even when JSON must escape control characters. */
export function jsonTextPrefix(text: string, maxChars: number): string {
    if (JSON.stringify(text).length <= maxChars) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (JSON.stringify(text.slice(0, middle)).length <= maxChars) {
            low = middle;
        } else high = middle - 1;
    }
    // Do not split a UTF-16 surrogate pair between pages.
    if (low > 0 && /[\uD800-\uDBFF]/.test(text.charAt(low - 1))) low--;
    return text.slice(0, low);
}
