import { copyFormJson } from "./form-json.ts";
import {
    type FormField,
    type SourceConfigSchema,
    validateForm,
} from "./forms.ts";

export const FORM_SCHEMA_LIMITS = {
    fields: 128,
    groupDepth: 8,
    bytes: 64 * 1024,
    options: 128,
} as const;

const reserved = new Set(["__proto__", "prototype", "constructor"]);
const identifier = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
const common = ["type", "name", "label", "help", "required", "readOnly"];
const properties: Record<string, readonly string[]> = {
    string: [
        "default",
        "placeholder",
        "multiline",
        "minLength",
        "maxLength",
        "format",
    ],
    secret: ["minLength", "maxLength", "preserveOnBlank"],
    number: ["default", "min", "max", "integer", "step"],
    bool: ["default"],
    enum: ["default", "options"],
    authorization: ["buttonLabel", "action"],
};

/** Validate untrusted manifest data before rendering. Returns a detached JSON copy. */
export function parseSourceConfigSchema(value: unknown): SourceConfigSchema {
    const copy = copyFormJson(value, FORM_SCHEMA_LIMITS.bytes);
    const schema = record(copy);
    onlyKeys(schema, ["version", "id", "title", "fields"]);
    ensure(
        schema.version === 1 && validId(schema.id),
        "unsupported version or id",
    );
    optionalText(schema, "title", 512);
    const names = new Set<string>();
    const groups = new Set<string>();
    let count = 0;
    const fields = (input: unknown, depth: number): void => {
        ensure(Array.isArray(input), "fields must be an array");
        ensure(depth <= FORM_SCHEMA_LIMITS.groupDepth, "group depth exceeded");
        for (const item of input as unknown[]) {
            ensure(
                ++count <= FORM_SCHEMA_LIMITS.fields,
                "field limit exceeded",
            );
            const field = record(item);
            ensure(text(field.label, 512), "field label is required");
            optionalText(field, "help");
            if (field.type === "group") {
                onlyKeys(field, ["type", "id", "label", "help", "fields"]);
                ensure(
                    validId(field.id) && !groups.has(field.id),
                    "invalid or duplicate group id",
                );
                groups.add(field.id as string);
                fields(field.fields, depth + 1);
                continue;
            }
            ensure(
                typeof field.type === "string" &&
                    Object.hasOwn(properties, field.type),
                "unknown field type",
            );
            onlyKeys(field, [...common, ...properties[field.type as string]!]);
            ensure(
                validId(field.name) && !names.has(field.name),
                "invalid or duplicate field name",
            );
            names.add(field.name as string);
            optionalBoolean(field, "required");
            optionalBoolean(field, "readOnly");
            checkField(field);
        }
    };
    fields(schema.fields, 0);
    return schema as unknown as SourceConfigSchema;
}

function checkField(field: Record<string, unknown>): void {
    switch (field.type) {
        case "string":
            optionalText(field, "default", 4096, true);
            optionalText(field, "placeholder", 512, true);
            optionalBoolean(field, "multiline");
            ensure(
                field.format === undefined ||
                    ["url", "string-map"].includes(field.format as string),
                "invalid string format",
            );
            checkLengths(field);
            break;
        case "secret":
            optionalBoolean(field, "preserveOnBlank");
            checkLengths(field);
            break;
        case "number":
            for (const key of ["default", "min", "max", "step"]) {
                optionalNumber(field, key);
            }
            optionalBoolean(field, "integer");
            ensure(
                field.step === undefined || (field.step as number) > 0,
                "step must be positive",
            );
            ensure(
                field.min === undefined || field.max === undefined ||
                    (field.min as number) <= (field.max as number),
                "invalid number range",
            );
            break;
        case "bool":
            optionalBoolean(field, "default");
            break;
        case "enum": {
            optionalText(field, "default", 512, true);
            ensure(
                Array.isArray(field.options) && field.options.length > 0 &&
                    field.options.length <= FORM_SCHEMA_LIMITS.options,
                "invalid enum options",
            );
            const values = new Set<string>();
            for (const item of field.options as unknown[]) {
                const option = record(item);
                onlyKeys(option, ["value", "label"]);
                ensure(
                    text(option.value, 512) && text(option.label, 512) &&
                        !values.has(option.value as string),
                    "invalid or duplicate enum option",
                );
                values.add(option.value as string);
            }
            break;
        }
        case "authorization": {
            optionalText(field, "buttonLabel", 512);
            const action = record(field.action);
            onlyKeys(action, ["id", "params"]);
            ensure(validId(action.id), "invalid action id");
            if (action.params !== undefined) record(action.params);
            break;
        }
    }
    // A declaration must not initialize controls with values its own rules reject.
    if (field.default !== undefined && field.default !== "") {
        const checked = validateForm({
            version: 1,
            id: "default",
            fields: [field as unknown as FormField],
        }, {
            [field.name as string]: field.default as string | number | boolean,
        });
        ensure(checked.valid, "default value violates field constraints");
    }
}

function checkLengths(field: Record<string, unknown>): void {
    for (const key of ["minLength", "maxLength"]) {
        optionalNumber(field, key);
        ensure(
            field[key] === undefined ||
                (Number.isSafeInteger(field[key]) &&
                    (field[key] as number) >= 0),
            "invalid text length",
        );
    }
    ensure(
        field.minLength === undefined || field.maxLength === undefined ||
            (field.minLength as number) <= (field.maxLength as number),
        "invalid text length range",
    );
}

function record(value: unknown): Record<string, unknown> {
    ensure(
        value !== null && typeof value === "object" && !Array.isArray(value),
        "expected an object",
    );
    return value as Record<string, unknown>;
}

function onlyKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
): void {
    ensure(
        Object.keys(value).every((key) => allowed.includes(key)),
        "unsupported property",
    );
}

function text(value: unknown, max = 4096, empty = false): value is string {
    return typeof value === "string" && value.length <= max &&
        (empty || value.trim().length > 0);
}

function validId(value: unknown): value is string {
    return typeof value === "string" && identifier.test(value) &&
        !reserved.has(value);
}

function optionalText(
    value: Record<string, unknown>,
    key: string,
    max = 4096,
    empty = false,
): void {
    ensure(
        value[key] === undefined || text(value[key], max, empty),
        `invalid ${key}`,
    );
}

function optionalBoolean(value: Record<string, unknown>, key: string): void {
    ensure(
        value[key] === undefined || typeof value[key] === "boolean",
        `invalid ${key}`,
    );
}

function optionalNumber(value: Record<string, unknown>, key: string): void {
    ensure(
        value[key] === undefined ||
            (typeof value[key] === "number" && Number.isFinite(value[key])),
        `invalid ${key}`,
    );
}

function ensure(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new TypeError(`Invalid source config schema: ${message}`);
    }
}
