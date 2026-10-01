import { assert, assertEquals, assertRejects } from "@std/assert";
import {
    BUILTIN_PRESET_MODULES,
    loadPresetPages,
    withBuiltinPresetPages,
} from "@heimdall/core/composition/preset-pages.ts";
import type { UiPolicy } from "@heimdall/admin-contracts/ui.ts";

const modulePath = "/admin/assets/plugins/example-setup.js";
const presetId = "example.preset";
const grant = { trustedModules: { [`${presetId}:setup`]: modulePath } };

function manifest(path = modulePath) {
    return {
        id: presetId,
        version: "1.0.0",
        apiVersion: "1",
        name: "Example preset",
        kind: "preset",
        trust: "trusted",
        presetPage: { modulePath: path },
    };
}

async function withPluginRoot(test: (root: URL) => Promise<void>) {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-preset-pages-",
    });
    const root = new URL("file:///");
    root.pathname = `${directory.replaceAll("\\", "/")}/`;
    try {
        await test(root);
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
}

async function writeManifest(root: URL, input: unknown) {
    const directory = new URL("example/", root);
    await Deno.mkdir(directory, { recursive: true });
    await Deno.writeTextFile(
        new URL("manifest.json", directory),
        JSON.stringify(input),
    );
    return directory;
}

Deno.test("built-in preset page grants cover reviewed modules and permit explicit overrides", async () => {
    assertEquals(BUILTIN_PRESET_MODULES, {
        "heimdall.preset.newapi:setup": "/admin/assets/plugins/newapi-setup.js",
        "heimdall.preset.chathub:setup":
            "/admin/assets/plugins/chathub-setup.js",
    });
    const inheritedPolicy = {
        trustedModules: { "another.preset:setup": modulePath },
        sandboxDocuments: { "example:card": "/admin/assets/plugins/card.html" },
        allowedActions: { "example:card": ["refresh"] },
    };
    const merged = withBuiltinPresetPages(inheritedPolicy);
    assertEquals(merged.trustedModules, {
        ...BUILTIN_PRESET_MODULES,
        "heimdall.source.chathub:account-information":
            "/admin/assets/plugins/chathub-account.js",
        ...inheritedPolicy.trustedModules,
    });
    assertEquals(merged.sandboxDocuments, inheritedPolicy.sandboxDocuments);
    assertEquals(merged.allowedActions, inheritedPolicy.allowedActions);
    assertEquals(inheritedPolicy.trustedModules, {
        "another.preset:setup": modulePath,
    });
    const active = await loadPresetPages(withBuiltinPresetPages({}));
    assertEquals(
        active["heimdall.preset.newapi"],
        "/admin/assets/plugins/newapi-setup.js",
    );
    assertEquals(
        active["heimdall.preset.chathub"],
        "/admin/assets/plugins/chathub-setup.js",
    );
    const replaced = await loadPresetPages(withBuiltinPresetPages({
        trustedModules: {
            "heimdall.preset.newapi:setup":
                "/admin/assets/plugins/replacement.js",
        },
    }));
    assertEquals(replaced["heimdall.preset.newapi"], undefined);
});

Deno.test("preset pages require an own grant for the exact plugin, setup slot and module path", async () => {
    await withPluginRoot(async (pluginRoot) => {
        await writeManifest(pluginRoot, manifest());
        const unapproved: UiPolicy[] = [
            {},
            { trustedModules: { [`${presetId}:card`]: modulePath } },
            { trustedModules: { "different.preset:setup": modulePath } },
            {
                trustedModules: {
                    [`${presetId}:setup`]: "/admin/assets/plugins/different.js",
                },
            },
            { sandboxDocuments: { [`${presetId}:setup`]: modulePath } },
            { trustedModules: Object.create(grant.trustedModules) },
        ];
        for (const policy of unapproved) {
            assertEquals(await loadPresetPages(policy, { pluginRoot }), {});
        }
        assertEquals(await loadPresetPages(grant, { pluginRoot }), {
            [presetId]: modulePath,
        });
    });
});

Deno.test("preset page discovery re-reads changed metadata and removes deleted or revoked pages", async () => {
    await withPluginRoot(async (pluginRoot) => {
        const path = "/admin/assets/plugins/example/setup.js";
        const directory = await writeManifest(pluginRoot, manifest());
        assertEquals(await loadPresetPages(grant, { pluginRoot }), {
            [presetId]: modulePath,
        });
        await writeManifest(pluginRoot, manifest(path));
        assertEquals(await loadPresetPages(grant, { pluginRoot }), {});
        const revised = { trustedModules: { [`${presetId}:setup`]: path } };
        assertEquals(await loadPresetPages(revised, { pluginRoot }), {
            [presetId]: path,
        });
        assertEquals(await loadPresetPages({}, { pluginRoot }), {});
        await Deno.remove(new URL("manifest.json", directory));
        assertEquals(await loadPresetPages(revised, { pluginRoot }), {});
    });
});

Deno.test("preset page discovery does not execute runtime modules or JSX entries", async () => {
    await withPluginRoot(async (pluginRoot) => {
        const directory = await writeManifest(pluginRoot, manifest());
        for (const name of ["mod.ts", "ui.tsx"]) {
            await Deno.writeTextFile(
                new URL(name, directory),
                'Deno.writeTextFileSync(new URL("executed.txt", import.meta.url), "unexpected");\n' +
                    'throw new Error("Metadata discovery must not execute plugin code");\n',
            );
        }
        assertEquals(await loadPresetPages(grant, { pluginRoot }), {
            [presetId]: modulePath,
        });
        await assertRejects(
            () => Deno.stat(new URL("executed.txt", directory)),
            Deno.errors.NotFound,
        );
    });
});

Deno.test("preset page discovery rejects non-preset kinds and unsafe outputs despite matching grants", async () => {
    await withPluginRoot(async (pluginRoot) => {
        await writeManifest(pluginRoot, { ...manifest(), kind: "source" });
        assertEquals(await loadPresetPages(grant, { pluginRoot }), {});
        for (
            const path of [
                "https://example.test/ui.js",
                "/admin/assets/plugins/../private.js",
                "/admin/assets/plugins/%2e%2e/private.js",
                "/admin/assets/plugins/ui.html",
                "/admin/assets/plugins/ui.js?version=1",
            ]
        ) {
            await writeManifest(pluginRoot, manifest(path));
            assertEquals(
                await loadPresetPages({
                    trustedModules: { [`${presetId}:setup`]: path },
                }, { pluginRoot }),
                {},
            );
        }
        const warnings: string[] = [];
        await Deno.writeTextFile(
            new URL("example/manifest.json", pluginRoot),
            '{"secret":"should-not-leak"',
        );
        assertEquals(
            await loadPresetPages(grant, {
                pluginRoot,
                warn: (message) => warnings.push(message),
            }),
            {},
        );
        assertEquals(warnings.length, 1);
        assert(!warnings[0]!.includes("should-not-leak"));
    });
});
