import { parseSourceConfigSchema } from "./form-schema.ts";
import type { SourceConfigSchema } from "./forms.ts";
import {
    parseUiContributions,
    safeUiAssetPath,
    type UiContribution,
} from "./ui.ts";

/** A complete, replaceable snapshot of the host's active plugin UI metadata. */
export interface UiCatalog {
    readonly contributions: readonly UiContribution[];
    readonly schemas: Readonly<Record<string, SourceConfigSchema>>;
    readonly sourcePluginIds: Readonly<Record<string, string>>;
    /** Host-approved preset modules. Values are canonical self-hosted asset paths. */
    readonly presetPages: Readonly<Record<string, string>>;
}

export const UI_CATALOG_LIMITS = {
    bytes: 4_194_304,
    schemas: 128,
    sources: 4096,
    presetPages: 128,
} as const;

export const EMPTY_UI_CATALOG: UiCatalog = Object.freeze({
    contributions: Object.freeze([]),
    schemas: Object.freeze({}),
    sourcePluginIds: Object.freeze({}),
    presetPages: Object.freeze({}),
});

const reserved = new Set(["__proto__", "constructor", "prototype"]);
// Matches the plugin manifest ID contract: lower-case ASCII, alphanumeric ends.
const pluginId = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;

/** Validate both transport and nested contracts before replacing a live catalog. */
export function parseUiCatalog(value: unknown): UiCatalog {
    const input = record(copyJson(value));
    ensure(
        Object.keys(input).every((key) =>
            ["contributions", "schemas", "sourcePluginIds", "presetPages"]
                .includes(key)
        ) &&
            ["contributions", "schemas", "sourcePluginIds"].every((key) =>
                Object.hasOwn(input, key)
            ),
        "expected contributions, schemas, sourcePluginIds and optional presetPages",
    );
    const schemaEntries = Object.entries(record(input.schemas));
    ensure(
        schemaEntries.length <= UI_CATALOG_LIMITS.schemas,
        "schema limit exceeded",
    );
    const schemas = Object.fromEntries(schemaEntries.map(([key, schema]) => {
        const parsed = parseSourceConfigSchema(schema);
        ensure(key === parsed.id, "schema key must match its id");
        return [key, parsed];
    }));
    const sourceEntries = Object.entries(record(input.sourcePluginIds));
    ensure(
        sourceEntries.length <= UI_CATALOG_LIMITS.sources,
        "source ownership limit exceeded",
    );
    const sourcePluginIds = Object.fromEntries(
        sourceEntries.map(([sourceId, owner]) => {
            ensure(
                sourceId.trim().length > 0 && sourceId.length <= 256 &&
                    !reserved.has(sourceId),
                "invalid source id",
            );
            ensure(
                typeof owner === "string" && pluginId.test(owner),
                "invalid source plugin id",
            );
            return [sourceId, owner as string];
        }),
    );
    // Older SSR boots and catalog responses did not include preset modules.
    const presetEntries = Object.entries(
        Object.hasOwn(input, "presetPages") ? record(input.presetPages) : {},
    );
    ensure(
        presetEntries.length <= UI_CATALOG_LIMITS.presetPages,
        "preset module limit exceeded",
    );
    const presetPages = Object.fromEntries(presetEntries.map(([id, path]) => {
        ensure(pluginId.test(id), "invalid preset plugin id");
        ensure(safeUiAssetPath(path, "js"), "invalid preset module path");
        return [id, path];
    }));
    return {
        contributions: parseUiContributions(input.contributions),
        schemas,
        sourcePluginIds,
        presetPages,
    };
}

/** Copy descriptors, never getters/toJSON. Charge exact serialized UTF-8 bytes. */
function copyJson(value: unknown): unknown {
    const encoder = new TextEncoder();
    const ancestors = new Set<object>();
    let remaining: number = UI_CATALOG_LIMITS.bytes;
    const charge = (size: number): void => {
        remaining -= size;
        ensure(remaining >= 0, "JSON size limit exceeded");
    };
    const string = (item: string): string => {
        // UTF-8 JSON is never shorter than the source's UTF-16 code unit count.
        ensure(item.length <= remaining, "JSON size limit exceeded");
        charge(encoder.encode(JSON.stringify(item)).length);
        return item;
    };
    const copy = (item: unknown, depth: number): unknown => {
        ensure(depth <= 32, "JSON nesting limit exceeded");
        if (typeof item === "string") return string(item);
        if (item === null || typeof item === "boolean") {
            charge(item === null || item === true ? 4 : 5);
            return item;
        }
        if (typeof item === "number") {
            ensure(Number.isFinite(item), "non-finite number");
            charge(JSON.stringify(item).length);
            return item;
        }
        ensure(typeof item === "object", "non-JSON value");
        ensure(!ancestors.has(item), "cyclic JSON value");
        const array = Array.isArray(item);
        const prototype = Object.getPrototypeOf(item);
        ensure(
            array
                ? prototype === Array.prototype
                : prototype === Object.prototype || prototype === null,
            "non-JSON prototype",
        );
        const keys = Reflect.ownKeys(item);
        charge(2); // Object braces or array brackets.
        ancestors.add(item);
        const entries: [string, unknown][] = [];
        const length = array
            ? Object.getOwnPropertyDescriptor(item, "length")!.value as number
            : 0;
        for (const key of keys) {
            ensure(typeof key === "string", "symbol property");
            if (array && key === "length") continue;
            const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
            ensure(
                "value" in descriptor && descriptor.enumerable,
                "accessor or non-enumerable property",
            );
            ensure(!reserved.has(key), "reserved property");
            if (entries.length > 0) charge(1); // Comma.
            if (array) {
                ensure(
                    key === String(entries.length),
                    "sparse array or non-JSON array property",
                );
            } else {
                string(key);
                charge(1); // Colon.
            }
            entries.push([key, copy(descriptor.value, depth + 1)]);
        }
        ancestors.delete(item);
        if (array) {
            ensure(entries.length === length, "sparse array");
            return entries.map(([, entry]) => entry);
        }
        return Object.fromEntries(entries);
    };
    return copy(value, 0);
}

function record(value: unknown): Record<string, unknown> {
    ensure(
        value !== null && typeof value === "object" && !Array.isArray(value),
        "expected an object",
    );
    return value as Record<string, unknown>;
}

function ensure(condition: unknown, message: string): asserts condition {
    if (!condition) throw new TypeError(`Invalid UI catalog: ${message}`);
}
