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

/** Absolute paths of every local file a bundle reads, from Deno's module graph. */
async function bundleInputs(entry: string, config: string): Promise<string[]> {
    const result = await new Deno.Command(Deno.execPath(), {
        args: [
            "info",
            "--json",
            "--node-modules-dir=none",
            "--config",
            config,
            entry,
        ],
        stdout: "piped",
        stderr: "piped",
    }).output();
    if (!result.success) {
        throw new Error(
            `deno info failed for ${entry}: ${
                new TextDecoder().decode(result.stderr)
            }`,
        );
    }
    const info = JSON.parse(new TextDecoder().decode(result.stdout)) as {
        modules?: Array<{ local?: string | null; specifier?: string }>;
    };
    const files = new Set<string>([config]);
    for (const module of info.modules ?? []) {
        // `local` is the on-disk path (cache dir for jsr/npm, source for files).
        if (typeof module.local === "string" && module.local) {
            files.add(module.local);
        }
        // CSS and other non-JS imports carry no `local`; bundle still reads them,
        // so track them by their file:// specifier.
        if (
            typeof module.specifier === "string" &&
            module.specifier.startsWith("file://")
        ) {
            files.add(module.specifier);
        }
    }
    return [...files];
}

/** True when the output exists and no input file is newer, so the build is stale-free. */
export async function bundleIsFresh(
    output: string,
    entry: string,
    config: string,
): Promise<boolean> {
    let outputMtime: number;
    try {
        outputMtime = (await Deno.stat(output)).mtime?.getTime() ?? 0;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
    }
    if (outputMtime === 0) return false;
    for (const input of await bundleInputs(entry, config)) {
        const target = input.startsWith("file://") ? new URL(input) : input;
        let mtime: number;
        try {
            mtime = (await Deno.stat(target)).mtime?.getTime() ?? Infinity;
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) continue;
            throw error;
        }
        if (mtime > outputMtime) return false;
    }
    return true;
}
