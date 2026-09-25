import { assert, assertEquals, assertFalse } from "@std/assert";
import {
    type FormField,
    type FormValues,
    initialFormValues,
    type SourceConfigSchema,
    validateForm,
} from "@heimdall/admin-contracts/forms.ts";

function schema(...fields: readonly FormField[]): SourceConfigSchema {
    return { version: 1, id: "validation", fields };
}

Deno.test("initial form values drop unknown keys and scrub secrets inside nested groups", () => {
    const definition = schema({
        type: "group",
        id: "connection",
        label: "连接",
        fields: [
            {
                type: "string",
                name: "name",
                label: "名称",
                default: "默认名称",
            },
            {
                type: "group",
                id: "credentials",
                label: "凭据",
                fields: [
                    { type: "secret", name: "apiKey", label: "密钥" },
                    {
                        type: "bool",
                        name: "enabled",
                        label: "启用",
                        default: true,
                    },
                    {
                        type: "number",
                        name: "priority",
                        label: "优先级",
                        default: 0,
                    },
                ],
            },
            {
                type: "string",
                name: "headers",
                label: "请求头",
                format: "string-map",
            },
            {
                type: "authorization",
                name: "login",
                label: "授权",
                action: { id: "authorize" },
            },
        ],
    });
    const saved: FormValues = {
        apiKey: "saved-secret",
        enabled: false,
        headers: { "X-Region": "cn" },
        unknown: { nestedSecret: "never-render" },
        login: "authorization-is-not-a-value",
    };
    const values = initialFormValues(definition, saved);
    assertEquals(values, {
        name: "默认名称",
        apiKey: "",
        enabled: false,
        priority: 0,
        headers: '{\n  "X-Region": "cn"\n}',
    });
    assertEquals(saved.apiKey, "saved-secret");
    assertFalse(JSON.stringify(values).includes("never-render"));
});

Deno.test("inherited properties cannot populate or satisfy a declared field", () => {
    const definition = schema({
        type: "string",
        name: "name",
        label: "名称",
        required: true,
        default: "默认",
    });
    const inherited = Object.create({ name: "inherited-value" }) as FormValues;
    assertEquals(initialFormValues(definition, inherited), { name: "默认" });
    const result = validateForm(definition, inherited);
    assertFalse(result.valid);
    assert(result.errors.name);
    assertEquals(result.values, {});
});

Deno.test("required text trims input and applies length limits while allowing explicit false booleans", () => {
    const definition = schema(
        {
            type: "string",
            name: "name",
            label: "名称",
            required: true,
            minLength: 2,
            maxLength: 5,
        },
        { type: "bool", name: "enabled", label: "启用", required: true },
    );
    const valid = validateForm(definition, {
        name: "  渠道名称  ",
        enabled: false,
        unknown: "discard",
    });
    assertEquals(valid, {
        valid: true,
        values: { name: "渠道名称", enabled: false },
        errors: {},
    });
    for (const name of ["", " \n ", "短", "超过五个字符"]) {
        const invalid = validateForm(definition, { name, enabled: false });
        assertFalse(invalid.valid);
        assert(invalid.errors.name);
        assertEquals(invalid.values.enabled, false);
    }
    for (const enabled of ["false", 0, null]) {
        assert(
            validateForm(definition, { name: "渠道", enabled }).errors.enabled,
        );
    }
});

Deno.test("numeric fields reject invalid numbers and enforce integer and range constraints", () => {
    const definition = schema({
        type: "number",
        name: "priority",
        label: "优先级",
        integer: true,
        min: 0,
        max: 5,
        required: true,
    });
    assertEquals(validateForm(definition, { priority: "3" }).values, {
        priority: 3,
    });
    for (
        const priority of [
            -1,
            6,
            1.5,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            "abc",
            "",
            false,
            Number.MAX_SAFE_INTEGER + 1,
        ]
    ) {
        const result = validateForm(definition, { priority });
        assertFalse(result.valid, `priority=${String(priority)}`);
        assert(result.errors.priority);
    }
    assertEquals(validateForm(definition, { priority: 0 }).valid, true);
    assertEquals(validateForm(definition, { priority: 5 }).valid, true);
});

Deno.test("numeric step validation matches decimal input increments without floating point false failures", () => {
    const half = schema({
        type: "number",
        name: "amount",
        label: "数量",
        min: 0,
        step: 0.5,
    });
    assertEquals(validateForm(half, { amount: 1.5 }).valid, true);
    assertFalse(validateForm(half, { amount: 1.3 }).valid);
    const tenth = schema({
        type: "number",
        name: "amount",
        label: "数量",
        min: 0,
        step: 0.1,
    });
    assertEquals(validateForm(tenth, { amount: 0.3 }).valid, true);
    const offset = schema({
        type: "number",
        name: "amount",
        label: "数量",
        min: 0.2,
        step: 0.5,
    });
    assertEquals(validateForm(offset, { amount: 0.7 }).valid, true);
    assertFalse(validateForm(offset, { amount: 0.5 }).valid);
});

