import { assertEquals, assertRejects } from "@std/assert";
import {
    resolveUiRender,
    UI_LIMITS,
    type UiContribution,
} from "@heimdall/admin-contracts/ui.ts";
import {
    loadUiContributions,
    MAX_UI_MANIFEST_BYTES,
} from "@heimdall/core/composition/ui-contributions.ts";

function contribution(
    pluginId: string,
    overrides: Partial<UiContribution> = {},
): UiContribution {
    return {
        pluginId,
        id: "status",
        slot: "dashboard.widget",
        title: "Plugin status",
        schema: { blocks: [{ kind: "text", text: "Plugin is available" }] },
        ...overrides,
    };
}

function manifest(id: string, ui: readonly UiContribution[]) {
    return {
        id,
        version: "1.0.0",
        apiVersion: "1",
        name: id,
        kind: "api",
        trust: "trusted",
        ui,
    };
}

async function withPluginRoot(test: (root: URL) => Promise<void>) {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-ui-" });
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

Deno.test("UI discovery reads declared contributions without executing plugin code", async () => {
    await withPluginRoot(async (pluginRoot) => {
        const schema = contribution("fixture.schema");
        const executable = contribution("fixture.executable", {
            render: {
                kind: "trusted",
                modulePath: "/admin/assets/plugins/fixture/widget.js",
            },
        });
        await writeManifest(
            pluginRoot,
            "a-schema",
            manifest(schema.pluginId, [schema]),
        );
        const executableRoot = await writeManifest(
            pluginRoot,
            "b-executable",
            manifest(executable.pluginId, [executable]),
        );
        await Deno.writeTextFile(
            new URL("mod.ts", executableRoot),
            'await Deno.writeTextFile(new URL("executed.txt", import.meta.url), "unexpected");\n' +
                'throw new Error("UI discovery must not import plugin code");\n',
        );
        const warnings: string[] = [];

        const loaded = await loadUiContributions({
            pluginRoot,
            warn: (message) => warnings.push(message),
        });

        assertEquals(loaded, [schema, executable]);
        assertEquals(warnings, []);
        // Declaring plugin trust and a renderer does not grant UI execution.
        assertEquals(resolveUiRender(loaded[1]!), { kind: "schema" });
        await assertRejects(
            () => Deno.stat(new URL("executed.txt", executableRoot)),
            Deno.errors.NotFound,
        );
    });
});

Deno.test("UI discovery isolates invalid, spoofed, and oversized manifests", async () => {
    await withPluginRoot(async (pluginRoot) => {
        const valid = contribution("fixture.valid");
        await writeManifest(
            pluginRoot,
            "valid",
            manifest(valid.pluginId, [valid]),
        );
        await writeManifest(
            pluginRoot,
            "spoofed",
            manifest("fixture.spoofed", [contribution("fixture.other")]),
        );
        const invalid = await writeManifest(pluginRoot, "invalid-json", {});
        await Deno.writeTextFile(new URL("manifest.json", invalid), "{invalid");
        await writeManifest(pluginRoot, "oversized", {
            ...manifest("fixture.oversized", [
                contribution("fixture.oversized"),
            ]),
            padding: "x".repeat(MAX_UI_MANIFEST_BYTES),
        });
        const warnings: string[] = [];

        const loaded = await loadUiContributions({
            pluginRoot,
            warn: (message) => warnings.push(message),
        });

        assertEquals(loaded, [valid]);
        assertEquals(warnings.length, 3);
    });
});

Deno.test("UI discovery keeps the first directory's contribution on duplicate keys", async () => {
    await withPluginRoot(async (pluginRoot) => {
        const original = contribution("fixture.duplicate", {
            title: "Original",
        });
        const duplicate = { ...original, title: "Replacement" };
        await writeManifest(
            pluginRoot,
            "z-duplicate",
            manifest(duplicate.pluginId, [
                duplicate,
                contribution(duplicate.pluginId, { id: "extra" }),
            ]),
        );
        await writeManifest(
            pluginRoot,
            "a-original",
            manifest(original.pluginId, [original]),
        );
        const warnings: string[] = [];

        const loaded = await loadUiContributions({
            pluginRoot,
            warn: (message) => warnings.push(message),
        });

        assertEquals(loaded, [original]);
        assertEquals(warnings.length, 1);
    });
});

Deno.test("UI discovery rejects an overflowing manifest without partially registering it", async () => {
    await withPluginRoot(async (pluginRoot) => {
        const initial = Array.from(
            { length: UI_LIMITS.contributions - 1 },
            (_, index) =>
                contribution("fixture.initial", { id: `item-${index}` }),
        );
        await writeManifest(
            pluginRoot,
            "a-initial",
            manifest("fixture.initial", initial),
        );
        await writeManifest(
            pluginRoot,
            "b-overflow",
            manifest("fixture.overflow", [
                contribution("fixture.overflow", { id: "first" }),
                contribution("fixture.overflow", { id: "second" }),
            ]),
        );
        const final = contribution("fixture.final");
        await writeManifest(
            pluginRoot,
            "c-final",
            manifest(final.pluginId, [final]),
        );
        const warnings: string[] = [];

        const loaded = await loadUiContributions({
            pluginRoot,
            warn: (message) => warnings.push(message),
        });

        assertEquals(loaded, [...initial, final]);
        assertEquals(warnings.length, 1);
    });
});

Deno.test("UI discovery tolerates missing roots and directories without manifests", async () => {
    await withPluginRoot(async (pluginRoot) => {
        const warnings: string[] = [];
        const warn = (message: string) => warnings.push(message);
        assertEquals(
            await loadUiContributions({
                pluginRoot: new URL("missing/", pluginRoot),
                warn,
            }),
            [],
        );
        await Deno.mkdir(new URL("no-manifest/", pluginRoot));
        assertEquals(await loadUiContributions({ pluginRoot, warn }), []);
        assertEquals(warnings, []);
    });
});

Deno.test("UI discovery does not follow linked plugin directories", async () => {
    await withPluginRoot(async (root) => {
        const pluginRoot = new URL("plugins/", root);
        await Deno.mkdir(pluginRoot);
        const target = await writeManifest(
            root,
            "external-plugin",
            manifest("fixture.external", [contribution("fixture.external")]),
        );
        await Deno.symlink(target, new URL("linked-plugin", pluginRoot), {
            type: Deno.build.os === "windows" ? "junction" : "dir",
        });

        assertEquals(await loadUiContributions({ pluginRoot }), []);
    });
});
