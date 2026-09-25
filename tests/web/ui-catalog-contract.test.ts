import {
    assert,
    assertEquals,
    assertNotStrictEquals,
    assertThrows,
} from "@std/assert";
import {
    EMPTY_UI_CATALOG,
    parseUiCatalog,
    UI_CATALOG_LIMITS,
} from "@heimdall/admin-contracts/ui-catalog.ts";

const contribution = () => ({
    pluginId: "demo.source",
    id: "health",
    slot: "dashboard.widget",
    title: "运行状态",
    schema: { blocks: [{ kind: "text", text: "已连接" }] },
});
const schema = (id = "demo.source") => ({
    version: 1,
    id,
    fields: [{ type: "string", name: "baseUrl", label: "地址" }],
});
const catalog = () => ({
    contributions: [contribution()],
    schemas: { "demo.source": schema() },
    sourcePluginIds: { "上游 / 自定义源": "demo.source" },
    presetPages: { "demo.preset": "/admin/assets/plugins/demo/setup.js" },
});

Deno.test("UI catalog accepts a detached snapshot and an immutable empty catalog", () => {
    const input = catalog();
    const parsed = parseUiCatalog(input);
    assertEquals<unknown>(parsed, input);
    assertNotStrictEquals<unknown>(parsed, input);
    assertNotStrictEquals<unknown>(parsed.schemas, input.schemas);
    assertNotStrictEquals<unknown>(parsed.presetPages, input.presetPages);
    input.contributions[0]!.schema.blocks[0]!.text = "changed";
    input.schemas["demo.source"].fields[0]!.label = "changed";
    input.sourcePluginIds["上游 / 自定义源"] = "changed";
    input.presetPages["demo.preset"] = "/admin/assets/plugins/demo/changed.js";
    assertEquals(parsed.contributions[0]!.schema.blocks[0], {
        kind: "text",
        text: "已连接",
    });
    assertEquals(parsed.schemas["demo.source"]!.fields[0]!.label, "地址");
    assertEquals(parsed.sourcePluginIds["上游 / 自定义源"], "demo.source");
    assertEquals(
        parsed.presetPages["demo.preset"],
        "/admin/assets/plugins/demo/setup.js",
    );
    assertEquals(parseUiCatalog(EMPTY_UI_CATALOG), EMPTY_UI_CATALOG);
    for (
        const value of [EMPTY_UI_CATALOG, ...Object.values(EMPTY_UI_CATALOG)]
    ) {
        assert(Object.isFrozen(value));
    }
});

Deno.test("UI catalog accepts old envelopes and clears absent preset modules", () => {
    const { contributions, schemas, sourcePluginIds } = catalog();
    assertEquals(
        parseUiCatalog({ contributions, schemas, sourcePluginIds }).presetPages,
        {},
    );
});

Deno.test("UI catalog rejects partial envelopes and invalid nested contracts", () => {
    for (
        const value of [
            null,
            [],
            {},
            { contributions: [], schemas: {} },
            { ...catalog(), unknown: true },
            { ...catalog(), schemas: [] },
            { ...catalog(), sourcePluginIds: [] },
            { ...catalog(), presetPages: [] },
            { ...catalog(), presetPages: null },
            { ...catalog(), contributions: [contribution(), contribution()] },
            {
                ...catalog(),
                contributions: [{ ...contribution(), slot: "unknown.slot" }],
            },
            { ...catalog(), schemas: { "wrong.source": schema() } },
            {
                ...catalog(),
                schemas: {
                    "demo.source": {
                        ...schema(),
                        fields: [{
                            type: "secret",
                            name: "key",
                            label: "密钥",
                            default: "must-not-leak",
                        }],
                    },
                },
            },
        ]
    ) assertThrows(() => parseUiCatalog(value), TypeError);
});

