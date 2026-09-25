const reserved = new Set(["__proto__", "prototype", "constructor"]);

/** Copy without invoking getters or toJSON, rejecting cycles, prototypes and non-JSON values. */
export function copyFormJson(value: unknown, maxBytes: number): unknown {
    const ancestors = new Set<object>();
    let nodes = 0;
    let characters = 0;
    const copy = (item: unknown, depth: number): unknown => {
        ensure(++nodes <= 8192 && depth <= 32, "JSON complexity exceeded");
        if (typeof item === "string") {
            characters += item.length;
            ensure(
                characters <= maxBytes,
                "JSON size exceeded",
            );
            return item;
        }
        if (item === null || typeof item === "boolean") return item;
        if (typeof item === "number") {
            ensure(Number.isFinite(item), "non-finite number");
            return item;
        }
        ensure(
            typeof item === "object" && !ancestors.has(item),
            "non-JSON value or cycle",
        );
        const array = Array.isArray(item);
        ensure(
            array || Object.getPrototypeOf(item) === Object.prototype ||
                Object.getPrototypeOf(item) === null,
            "non-JSON prototype",
        );
        ensure(
            Object.getOwnPropertySymbols(item).length === 0,
            "symbol property",
        );
        ancestors.add(item);
        const entries: [string, unknown][] = [];
        for (const key of Object.keys(item)) {
            ensure(!reserved.has(key), "reserved property");
            if (array) {
                ensure(
                    /^(0|[1-9]\d*)$/.test(key) && Number(key) < item.length,
                    "non-JSON array property",
                );
            }
            const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
            ensure("value" in descriptor, "accessor property");
            characters += key.length;
            ensure(characters <= maxBytes, "JSON size exceeded");
            entries.push([key, copy(descriptor.value, depth + 1)]);
        }
        ancestors.delete(item);
        if (array) {
            ensure(entries.length === item.length, "sparse array");
            return entries.map(([, entry]) => entry);
        }
        return Object.fromEntries(entries);
    };
    const result = copy(value, 0);
    ensure(
        new TextEncoder().encode(JSON.stringify(result)).length <=
            maxBytes,
        "JSON size exceeded",
    );
    return result;
}

function ensure(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new TypeError(`Invalid source config schema: ${message}`);
    }
}
