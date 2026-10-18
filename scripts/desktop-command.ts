import { fileURLToPath } from "node:url";

export const desktopProjectRoot = fileURLToPath(
    new URL("../", import.meta.url),
);
export type DesktopBackend = "webview" | "cef";

/** Use the platform WebView by default; CEF remains an explicit build option. */
export function defaultDesktopBackend(
    _os: typeof Deno.build.os = Deno.build.os,
): DesktopBackend {
    return "webview";
}

export function desktopDistributionName(
    backend: DesktopBackend | undefined = undefined,
    os: typeof Deno.build.os = Deno.build.os,
    architecture: typeof Deno.build.arch = Deno.build.arch,
): string {
    const selected = backend ?? defaultDesktopBackend(os);
    return `${os}-${architecture}${selected === "cef" ? "-cef" : ""}`;
}

export interface DesktopCommandOptions {
    readonly backend?: DesktopBackend;
    readonly development?: boolean;
    readonly output?: string;
    readonly scriptArgs?: readonly string[];
}

/** Native desktop uses the same embedded module filesystem as Deno compile. */
export async function desktopCommand(
    options: DesktopCommandOptions = {},
): Promise<string[]> {
    const backend = options.backend ?? defaultDesktopBackend();
    const args = [
        "desktop",
        "--node-modules-dir=none",
        "--unstable-kv",
        "--unstable-worker-options",
        "--allow-net",
        "--allow-env",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--include",
        "public/assets",
        "--include",
        "src/desktop/icon.png",
        "--backend",
        backend,
        "--icon",
        Deno.build.os === "windows"
            ? "src/desktop/icon.ico"
            : "src/desktop/icon.png",
    ];
    if (options.development) args.push("--hmr");
    if (options.output) {
        args.push("--output", options.output);
    }
    const root = new URL("../plugins/", import.meta.url);
    const names: string[] = [];
    for await (const entry of Deno.readDir(root)) {
        if (entry.isDirectory) names.push(entry.name);
    }
    for (const name of names.sort()) {
        const module = `plugins/${name}/mod.ts`;
        const manifest = `plugins/${name}/manifest.json`;
        try {
            await Deno.stat(new URL(module, new URL("../", import.meta.url)));
            await Deno.stat(new URL(manifest, new URL("../", import.meta.url)));
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) continue;
            throw error;
        }
        // Include backend entries explicitly so dynamic imports resolve while
        // plugin UI JSX and CSS stay in the separate browser build graph.
        args.push("--include", module, "--include", manifest);
    }
    // CompileFlags.args embeds this in the application, including direct launches
    // of a distributed executable without the development wrapper's environment.
    return [
        ...args,
        "desktop.ts",
        "--",
        `--native-backend=${backend}`,
        ...options.scriptArgs ?? [],
    ];
}

export function readDesktopBackend(value: string | undefined): DesktopBackend {
    if (value === "webview" || value === "cef") return value;
    throw new Error("--backend requires webview or cef.");
}

/** Consume the native backend flag; all other arguments belong to the app. */
export function desktopLaunchOptions(
    args: readonly string[],
): DesktopCommandOptions {
    let backend: DesktopBackend | undefined;
    const scriptArgs: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const argument = args[index]!;
        if (argument === "--backend") {
            backend = readDesktopBackend(args[++index]);
        } else if (argument.startsWith("--backend=")) {
            backend = readDesktopBackend(argument.slice("--backend=".length));
        } else scriptArgs.push(argument);
    }
    return { backend, scriptArgs };
}
