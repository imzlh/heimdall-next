import {
    booleanArg,
    fields,
    jsonTextPrefix,
    MAX_RESULT_CHARS,
    numberArg,
    stringArg,
} from "./arguments.ts";
import { type LocalWorkspace, MAX_FILE_BYTES } from "./workspace.ts";

const MAX_SCAN_ENTRIES = 2_000;
const MAX_SCAN_CHARS = 4_194_304;
const MAX_SCAN_FILES = 500;
const MAX_DEPTH = 20;
const ignoredDirectories = new Set([
    ".git",
    ".deno",
    "node_modules",
    "coverage",
    "dist",
]);

export async function listFiles(
    workspace: LocalWorkspace,
    args: Record<string, unknown>,
    signal: AbortSignal,
) {
    fields(args, ["path"]);
    const path = stringArg(args, "path", ".") || ".";
    const result = await workspace.list(path, signal);
    const entries: typeof result.entries = [];
    const budget = MAX_RESULT_CHARS -
        JSON.stringify({ path, entries: [], truncated: true }).length - 16;
    let size = 0;
    for (const entry of result.entries) {
        size += JSON.stringify(entry).length + 1;
        if (size > budget) break;
        entries.push(entry);
    }
    return {
        path,
        entries,
        truncated: result.truncated || entries.length < result.entries.length,
    };
}

export async function readFile(
    workspace: LocalWorkspace,
    args: Record<string, unknown>,
    signal: AbortSignal,
) {
    fields(args, ["path", "offset", "limit"]);
    const path = stringArg(args, "path");
    const offset = numberArg(args, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = numberArg(args, "limit", 12_000, 1, 12_000);
    const file = await workspace.read(path, signal);
    if (offset > file.content.length) {
        throw new Error("offset is past the end of the file");
    }
    const splitPair = (index: number) =>
        /[\uD800-\uDBFF]/.test(file.content.charAt(index - 1)) &&
        /[\uDC00-\uDFFF]/.test(file.content.charAt(index));
    if (splitPair(offset)) {
        throw new Error("offset must not split a Unicode character");
    }
    let end = Math.min(offset + limit, file.content.length);
    if (splitPair(end)) end += end === offset + 1 ? 1 : -1;
    const budget = MAX_RESULT_CHARS - JSON.stringify({
        path,
        revision: file.revision,
        offset,
        nextOffset: file.content.length,
        totalChars: file.content.length,
        truncated: true,
        content: "",
    }).length - 16;
    const content = jsonTextPrefix(
        file.content.slice(offset, end),
        Math.min(14_000, budget),
    );
    const nextOffset = offset + content.length;
    return {
        path,
        revision: file.revision,
        content,
        offset,
        nextOffset,
        totalChars: file.content.length,
        truncated: nextOffset < file.content.length,
    };
}

interface SearchMatch {
    path: string;
    line: number;
    column: number;
    text: string;
    truncated: boolean;
}

/** Literal line search with bounded traversal; never follows directory links. */
export async function searchFiles(
    workspace: LocalWorkspace,
    args: Record<string, unknown>,
    signal: AbortSignal,
) {
    fields(args, [
        "path",
        "query",
        "caseSensitive",
        "includeHidden",
        "maxResults",
    ]);
    const path = stringArg(args, "path", ".") || ".";
    const query = stringArg(args, "query");
    if (!query || query.length > 1_024 || /[\r\n\0]/.test(query)) {
        throw new Error("query must contain 1-1024 characters on one line");
    }
    const caseSensitive = booleanArg(args, "caseSensitive", true);
    const includeHidden = booleanArg(args, "includeHidden");
    const maxResults = numberArg(args, "maxResults", 50, 1, 100);
    const pattern = new RegExp(
        query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        caseSensitive ? "u" : "iu",
    );
    const matches: SearchMatch[] = [];
    let scannedFiles = 0;
    let attemptedFiles = 0;
    let skippedFiles = 0;
    let scannedChars = 0;
    let scannedEntries = 0;
    let resultChars = 0;
    let truncated = false;
    let stopped = false;

    async function visit(directory: string, depth: number): Promise<void> {
        signal.throwIfAborted();
        const listing = await workspace.list(directory, signal);
        truncated ||= listing.truncated;
        for (const entry of listing.entries) {
            signal.throwIfAborted();
            if (stopped) return;
            if (++scannedEntries > MAX_SCAN_ENTRIES) {
                truncated = stopped = true;
                return;
            }
            if (!includeHidden && entry.name.startsWith(".")) continue;
            const child = directory === "."
                ? entry.name
                : `${directory}/${entry.name}`;
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
                    skippedFiles++;
                }
            } else if (entry.kind === "file") {
                if (
                    attemptedFiles >= MAX_SCAN_FILES ||
                    scannedChars >= MAX_SCAN_CHARS
                ) {
                    truncated = stopped = true;
                    return;
                }
                attemptedFiles++;
                let content: string;
                try {
                    content = (await workspace.read(child, signal)).content;
                } catch {
                    signal.throwIfAborted();
                    skippedFiles++;
                    // Failed UTF-8/binary reads may have consumed an entire
                    // bounded file. Charge conservatively so failures cannot
                    // bypass the scan budget.
                    scannedChars += MAX_FILE_BYTES;
                    continue;
                }
                scannedFiles++;
                scannedChars += content.length;
                let line = 0;
                for (const text of content.split(/\r?\n/)) {
                    line++;
                    const match = pattern.exec(text);
                    if (match === null) continue;
                    const preview = jsonTextPrefix(
                        text.slice(
                            Math.max(0, match.index - 120),
                            match.index + 1_200,
                        ),
                        2_000,
                    );
                    const item = {
                        path: child,
                        line,
                        column: match.index + 1,
                        text: preview,
                        truncated: preview.length < text.length,
                    };
                    resultChars += JSON.stringify(item).length + 1;
                    if (resultChars > 14_000 || matches.length >= maxResults) {
                        truncated = stopped = true;
                        return;
                    }
                    matches.push(item);
                }
            }
        }
    }
    await visit(path, 0);
    return { matches, scannedFiles, skippedFiles, truncated };
}
