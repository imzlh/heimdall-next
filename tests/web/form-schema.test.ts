import { assertEquals, assertNotStrictEquals, assertThrows } from "@std/assert";
import {
    FORM_SCHEMA_LIMITS,
    parseSourceConfigSchema,
} from "@heimdall/admin-contracts/form-schema.ts";
import type { FormField } from "@heimdall/admin-contracts/forms.ts";

const field = { type: "string", name: "baseUrl", label: "地址" };
const schema = (fields: unknown[] = [field]) => ({
    version: 1,
    id: "demo.source",
    fields,
});

Deno.test("form schema parser accepts JSON-only host controls and detaches nested action data", () => {
    const input = schema([{
        type: "group",
        id: "connection",
        label: "连接",
        fields: [
            { ...field, format: "url", required: true },
            {
                type: "secret",
                name: "key",
                label: "密钥",
                preserveOnBlank: true,
            },
            {
                type: "number",
                name: "limit",
                label: "限额",
                min: 0,
                max: 10,
                integer: true,
                default: 2,
            },
            { type: "bool", name: "enabled", label: "启用", default: false },
            {
                type: "enum",
                name: "region",
                label: "区域",
                default: "cn",
                options: [{ value: "cn", label: "中国" }],
            },
            {
                type: "authorization",
                name: "auth",
                label: "授权",
                action: {
                    id: "source.authorize",
                    params: {
                        source: "demo",
                        scopes: ["models"],
                        metadata: { optional: null },
                    },
                },
            },
        ],
    }]);
    const parsed = parseSourceConfigSchema(input);
    assertEquals<unknown>(parsed, input);
    assertNotStrictEquals<unknown>(parsed, input);
    assertNotStrictEquals<unknown>(parsed.fields, input.fields);
    assertNotStrictEquals(parsed.fields[0], input.fields[0]);
});

Deno.test("form schema parser rejects executable controls and sensitive defaults", () => {
    for (
        const invalid of [
            { ...schema(), version: 2 },
            { ...schema(), html: "<script>" },
            schema([{ ...field, render: "custom.js" }]),
            schema([{ ...field, type: "html" }]),
            schema([{
                type: "secret",
                name: "key",
                label: "密钥",
                default: "saved-secret",
            }]),
            schema([{
                type: "authorization",
                name: "auth",
                label: "授权",
                action: { id: "login", url: "https://example.test" },
            }]),
            schema([{
                type: "authorization",
                name: "auth",
                label: "授权",
                action: { id: "https://example.test" },
            }]),
        ]
    ) assertThrows(() => parseSourceConfigSchema(invalid), TypeError);
});

Deno.test("form schema parser rejects invalid constraints and defaults", () => {
    for (
        const invalid of [
            { ...field, required: "yes" },
            { ...field, minLength: 5, maxLength: 2 },
            { ...field, minLength: -1 },
            { ...field, maxLength: 1.5 },
            { ...field, format: "javascript" },
            { ...field, format: "url", default: "javascript:alert(1)" },
            { ...field, type: "bool", default: "true" },
            { ...field, type: "number", min: 5, max: 2 },
            { ...field, type: "number", step: 0 },
            { ...field, type: "number", integer: true, default: 1.5 },
            { ...field, type: "number", min: 0, step: 0.5, default: 1.3 },
            { ...field, type: "enum", options: [] },
            {
                ...field,
                type: "enum",
                default: "missing",
                options: [{ value: "one", label: "一" }],
            },
            {
                ...field,
                type: "enum",
                options: [{ value: "one", label: "一" }, {
                    value: "one",
                    label: "重复",
                }],
            },
        ]
    ) assertThrows(() => parseSourceConfigSchema(schema([invalid])), TypeError);
});

Deno.test("form schema parser rejects duplicate and reserved names across groups", () => {
    const group = {
        type: "group",
        id: "group",
        label: "分组",
        fields: [field],
    };
    for (
        const invalid of [
            schema([field, group]),
            schema([{ ...group, fields: [] }, { ...group, fields: [] }]),
            ...["__proto__", "constructor", "prototype"].map((name) =>
                schema([{ ...field, name }])
            ),
        ]
    ) assertThrows(() => parseSourceConfigSchema(invalid), TypeError);
});

Deno.test("form schema parser rejects non-JSON values without invoking accessors", () => {
    let calls = 0;
    const accessor = {
        ...field,
        get help() {
            calls++;
            return "do not execute";
        },
    };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (
        const value of [
            undefined,
            () => {},
            NaN,
            Infinity,
            new Date(),
            cycle,
            Object.create({ unsafe: true }),
        ]
    ) {
        assertThrows(() =>
            parseSourceConfigSchema(schema([{
                type: "authorization",
                name: "auth",
                label: "授权",
                action: { id: "authorize", params: { value } },
            }])), TypeError);
    }
    assertThrows(() => parseSourceConfigSchema(schema([accessor])), TypeError);
    assertEquals(calls, 0);
    const polluted = JSON.parse('{"__proto__":{"polluted":true}}');
    assertThrows(() =>
        parseSourceConfigSchema(schema([{
            type: "authorization",
            name: "auth",
            label: "授权",
            action: { id: "authorize", params: polluted },
        }])), TypeError);
});

Deno.test("form schema parser bounds total fields, nested groups and UTF-8 size", () => {
    const many = Array.from(
        { length: FORM_SCHEMA_LIMITS.fields },
        (_, index) => ({ ...field, name: `field_${index}` }),
    );
    assertEquals(parseSourceConfigSchema(schema(many)).fields.length, 128);
    assertThrows(
        () =>
            parseSourceConfigSchema(
                schema([...many, { ...field, name: "overflow" }]),
            ),
        TypeError,
    );
    let nested: FormField = { type: "string", name: "value", label: "值" };
    for (let depth = 0; depth < FORM_SCHEMA_LIMITS.groupDepth; depth++) {
        nested = {
            type: "group",
            id: `group_${depth}`,
            label: "分组",
            fields: [nested],
        };
    }
    parseSourceConfigSchema(schema([nested]));
    assertThrows(
        () =>
            parseSourceConfigSchema(
                schema([{
                    type: "group",
                    id: "overflow",
                    label: "分组",
                    fields: [nested],
                }]),
            ),
        TypeError,
    );
    assertThrows(
        () =>
            parseSourceConfigSchema(
                schema(
                    many.map((item) => ({ ...item, help: "文".repeat(200) })),
                ),
            ),
        TypeError,
    );
});
