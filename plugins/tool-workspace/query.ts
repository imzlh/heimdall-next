import { posix } from "node:path";
import {
    booleanArg,
    fields,
    jsonTextPrefix,
    MAX_RESULT_CHARS,
    numberArg,
    stringArg,
} from "./arguments.ts";
import { readFile } from "./browse.ts";
import type { LocalWorkspace } from "./workspace.ts";

const MAX_SCAN_ENTRIES = 2_000;
const MAX_DEPTH = 20;
const ignoredDirectories = new Set([
    ".git",
    ".deno",
    "node_modules",
    "coverage",
    "dist",
]);

/** Glob patterns always match slash-separated paths relative to the workspace. */
export async function findFiles(
    workspace: LocalWorkspace,
    args: Record<string, unknown>,
    signal: AbortSignal,
) {
    signal.throwIfAborted();
    fields(args, ["pattern", "path", "includeHidden", "maxResults"]);
    const pattern = stringArg(args, "pattern");
    if (
        !pattern || pattern.length > 1_024 || /[\0:]/.test(pattern) ||
        /^[\\/]/.test(pattern) ||
        pattern.split(/[\\/]/).includes("..")
    ) {
        throw new Error(
            "pattern must be a relative glob of 1-1024 characters without '..' components",
        );
    }
    // Conservatively exclude ranges even when nested alternatives compose
    // their endpoints. Native glob has no public expansion cost guarantee.
    if (/[{}]/.test(pattern) && pattern.includes("..")) {
        throw new Error(
            "Glob brace ranges are unsupported; use explicit alternatives",
        );
    }
    if (
        (pattern.match(/,/g)?.length ?? 0) > 8 ||
        (pattern.match(/\{/g)?.length ?? 0) > 8 ||
        (pattern.match(/\}/g)?.length ?? 0) > 8 ||
        /[?*+@!]\(/.test(pattern)
    ) {
        throw new Error(
            "Glob patterns allow at most 8 commas and brace pairs; extglob is unsupported",
        );
    }
    const path = stringArg(args, "path", ".") || ".";
    const includeHidden = booleanArg(args, "includeHidden");
    const maxResults = numberArg(args, "maxResults", 100, 1, 100);
    const paths: string[] = [];
    let scannedEntries = 0;
    let truncated = false;
    let stopped = false;
    let resultChars = JSON.stringify({
        paths: [],
        truncated: false,
        scannedEntries: MAX_SCAN_ENTRIES,
    }).length;

    async function visit(directory: string, depth: number): Promise<void> {
        signal.throwIfAborted();
        const listing = await workspace.list(directory, signal);
        truncated ||= listing.truncated;
        // Validate the caller's original path through LocalWorkspace before
        // normalizing separators and redundant '.' components for matching.
        const relative = directory.split(/[\\/]/)
            .filter((part) => part && part !== ".").join("/");
        for (const entry of listing.entries) {
            signal.throwIfAborted();
            if (stopped) return;
            if (scannedEntries >= MAX_SCAN_ENTRIES) {
                truncated = stopped = true;
                return;
            }
            scannedEntries++;
            if (!includeHidden && entry.name.startsWith(".")) continue;
            const child = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.kind === "directory") {
                if (ignoredDirectories.has(entry.name)) continue;
                if (depth >= MAX_DEPTH) {
                    truncated = true;
                    continue;
                }
                try {
                    await visit(child, depth + 1);
                } catch {
                    signal.throwIfAborted();
                    truncated = true;
                }
            } else if (
                entry.kind === "file" && posix.matchesGlob(child, pattern)
            ) {
                const size = JSON.stringify(child).length + 1;
                if (
                    paths.length >= maxResults ||
                    resultChars + size >= MAX_RESULT_CHARS
                ) {
                    truncated = stopped = true;
                    return;
                }
                paths.push(child);
                resultChars += size;
            }
        }
    }

    await visit(path, 0);
    signal.throwIfAborted();
    return { paths, truncated, scannedEntries };
}

type FilePage = Awaited<ReturnType<typeof readFile>>;
type FileResult = FilePage | { path: string; error: string };

/** Keep every file's metadata and resumable offset within one bounded result. */
export async function readFiles(
    workspace: LocalWorkspace,
    args: Record<string, unknown>,
    signal: AbortSignal,
) {
    signal.throwIfAborted();
    fields(args, ["paths", "offset", "limit"]);
    const paths = args.paths;
    if (
        !Array.isArray(paths) || paths.length < 1 || paths.length > 10 ||
        paths.some((path) =>
            typeof path !== "string" || !path || path.length > 1_024
        )
    ) {
        throw new Error(
            "paths must contain 1-10 strings of 1-1024 characters each",
        );
    }
    const offset = numberArg(args, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = numberArg(args, "limit", 1_200, 1, 4_000);
    const files: FileResult[] = await Promise.all(
        (paths as string[]).map(async (path): Promise<FileResult> => {
            signal.throwIfAborted();
            try {
                return await readFile(
                    workspace,
                    { path, offset, limit },
                    signal,
                );
            } catch (error) {
                signal.throwIfAborted();
                return {
                    path,
                    error: jsonTextPrefix(
                        error instanceof Error ? error.message : "Read failed",
                        300,
                    ),
                };
            }
        }),
    );
    signal.throwIfAborted();

    const metadata = files.map((file) =>
        "content" in file ? { ...file, content: "", truncated: false } : file
    );
    let budget = MAX_RESULT_CHARS - 1 -
        JSON.stringify({ files: metadata, truncated: false }).length;
    let remaining = files.filter((file) => "content" in file).length;
    // Six serialized characters cover any one UTF-8 character's JSON escape,
    // so every nonempty page can advance even when paths consume most space.
    if (budget < remaining * 6) {
        throw new Error(
            "File paths exceed the batch result budget; request fewer paths",
        );
    }
    for (const file of files) {
        if (!("content" in file)) continue;
        const content = jsonTextPrefix(
            file.content,
            Math.floor(budget / remaining) + 2,
        );
        remaining--;
        budget -= JSON.stringify(content).length - 2;
        file.content = content;
        file.nextOffset = file.offset + content.length;
        file.truncated = file.nextOffset < file.totalChars;
    }
    return {
        files,
        truncated: files.some((file) => "content" in file && file.truncated),
    };
}