Deno.test("UI catalog rejects accessors at every boundary without executing them", () => {
    let calls = 0;
    const getter = () => {
        calls++;
        return "do not execute";
    };
    for (const enumerable of [true, false]) {
        const root = catalog();
        Object.defineProperty(root, "contributions", {
            get: getter,
            enumerable,
        });
        const nested = catalog();
        Object.defineProperty(
            nested.contributions[0]!.schema.blocks[0],
            "text",
            {
                get: getter,
                enumerable,
            },
        );
        const ownership = catalog();
        Object.defineProperty(ownership.sourcePluginIds, "extra", {
            get: getter,
            enumerable,
        });
        const presets = catalog();
        Object.defineProperty(presets.presetPages, "extra", {
            get: getter,
            enumerable,
        });
        for (const value of [root, nested, ownership, presets]) {
            assertThrows(() => parseUiCatalog(value), TypeError);
        }
    }
    const toJSON = { ...catalog(), toJSON: getter };
    assertThrows(() => parseUiCatalog(toJSON), TypeError);
    assertEquals(calls, 0);
});

Deno.test("UI catalog rejects non-JSON graphs and reserved properties", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse = new Array(2);
    sparse[1] = contribution();
    const extraArrayProperty = Object.assign([contribution()], { extra: true });
    const symbolProperty = { [Symbol("hidden")]: true };
    const hiddenProperty = Object.defineProperty({}, "hidden", { value: true });
    class ArraySubclass extends Array {}
    for (
        const value of [
            undefined,
            () => {},
            1n,
            NaN,
            Infinity,
            new Date(),
            new Map(),
            Object.create({ inherited: true }),
            new ArraySubclass(),
            cycle,
            sparse,
            extraArrayProperty,
            symbolProperty,
            hiddenProperty,
            JSON.parse('{"__proto__":{"polluted":true}}'),
        ]
    ) {
        assertThrows(
            () => parseUiCatalog({ ...catalog(), sourcePluginIds: value }),
            TypeError,
        );
    }
    const nullPrototype = Object.assign(Object.create(null), catalog());
    assertEquals(parseUiCatalog(nullPrototype), parseUiCatalog(catalog()));
});

Deno.test("UI catalog preserves custom source IDs and validates plugin ownership IDs", () => {
    const parseOwner = (sourceId: string, owner: unknown) =>
        parseUiCatalog({
            ...EMPTY_UI_CATALOG,
            sourcePluginIds: Object.fromEntries([[sourceId, owner]]),
        });
    assertEquals(
        parseOwner("源".repeat(256), "a".repeat(128)).sourcePluginIds[
            "源".repeat(256)
        ],
        "a".repeat(128),
    );
    for (
        const sourceId of [
            "",
            " ",
            "源".repeat(257),
            "__proto__",
            "constructor",
            "prototype",
        ]
    ) {
        assertThrows(() => parseOwner(sourceId, "demo.source"), TypeError);
    }
    for (
        const owner of [
            "",
            "a".repeat(129),
            "Uppercase",
            "-prefix",
            "suffix_",
            "plugin/source",
            "plugin:source",
            "plugin source",
            123,
            null,
        ]
    ) assertThrows(() => parseOwner("custom", owner), TypeError);
    for (const owner of ["a", "0", "plugin.source-v2_test"]) {
        assertEquals(parseOwner("custom", owner).sourcePluginIds.custom, owner);
    }
});

