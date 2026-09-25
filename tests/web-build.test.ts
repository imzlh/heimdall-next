import { assert, assertEquals, assertRejects } from "@std/assert";

const planner = new URL("../scripts/web-build.ts", import.meta.url);
const projectRoot = new URL("../", import.meta.url);

/** A child process owns cwd so these tests cannot redirect other tests' file I/O. */
async function commands(cwd: URL, watch = false): Promise<string[][]> {
    const source =
        `import { browserBuildCommands } from ${
            JSON.stringify(planner.href)
        };\n` +
        `console.log(JSON.stringify(await browserBuildCommands(${watch})));`;
    const result = await new Deno.Command(Deno.execPath(), {
        args: ["eval", "--no-config", "--no-lock", "--cached-only", source],
        cwd,
        stdout: "piped",
        stderr: "piped",
    }).output();
    if (!result.success) {
        throw new Error(new TextDecoder().decode(result.stderr));
    }
    return JSON.parse(new TextDecoder().decode(result.stdout));
}

async function withBuildRoot(test: (root: URL) => Promise<void>) {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-web-build-" });
    const root = new URL("file:///");
    root.pathname = `${directory.replaceAll("\\", "/")}/`;
    await Deno.mkdir(new URL("plugins/", root));
    try {
        await test(root);
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
}

async function writeManifest(
    root: URL,
    directory: string,
    path: string,
    kind = "preset",
) {
    const plugin = new URL(`plugins/${directory}/`, root);
    await Deno.mkdir(plugin, { recursive: true });
    await Deno.writeTextFile(
        new URL("manifest.json", plugin),
        JSON.stringify({
            id: `test.${directory}`,
            kind,
            trust: "isolated",
            presetPage: { modulePath: path },
        }),
    );
    return plugin;
}

function output(command: string[]): string {
    const index = command.indexOf("--output");
    assert(index >= 0);
    return command[index + 1]!;
}

Deno.test("browser builds include console, chat and loadable preset modules", async () => {
    const built = await commands(projectRoot);
    const entries = Object.fromEntries(
        built.map((command) => [output(command), command.at(-1)]),
    );
    assertEquals(
        entries["public/assets/console.js"],
        "src/web/client/main.tsx",
    );
    assertEquals(
        entries["public/assets/chat.js"],
        "src/web/client/chat-main.tsx",
    );
    assertEquals(entries["public/assets/source-setup.js"], undefined);
    assertEquals(
        entries["public/assets/plugins/newapi-setup.js"],
        "plugins/newapi-preset/ui.tsx",
    );
    assertEquals(
        entries["public/assets/plugins/chathub-setup.js"],
        "plugins/chathub-preset/ui.tsx",
    );
    for (const command of built) {
        assertEquals(command[0], "bundle");
        assert(command.includes("--node-modules-dir=none"));
        assertEquals(
            command[command.indexOf("--config") + 1],
            "deno.browser.json",
        );
        assertEquals(command[command.indexOf("--platform") + 1], "browser");
        assert(command.includes("--minify"));
        assert(!command.includes("--watch"));
    }
});

Deno.test("browser build planning discovers nested preset outputs without running plugin code", async () => {
    await withBuildRoot(async (root) => {
        const plugin = await writeManifest(
            root,
            "example",
            "/admin/assets/plugins/example/setup.js",
        );
        await writeManifest(
            root,
            "source",
            "/admin/assets/plugins/source.js",
            "source",
        );
        await Deno.mkdir(new URL("plugins/no-manifest/", root));
        for (const name of ["mod.ts", "ui.tsx"]) {
            await Deno.writeTextFile(
                new URL(name, plugin),
                'Deno.writeTextFileSync(new URL("executed.txt", import.meta.url), "unexpected");\n' +
                    'throw new Error("Planning must not evaluate plugin code");\n',
            );
        }
        const built = await commands(root, true);
        assertEquals(built.length, 3);
        const preset = built.find((command) =>
            output(command) === "public/assets/plugins/example/setup.js"
        );
        assert(preset);
        assertEquals(preset.at(-1), "plugins/example/ui.tsx");
        for (const command of built) {
            assert(command.includes("--watch"));
            assert(!command.includes("--minify"));
        }
        await assertRejects(
            () => Deno.stat(new URL("executed.txt", plugin)),
            Deno.errors.NotFound,
        );
    });
});

Deno.test("browser build planning refuses colliding preset output files", async () => {
    await withBuildRoot(async (root) => {
        await writeManifest(root, "first", "/admin/assets/plugins/shared.js");
        await writeManifest(root, "second", "/admin/assets/plugins/shared.js");
        await assertRejects(
            () => commands(root),
            Error,
            "Duplicate browser output plugins/shared",
        );
    });
});

Deno.test("browser build planning rejects external, traversing and non-module output paths", async () => {
    await withBuildRoot(async (root) => {
        for (
            const path of [
                "https://example.test/setup.js",
                "/admin/assets/plugins/../console.js",
                "/admin/assets/plugins/%2e%2e/console.js",
                "/admin/assets/plugins/setup.html",
                "/admin/assets/plugins/setup.js?version=1",
                "/admin/assets/plugins//setup.js",
            ]
        ) {
            await writeManifest(root, "example", path);
            await assertRejects(
                () => commands(root),
                Error,
                "Invalid preset build output",
            );
        }
    });
});
