/** Static browser entry points, built by Deno without a Node/Vite application. */
export async function browserBuildCommands(watch = false): Promise<string[][]> {
    const entries = new Map([
        ["console", "src/web/client/main.tsx"],
        ["chat", "src/web/client/chat-main.tsx"],
    ]);
    for await (const entry of Deno.readDir("plugins")) {
        if (!entry.isDirectory || entry.isSymlink) continue;
        let manifest: Record<string, unknown>;
        try {
            manifest = JSON.parse(
                await Deno.readTextFile(`plugins/${entry.name}/manifest.json`),
            );
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) continue;
            throw error;
        }
        const page = manifest.presetPage as
            | { modulePath?: unknown }
            | undefined;
        if (manifest.kind !== "preset" || !page) continue;
        if (
            typeof page.modulePath !== "string" ||
            !/^\/admin\/assets\/plugins\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.js$/
                .test(page.modulePath)
        ) {
            throw new Error(`Invalid preset build output in ${entry.name}`);
        }
        const output = page.modulePath.slice("/admin/assets/".length, -3);
        if (entries.has(output)) {
            throw new Error(`Duplicate browser output ${output}`);
        }
        entries.set(output, `plugins/${entry.name}/ui.tsx`);
    }
    return [...entries].map(([name, entry]) => [
        "bundle",
        "--node-modules-dir=none",
        "--config",
        "deno.browser.json",
        "--platform",
        "browser",
        watch ? "--watch" : "--minify",
        "--output",
        `public/assets/${name}.js`,
        entry,
    ]);
}
