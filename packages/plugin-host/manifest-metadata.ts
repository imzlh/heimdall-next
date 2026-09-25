import type {
    JsonObject,
    JsonValue,
    PluginManifest,
} from "../contracts/mod.ts";
import { fail } from "./verification-errors.ts";

interface MetadataBudget {
    bytes: number;
    nodes: number;
    readonly seen: WeakSet<object>;
}

function metadataSize(budget: MetadataBudget, bytes: number): void {
    budget.bytes -= bytes;
    if (budget.bytes < 0) {
        fail("invalid_manifest", "manifest UI metadata exceeds 64 KiB");
    }
}

function metadataText(value: string, budget: MetadataBudget): void {
    if (value.length > budget.bytes) {
        fail("invalid_manifest", "manifest UI metadata exceeds 64 KiB");
    }
    metadataSize(
        budget,
        new TextEncoder().encode(JSON.stringify(value)).length,
    );
}

/** Clone data descriptors directly; never invoke a metadata getter or toJSON. */
function metadataJson(
    value: unknown,
    budget: MetadataBudget,
    depth = 0,
): JsonValue {
    // Eight nested schema groups require more than sixteen JSON containers.
    if (--budget.nodes < 0 || depth > 32) {
        fail(
            "invalid_manifest",
            "manifest UI metadata exceeds structural limits",
        );
    }
    if (value === null || typeof value === "boolean") {
        metadataSize(budget, value === null || value === true ? 4 : 5);
        return value;
    }
    if (typeof value === "string") {
        metadataText(value, budget);
        return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        metadataSize(budget, JSON.stringify(value).length);
        return value;
    }
    if (typeof value !== "object" || value === null) {
        fail(
            "invalid_manifest",
            "manifest UI metadata must contain only JSON values",
        );
    }
    if (budget.seen.has(value)) {
        fail("invalid_manifest", "manifest UI metadata must be a JSON tree");
    }
    budget.seen.add(value);
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
        array
            ? prototype !== Array.prototype
            : prototype !== Object.prototype && prototype !== null
    ) {
        fail(
            "invalid_manifest",
            "manifest UI metadata must use plain JSON objects",
        );
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > budget.nodes + (array ? 1 : 0)) {
        fail(
            "invalid_manifest",
            "manifest UI metadata exceeds structural limits",
        );
    }
    if (
        array &&
        (value.length > budget.nodes || keys.length !== value.length + 1)
    ) {
        fail(
            "invalid_manifest",
            "manifest UI metadata arrays must be dense JSON arrays",
        );
    }
    const result: Record<string, JsonValue> = {};
    const items: JsonValue[] = [];
    metadataSize(budget, 2);
    let index = 0;
    for (const key of keys) {
        if (array && key === "length") continue;
        if (
            typeof key !== "string" ||
            ["__proto__", "constructor", "prototype"].includes(key)
        ) {
            fail(
                "invalid_manifest",
                "manifest UI metadata contains an unsafe key",
            );
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            fail(
                "invalid_manifest",
                "manifest UI metadata must use enumerable data properties",
            );
        }
        if (index > 0) metadataSize(budget, 1);
        if (array) {
            if (key !== String(index)) {
                fail(
                    "invalid_manifest",
                    "manifest UI metadata arrays must use consecutive indices",
                );
            }
            items.push(metadataJson(descriptor.value, budget, depth + 1));
        } else {
            metadataText(key, budget);
            metadataSize(budget, 1);
            result[key] = metadataJson(descriptor.value, budget, depth + 1);
        }
        index++;
    }
    // HIP JSON arrays are mutable in the type vocabulary; normalized metadata is frozen.
    return array
        ? Object.freeze(items) as unknown as JsonValue
        : Object.freeze(result);
}

export function validateUiMetadata(
    input: Record<string, unknown>,
): Pick<PluginManifest, "ui" | "configSchema" | "presetPage"> {
    const budget: MetadataBudget = {
        bytes: 65_536 - 2,
        nodes: 4096,
        seen: new WeakSet(),
    };
    let ui: readonly JsonObject[] | undefined;
    let configSchema: JsonObject | undefined;
    let presetPage: PluginManifest["presetPage"];
    if (input.ui !== undefined) {
        metadataSize(budget, 5); // "ui":
        const value = metadataJson(input.ui, budget);
        if (
            !Array.isArray(value) ||
            value.some((item) =>
                item === null || typeof item !== "object" || Array.isArray(item)
            )
        ) {
            fail(
                "invalid_manifest",
                "manifest.ui must be an array of JSON objects",
            );
        }
        ui = value as readonly JsonObject[];
    }
    if (input.configSchema !== undefined) {
        metadataSize(budget, 15 + (ui === undefined ? 0 : 1)); // "configSchema":
        const value = metadataJson(input.configSchema, budget);
        if (
            value === null || typeof value !== "object" || Array.isArray(value)
        ) {
            fail(
                "invalid_manifest",
                "manifest.configSchema must be a JSON object",
            );
        }
        configSchema = value;
    }
    if (input.presetPage !== undefined) {
        if (input.kind !== "preset") {
            fail(
                "invalid_manifest",
                "manifest.presetPage requires preset kind",
            );
        }
        metadataSize(budget, 13 + (ui || configSchema ? 1 : 0)); // "presetPage":
        const value = metadataJson(input.presetPage, budget);
        if (
            value === null || typeof value !== "object" ||
            Array.isArray(value) ||
            Object.keys(value).length !== 1 ||
            typeof value.modulePath !== "string" ||
            value.modulePath.length > 256 ||
            !/^\/admin\/assets\/plugins\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.js$/
                .test(value.modulePath)
        ) {
            fail(
                "invalid_manifest",
                "manifest.presetPage requires one self-hosted modulePath",
            );
        }
        presetPage = value as { readonly modulePath: string };
    }
    return {
        ...(ui === undefined ? {} : { ui }),
        ...(configSchema === undefined ? {} : { configSchema }),
        ...(presetPage === undefined ? {} : { presetPage }),
    };
}
