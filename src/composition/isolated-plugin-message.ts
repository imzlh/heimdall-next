import type { JsonValue } from "@heimdall/contracts";

const MAX_BYTES = 256 * 1024;
const encoder = new TextEncoder();

/** Validate on the host: plugin code can bypass or replace its worker bootstrap. */
export function validatePluginResult(value: unknown): JsonValue | undefined {
    if (value === undefined) return undefined;
    let bytes = 0;
    const ancestors = new WeakSet<object>();
    const invalid = () => new TypeError("plugin worker returned invalid JSON");
    const consume = (count: number) => {
        bytes += count;
        if (bytes > MAX_BYTES) {
            throw new TypeError("plugin result exceeds 256 KiB");
        }
    };
    const string = (text: string) => {
        // Refuse oversized strings before allocating their escaped JSON form.
        if (text.length > MAX_BYTES) consume(MAX_BYTES + 1);
        consume(encoder.encode(JSON.stringify(text)).byteLength);
    };
    const visit = (item: unknown, depth: number): void => {
        if (depth > 64) throw invalid();
        if (item === null) return consume(4);
        if (typeof item === "string") return string(item);
        if (typeof item === "boolean") return consume(item ? 4 : 5);
        if (typeof item === "number" && Number.isFinite(item)) {
            return consume(JSON.stringify(item).length);
        }
        if (typeof item !== "object" || item === null) throw invalid();
        if (ancestors.has(item)) throw invalid();
        const array = Array.isArray(item);
        const prototype = Object.getPrototypeOf(item);
        if (
            array
                ? prototype !== Array.prototype
                : prototype !== Object.prototype && prototype !== null
        ) throw invalid();
        ancestors.add(item);
        consume(2);
        const keys = Reflect.ownKeys(item);
        if (array && keys.length !== item.length + 1) throw invalid();
        let index = 0;
        for (const key of keys) {
            if (array && key === "length") continue;
            if (typeof key !== "string") throw invalid();
            if (array && key !== String(index)) throw invalid();
            const property = Object.getOwnPropertyDescriptor(item, key)!;
            if (!property.enumerable || !("value" in property)) throw invalid();
            if (index++ > 0) consume(1);
            if (!array) {
                string(key);
                consume(1);
            }
            visit(property.value, depth + 1);
        }
        ancestors.delete(item);
    };
    visit(value, 0);
    return value as JsonValue;
}