Deno.test("UI catalog accepts only canonical self-hosted JavaScript preset modules", () => {
    const parsePage = (id: string, path: unknown) =>
        parseUiCatalog({
            ...EMPTY_UI_CATALOG,
            presetPages: Object.fromEntries([[id, path]]),
        });
    for (
        const path of [
            "https://cdn.example.test/setup.js",
            "//cdn.example.test/setup.js",
            "/admin/assets/console.js",
            "/admin/assets/plugins/../setup.js",
            "/admin/assets/plugins/%2e%2e/setup.js",
            "/admin/assets/plugins/demo//setup.js",
            "/admin/assets/plugins/demo/setup.js?version=2",
            "/admin/assets/plugins/demo/setup.js#module",
            "/admin/assets/plugins/demo/setup.html",
            "/admin/assets/plugins/demo\\setup.js",
            "/admin/assets/plugins/" + "a".repeat(256) + ".js",
            null,
            1,
        ]
    ) {
        assertThrows(() => parsePage("demo.preset", path), TypeError);
    }
    const path = "/admin/assets/plugins/demo/setup.js";
    for (
        const id of [
            "",
            "Demo",
            "-demo",
            "demo_",
            "demo/preset",
            "__proto__",
            "constructor",
            "a".repeat(129),
        ]
    ) {
        assertThrows(() => parsePage(id, path), TypeError);
    }
    assertEquals(parsePage("demo.preset", path).presetPages, {
        "demo.preset": path,
    });
    const maximum = Object.fromEntries(
        Array.from(
            { length: UI_CATALOG_LIMITS.presetPages },
            (_, index) => [`preset-${index}`, path],
        ),
    );
    assertEquals(
        Object.keys(
            parseUiCatalog({ ...EMPTY_UI_CATALOG, presetPages: maximum })
                .presetPages,
        ).length,
        UI_CATALOG_LIMITS.presetPages,
    );
    assertThrows(() =>
        parseUiCatalog({
            ...EMPTY_UI_CATALOG,
            presetPages: { ...maximum, overflow: path },
        }), TypeError);
});

Deno.test("UI catalog accepts maximum schema and source counts together", () => {
    const schemas = Object.fromEntries(
        Array.from({ length: UI_CATALOG_LIMITS.schemas }, (_, index) => {
            const id = `source-${index}`;
            return [id, schema(id)];
        }),
    );
    const sourcePluginIds = Object.fromEntries(
        Array.from(
            { length: UI_CATALOG_LIMITS.sources },
            (
                _,
                index,
            ) => [
                `source-${index}`,
                `source-${index % UI_CATALOG_LIMITS.schemas}`,
            ],
        ),
    );
    const full = { contributions: [], schemas, sourcePluginIds };
    const parsed = parseUiCatalog(full);
    assertEquals(Object.keys(parsed.schemas).length, 128);
    assertEquals(Object.keys(parsed.sourcePluginIds).length, 4096);
    assertThrows(() =>
        parseUiCatalog({
            ...full,
            schemas: { ...schemas, overflow: schema("overflow") },
        }), TypeError);
    assertThrows(() =>
        parseUiCatalog({
            ...full,
            sourcePluginIds: { ...sourcePluginIds, overflow: "source-0" },
        }), TypeError);
});

Deno.test("UI catalog enforces the UTF-8 transport limit at exactly 4 MiB", () => {
    // Individual schemas remain below their 64 KiB limit; the catalog's aggregate
    // limit must still hold when many valid plugins contribute Chinese text.
    const schemas = Object.fromEntries(
        Array.from({ length: 128 }, (_, index) => {
            const id = `source-${index}`;
            return [id, {
                version: 1,
                id,
                fields: Array.from({ length: 6 }, (_, fieldIndex) => ({
                    type: "string",
                    name: `field-${fieldIndex}`,
                    label: "字段",
                    help: "a",
                })),
            }];
        }),
    );
    const input = { contributions: [], schemas, sourcePluginIds: {} };
    const encoder = new TextEncoder();
    let remaining = UI_CATALOG_LIMITS.bytes -
        encoder.encode(JSON.stringify(input)).length;
    for (const sourceSchema of Object.values(schemas)) {
        for (const field of sourceSchema.fields) {
            const additional = Math.min(6000, remaining);
            field.help += "界".repeat(Math.floor(additional / 3)) +
                "a".repeat(additional % 3);
            remaining -= additional;
        }
    }
    assertEquals(remaining, 0);
    const json = JSON.stringify(input);
    assert(json.length < UI_CATALOG_LIMITS.bytes);
    assertEquals(encoder.encode(json).length, UI_CATALOG_LIMITS.bytes);
    assertEquals(Object.keys(parseUiCatalog(input).schemas).length, 128);
    schemas["source-0"]!.fields[0]!.help += "a";
    assertThrows(() => parseUiCatalog(input), TypeError);
});
