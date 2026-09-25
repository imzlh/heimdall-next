import { assert, assertEquals, assertRejects } from "@std/assert";
import type { SourceConfigSchema } from "@heimdall/admin-contracts/forms.ts";
import { MAX_PLUGIN_MANIFEST_BYTES } from "@heimdall/core/composition/plugin-manifests.ts";
import { loadSourceSchemas } from "@heimdall/core/composition/source-schemas.ts";

function schema(id: string, title = "Connection"): SourceConfigSchema {
    return {
        version: 1,
        id,
        title,
        fields: [
            {
                type: "string",
                name: "baseUrl",
                label: "Base URL",
                format: "url",
                required: true,
            },
            {
                type: "secret",
                name: "apiKey",
                label: "API key",
                preserveOnBlank: true,
            },
        ],
    };
}

function manifest(id: string, kind: string, configSchema: unknown) {
    return {
        id,
        version: "1.0.0",
        apiVersion: "1",
        name: id,
        kind,
        trust: "isolated",
        configSchema,
    };
}

async function withPluginRoot(test: (root: URL) => Promise<void>) {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-schema-" });
    const root = new URL("file:///");
    root.pathname = `${directory.replaceAll("\\", "/")}/`;
    try {
        await test(root);
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
}

async function writeManifest(root: URL, directory: string, value: unknown) {
    const pluginRoot = new URL(`${directory}/`, root);
    await Deno.mkdir(pluginRoot);
    await Deno.writeTextFile(
        new URL("manifest.json", pluginRoot),
        JSON.stringify(value),
    );
    return pluginRoot;
}

Deno.test("source schemas load source and preset data without executing modules", async () => {
    await withPluginRoot(async (pluginRoot) => {
        const source = schema("fixture.source");
        const preset = schema("fixture.preset");
        const sourceRoot = await writeManifest(
            pluginRoot,
            "source",
            manifest(source.id, "source", source),
        );
        await writeManifest(
            pluginRoot,
            "preset",
            manifest(preset.id, "preset", preset),
        );
        await writeManifest(
            pluginRoot,
            "protocol",
            manifest(
                "fixture.protocol",
                "protocol",
                schema("fixture.protocol"),
            ),
        );
        await Deno.writeTextFile(
            new URL("mod.ts", sourceRoot),
            'await Deno.writeTextFile(new URL("executed.txt", import.meta.url), "unexpected");\n' +
                'throw new Error("Schema discovery must not execute plugin modules");\n',
        );
        const warnings: string[] = [];

        const loaded = await loadSourceSchemas({
            pluginRoot,
            warn: (message) => warnings.push(message),
        });

        assertEquals(loaded, { [source.id]: source, [preset.id]: preset });
        assertEquals(warnings, []);
        await assertRejects(
            () => Deno.stat(new URL("executed.txt", sourceRoot)),
            Deno.errors.NotFound,
        );
    });
});

Deno.test("source schema discovery isolates spoofed, invalid, and oversized manifests", async () => {
    await withPluginRoot(async (pluginRoot) => {
        const valid = schema("fixture.valid");
        await writeManifest(
            pluginRoot,
            "valid",
            manifest(valid.id, "source", valid),
        );
        await writeManifest(
            pluginRoot,
            "spoofed",
            manifest("fixture.spoofed", "source", schema("fixture.other")),
        );
        await writeManifest(
            pluginRoot,
            "invalid-fields",
            manifest("fixture.invalid", "source", {
                ...schema("fixture.invalid"),
                fields: [{ type: "script", name: "code", label: "Executable" }],
            }),
        );
        const invalidJson = await writeManifest(pluginRoot, "invalid-json", {});
        await Deno.writeTextFile(new URL("manifest.json", invalidJson), "{bad");
        await writeManifest(pluginRoot, "oversized", {
            ...manifest(
                "fixture.oversized",
                "source",
                schema("fixture.oversized"),
            ),
            padding: "x".repeat(MAX_PLUGIN_MANIFEST_BYTES),
        });
        const warnings: string[] = [];

        const loaded = await loadSourceSchemas({
            pluginRoot,
            warn: (message) => warnings.push(message),
        });

        assertEquals(loaded, { [valid.id]: valid });
        assertEquals(warnings.length, 4);
    });
});

Deno.test("source schema discovery keeps the first directory for duplicate plugin ids", async () => {
    await withPluginRoot(async (pluginRoot) => {
        const original = schema("fixture.duplicate", "Original");
        await writeManifest(
            pluginRoot,
            "z-duplicate",
            manifest(original.id, "source", schema(original.id, "Replacement")),
        );
        await writeManifest(
            pluginRoot,
            "a-original",
            manifest(original.id, "source", original),
        );
        const warnings: string[] = [];

        const loaded = await loadSourceSchemas({
            pluginRoot,
            warn: (message) => warnings.push(message),
        });

        assertEquals(loaded, { [original.id]: original });
        assertEquals(warnings.length, 1);
    });
});

Deno.test("source schema discovery tolerates missing roots and optional declarations", async () => {
    await withPluginRoot(async (pluginRoot) => {
        const warnings: string[] = [];
        const warn = (message: string) => warnings.push(message);
        assertEquals(
            await loadSourceSchemas({
                pluginRoot: new URL("missing/", pluginRoot),
                warn,
            }),
            {},
        );
        await Deno.mkdir(new URL("no-manifest/", pluginRoot));
        await writeManifest(
            pluginRoot,
            "no-schema",
            manifest("fixture.optional", "source", undefined),
        );
        assertEquals(await loadSourceSchemas({ pluginRoot, warn }), {});
        assertEquals(warnings, []);
    });
});

Deno.test("source schema discovery does not follow linked plugin directories", async () => {
    await withPluginRoot(async (root) => {
        const pluginRoot = new URL("plugins/", root);
        await Deno.mkdir(pluginRoot);
        const external = schema("fixture.external");
        const target = await writeManifest(
            root,
            "external-plugin",
            manifest(external.id, "source", external),
        );
        await Deno.symlink(target, new URL("linked-plugin", pluginRoot), {
            type: Deno.build.os === "windows" ? "junction" : "dir",
        });

        assertEquals(await loadSourceSchemas({ pluginRoot }), {});
    });
});

Deno.test("built-in source and preset manifests publish schemas in their own namespaces", async () => {
    const warnings: string[] = [];
    const loaded = await loadSourceSchemas({
        warn: (message) => warnings.push(message),
    });
    const plugins = [
        ["anthropic-source", "heimdall.source.anthropic"],
        ["chathub-source", "heimdall.source.chathub"],
        ["newapi-preset", "heimdall.preset.newapi"],
        ["openai-source", "heimdall.source.openai-compatible"],
    ] as const;
    assertEquals(
        Object.keys(loaded).sort(),
        plugins.map(([, id]) => id).sort(),
    );
    for (const [directory, id] of plugins) {
        const declared = JSON.parse(
            await Deno.readTextFile(
                new URL(
                    `../plugins/${directory}/manifest.json`,
                    import.meta.url,
                ),
            ),
        );
        const loadedSchema = loaded[id];
        assert(loadedSchema !== undefined);
        assertEquals(loadedSchema.id, declared.id);
        assertEquals(loadedSchema, declared.configSchema);
        assert(loadedSchema.fields.length > 0);
    }
    assertEquals(warnings, []);
});
