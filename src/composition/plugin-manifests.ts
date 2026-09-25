export const MAX_PLUGIN_MANIFEST_BYTES = 1_048_576;

export interface PluginManifestOptions {
    readonly pluginRoot?: URL;
    readonly warn?: (message: string) => void;
}

export interface PluginManifestEntry {
    readonly directory: string;
    readonly manifest: unknown;
}

/** Read bounded JSON declarations without importing a plugin runtime module. */
export async function* readPluginManifests(
    options: PluginManifestOptions = {},
): AsyncIterable<PluginManifestEntry> {
    const root = options.pluginRoot ??
        new URL("../../plugins/", import.meta.url);
    const warn = options.warn ?? ((message: string) => console.warn(message));
    const directories: string[] = [];
    try {
        for await (const entry of Deno.readDir(root)) {
            if (entry.isDirectory && !entry.isSymlink) {
                directories.push(entry.name);
            }
        }
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
    }

    for (const directory of directories.toSorted()) {
        const url = new URL(
            `${encodeURIComponent(directory)}/manifest.json`,
            root,
        );
        try {
            const manifest = await readManifest(url);
            if (manifest !== undefined) yield { directory, manifest };
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) continue;
            // A parser excerpt may contain secrets from a malformed file.
            warn(
                `Ignoring plugin manifest ${
                    JSON.stringify(directory)
                }: unreadable, invalid JSON, or larger than 1 MiB.`,
            );
        }
    }
}

async function readManifest(url: URL): Promise<unknown> {
    const info = await Deno.lstat(url);
    if (!info.isFile || info.isSymlink) return undefined;
    if (info.size > MAX_PLUGIN_MANIFEST_BYTES) {
        throw new RangeError("Plugin manifest exceeds the size limit");
    }
    using file = await Deno.open(url, { read: true });
    // The extra byte also detects growth between the size check and the read.
    const bytes = new Uint8Array(MAX_PLUGIN_MANIFEST_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
        const read = await file.read(bytes.subarray(length));
        if (read === null) break;
        length += read;
    }
    if (length > MAX_PLUGIN_MANIFEST_BYTES) {
        throw new RangeError("Plugin manifest exceeds the size limit");
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, length),
    ));
}