Deno.test("enum fields only accept declared option values", () => {
    const definition = schema({
        type: "enum",
        name: "compat",
        label: "能力",
        required: true,
        options: [{ value: "chat", label: "对话" }, {
            value: "full",
            label: "全部",
        }],
    });
    assertEquals(validateForm(definition, { compat: "chat" }).values, {
        compat: "chat",
    });
    for (const compat of ["", "unknown", "对话", " chat ", true]) {
        assertFalse(validateForm(definition, { compat }).valid);
    }
});

Deno.test("upstream URL fields reject non-HTTP addresses and credentials or query data", () => {
    const definition = schema({
        type: "string",
        name: "baseUrl",
        label: "地址",
        format: "url",
        required: true,
    });
    assertEquals(
        validateForm(definition, { baseUrl: " https://example.com/v1 " })
            .values,
        { baseUrl: "https://example.com/v1" },
    );
    assertEquals(
        validateForm(definition, { baseUrl: "http://localhost:8000/v1" }).valid,
        true,
    );
    for (
        const baseUrl of [
            "/v1",
            "invalid",
            "ftp://example.com",
            "javascript:alert(1)",
            "https://user:secret@example.com",
            "https://example.com?key=secret",
            "https://example.com#secret",
        ]
    ) {
        assertFalse(validateForm(definition, { baseUrl }).valid, baseUrl);
    }
});

Deno.test("string-map fields parse plain string records and reject dangerous keys or non-string values", () => {
    const definition = schema({
        type: "string",
        name: "headers",
        label: "请求头",
        format: "string-map",
    });
    assertEquals(
        validateForm(definition, { headers: '{"X-Region":"cn","X-Empty":""}' })
            .values,
        { headers: { "X-Region": "cn", "X-Empty": "" } },
    );
    assertEquals(validateForm(definition, { headers: "{}" }).valid, true);
    for (
        const headers of [
            "not json",
            "null",
            "[]",
            '"text"',
            '{" ":"bad"}',
            '{"__proto__":"bad"}',
            '{"constructor":"bad"}',
            '{"prototype":"bad"}',
            '{"x":1}',
            '{"x":false}',
            '{"x":null}',
            '{"x":{}}',
            '{"x":[]}',
        ]
    ) {
        const result = validateForm(definition, { headers });
        assertFalse(result.valid, headers);
        assert(result.errors.headers);
        assertEquals(result.values.headers, undefined);
    }
});

Deno.test("blank required secrets preserve saved credentials only during authorized updates", () => {
    const definition = schema({
        type: "secret",
        name: "apiKey",
        label: "密钥",
        required: true,
        minLength: 4,
    });
    assertFalse(validateForm(definition, { apiKey: "" }).valid);
    assertFalse(
        validateForm(definition, {}, { existingSecrets: ["other"] }).valid,
    );
    const retained = validateForm(definition, { apiKey: "  " }, {
        existingSecrets: ["apiKey"],
    });
    assertEquals(retained, { valid: true, values: {}, errors: {} });
    assertEquals(
        validateForm(definition, { apiKey: "  exact-secret  " }).values,
        { apiKey: "  exact-secret  " },
    );
    assertFalse(validateForm(definition, { apiKey: "abc" }).valid);
    const replace = schema({
        type: "secret",
        name: "apiKey",
        label: "密钥",
        required: true,
        preserveOnBlank: false,
    });
    assertFalse(
        validateForm(replace, { apiKey: "" }, { existingSecrets: ["apiKey"] })
            .valid,
    );
});

Deno.test("authorization is validated against host state and contributes no action or client value to payloads", () => {
    const action = {
        id: "authorize",
        params: { provider: "demo", scopes: ["read"] },
    } as const;
    const definition = schema({
        type: "authorization",
        name: "login",
        label: "账户授权",
        required: true,
        action,
    });
    assertEquals(initialFormValues(definition, { login: "fake-success" }), {});
    for (const state of ["idle", "pending", "error"] as const) {
        const result = validateForm(definition, { login: "success" }, {
            authorization: { login: { state } },
        });
        assertFalse(result.valid);
        assert(result.errors.login);
        assertEquals(result.values, {});
    }
    const complete = validateForm(definition, {
        login: "client-value",
        unknown: action,
    }, { authorization: { login: { state: "success" } } });
    assertEquals(complete, { valid: true, values: {}, errors: {} });
    assertEquals(action, JSON.parse(JSON.stringify(action)));
});
