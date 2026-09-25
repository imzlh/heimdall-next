import { assert, assertEquals, assertThrows } from "@std/assert";
import { validatePluginManifest } from "@heimdall/plugin-host/manifest.ts";
import { PluginVerificationError } from "@heimdall/plugin-host";
import openai from "../plugins/openai-source/manifest.json" with {
    type: "json",
};
import anthropic from "../plugins/anthropic-source/manifest.json" with {
    type: "json",
};
import newapi from "../plugins/newapi-preset/manifest.json" with {
    type: "json",
};

function manifest(
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        id: "test.ui",
        version: "1.0.0",
        apiVersion: "1",
        name: "UI metadata",
        kind: "source",
        ...extra,
    };
}

function rejected(input: unknown): void {
    const error = assertThrows(
        () => validatePluginManifest(input),
        PluginVerificationError,
    );
    assertEquals(error.code, "invalid_manifest");
}

function frozenTree(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    assert(Object.isFrozen(value));
    for (const child of Object.values(value)) frozenTree(child);
}

Deno.test("manifest UI and config metadata survive normalization as detached deeply frozen JSON", () => {
    const widget = {
        title: "概览",
        slot: "dashboard.widget",
        schema: { count: 0, ready: true, note: null, tags: ["中文"] },
    };
    const field = { type: "secret", name: "apiKey" };
    const configSchema = { version: 1, fields: [field] };
    const ui = [widget];
    const result = validatePluginManifest(manifest({ ui, configSchema }));
    assertEquals(result.ui, ui);
    assertEquals(result.configSchema, configSchema);
    assert(result.ui !== ui);
    assert(result.configSchema !== configSchema);
    frozenTree(result);
    widget.title = "修改后的标题";
    widget.schema.tags.push("new");
    field.name = "changed";
    assertEquals(result.ui?.[0]?.title, "概览");
    assertEquals(result.configSchema?.fields, [{
        type: "secret",
        name: "apiKey",
    }]);
    assertThrows(() => {
        (result.configSchema as Record<string, unknown>).fields = [];
    }, TypeError);
});

Deno.test("actual built-in source and preset JSON manifests preserve their frozen config declarations", () => {
    for (const input of [openai, anthropic, newapi]) {
        const result = validatePluginManifest(input);
        assertEquals(result.id, input.id);
        assertEquals<unknown>(result.configSchema, input.configSchema);
        assert(result.configSchema !== input.configSchema);
        frozenTree(result.configSchema);
    }
});

Deno.test("manifest accepts only declared top-level keys and correct JSON metadata containers", () => {
    rejected(manifest({ unknownSetting: true }));
    for (const ui of [{}, null, ["text"], [null], [[]]]) {
        rejected(manifest({ ui }));
    }
    for (const configSchema of [null, [], "schema", true]) {
        rejected(manifest({ configSchema }));
    }
    const result = validatePluginManifest(
        manifest({ ui: [], configSchema: {} }),
    );
    assertEquals(result.ui, []);
    assertEquals(result.configSchema, {});
});

Deno.test("metadata accessors and toJSON functions are rejected without executing user code", () => {
    let executions = 0;
    for (const key of ["ui", "configSchema"]) {
        const top = manifest();
        Object.defineProperty(top, key, {
            enumerable: true,
            get() {
                executions++;
                return {};
            },
        });
        rejected(top);
    }
    const nested = Object.defineProperty({}, "title", {
        enumerable: true,
        get() {
            executions++;
            return "executed";
        },
    });
    rejected(manifest({ ui: [nested] }));
    rejected(manifest({ configSchema: { fields: [nested] } }));
    const executable = {
        toJSON() {
            executions++;
            return {};
        },
    };
    rejected(manifest({ configSchema: executable }));
    for (
        const value of [
            () => {
                executions++;
            },
            undefined,
            Symbol("value"),
            1n,
            NaN,
            Infinity,
        ]
    ) {
        rejected(manifest({ configSchema: { value } }));
    }
    assertEquals(executions, 0);
});

Deno.test("metadata rejects custom prototypes and unsafe JSON property names", () => {
    const custom = Object.create({ inherited: "value" });
    rejected(Object.assign(custom, manifest()));
    for (
        const value of [
            new Date(),
            new Map(),
            Object.create({ inherited: true }),
        ]
    ) {
        rejected(manifest({ configSchema: { value } }));
    }
    const customArray = Object.setPrototypeOf(
        [],
        Object.create(Array.prototype),
    );
    rejected(manifest({ ui: customArray }));
    for (const key of ["__proto__", "constructor", "prototype"]) {
        const unsafe = Object.fromEntries([[key, "unsafe"]]);
        rejected(manifest(unsafe));
        rejected(manifest({ configSchema: { nested: unsafe } }));
    }
    assertEquals(
        validatePluginManifest(manifest({ configSchema: Object.create(null) }))
            .configSchema,
        {},
    );
});

Deno.test("metadata rejects hidden or symbolic properties and sparse or decorated arrays", () => {
    const hidden = Object.defineProperty({}, "hidden", {
        value: "not JSON",
        enumerable: false,
    });
    rejected(manifest({ configSchema: hidden }));
    const top = manifest();
    Object.defineProperty(top, "ui", { value: [], enumerable: false });
    rejected(top);
    const symbolic = { [Symbol("hidden")]: "not JSON" };
    rejected(manifest({ configSchema: symbolic }));
    rejected(Object.assign(manifest(), symbolic));
    const sparse = new Array(2);
    sparse[1] = {};
    const decorated = Object.assign([{}], { named: true });
    for (const values of [sparse, decorated]) {
        rejected(manifest({ ui: values }));
    }
});

Deno.test("metadata enforces one 64 KiB UTF-8 budget across UI and configuration JSON", () => {
    const encoded = (value: unknown) =>
        new TextEncoder().encode(JSON.stringify(value)).length;
    const available = 65_536 - encoded({ configSchema: { text: "" } });
    const exact = { configSchema: { text: "x".repeat(available) } };
    assertEquals(encoded(exact), 65_536);
    validatePluginManifest(manifest(exact));
    rejected(manifest({ configSchema: { text: "x".repeat(available + 1) } }));
    const ui = [{ title: "界".repeat(11_000) }];
    const configSchema = { title: "界".repeat(11_000) };
    validatePluginManifest(manifest({ ui }));
    validatePluginManifest(manifest({ configSchema }));
    assert(encoded({ ui, configSchema }) > 65_536);
    rejected(manifest({ ui, configSchema }));
});

Deno.test("metadata admits the form contract's eight nested groups", () => {
    let field: Record<string, unknown> = {
        type: "string",
        name: "endpoint",
        label: "地址",
    };
    for (let index = 0; index < 8; index++) {
        field = {
            type: "group",
            id: `group-${index}`,
            label: "分组",
            fields: [field],
        };
    }
    const configSchema = { version: 1, id: "nested-form", fields: [field] };
    const result = validatePluginManifest(manifest({ configSchema }));
    assertEquals<unknown>(result.configSchema, configSchema);
    frozenTree(result.configSchema);
});

Deno.test("metadata rejects structural resource exhaustion, cycles and repeated-reference graphs", () => {
    rejected(manifest({ configSchema: { values: Array(4096).fill(null) } }));
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 40; index++) deep = { nested: deep };
    rejected(manifest({ configSchema: deep }));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    rejected(manifest({ configSchema: cyclic }));
    const shared = { title: "shared" };
    rejected(manifest({ ui: [shared], configSchema: shared }));
    rejected(manifest({ configSchema: { first: shared, second: shared } }));
    let graph: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 24; index++) {
        graph = { first: graph, second: graph };
    }
    rejected(manifest({ configSchema: graph }));
});
