import { applyPatch, parsePatch, type StructuredPatchHunk } from "diff";
import { MAX_FILE_BYTES } from "./workspace.ts";

export const MAX_PATCH_CHARS = 32_768;
const noNewlineMarker = "\\ No newline at end of file";

function lineCount(content: string): number {
    return content.length === 0
        ? 0
        : content.split("\n").length - Number(content.endsWith("\n"));
}

/**
 * Apply one existing file's unified diff. Headers are validation metadata only;
 * callers choose the target path. jsdiff can relocate hunks to exact matching
 * context, but may never ignore differing context or deletion lines. A final
 * hunk declaring an EOF marker must match its stated position at EOF exactly.
 */
export function applyUnifiedPatch(content: string, patch: string): string {
    if (!patch.trim() || patch.length > MAX_PATCH_CHARS) {
        throw new Error(
            `Patch must contain 1 to ${MAX_PATCH_CHARS} characters`,
        );
    }
    if (
        patch.includes("\0") ||
        /^(?:new file mode|deleted file mode|rename from|rename to|copy from|copy to|Binary files|GIT binary patch)(?:\s|$)/m
            .test(patch)
    ) {
        throw new Error("Patch must only modify one existing text file");
    }
    if ((patch.match(/^diff\s/gm)?.length ?? 0) > 1) {
        throw new Error("Patch must contain exactly one file");
    }
    for (const line of patch.split("\n")) {
        if (
            line.startsWith("@@") &&
            !/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?:.*)$/.test(
                line.replace(/\r$/, ""),
            )
        ) {
            throw new Error("Invalid unified diff hunk header");
        }
    }

    const patches = parsePatch(patch);
    const parsed = patches[0];
    if (patches.length !== 1 || !parsed) {
        throw new Error("Patch must contain exactly one file");
    }
    const oldName = parsed.oldFileName?.replace(/\r$/, "");
    const newName = parsed.newFileName?.replace(/\r$/, "");
    if (
        !oldName?.trim() || !newName?.trim() ||
        oldName === "/dev/null" || newName === "/dev/null"
    ) {
        throw new Error("Patch requires headers for an existing file");
    }
    if (
        oldName !== newName &&
        !(oldName.startsWith("a/") && newName === `b/${oldName.slice(2)}`)
    ) {
        throw new Error("Renaming files through a patch is not supported");
    }
    if (!parsed.hunks.length) {
        throw new Error("Patch must contain at least one non-empty hunk");
    }

    // split() produces a trailing empty slot for a terminal LF, not another
    // source line. Do not allow jsdiff to match or insert beyond the real EOF.
    const sourceLineCount = lineCount(content);
    let oldNoNewline = false;
    let newNoNewline = false;
    for (const [hunkIndex, hunk] of parsed.hunks.entries()) {
        if (
            ![hunk.oldStart, hunk.newStart, hunk.oldLines, hunk.newLines]
                .every((value) => Number.isSafeInteger(value) && value >= 0) ||
            hunk.oldStart < 1 || hunk.newStart < 1 ||
            hunk.oldStart > sourceLineCount + Number(hunk.oldLines === 0) ||
            hunk.oldLines > sourceLineCount
        ) {
            throw new Error(
                "Patch hunk has an invalid or out-of-range position",
            );
        }
        if (!hunk.lines.some((line) => /^[+-]/.test(line))) {
            throw new Error(
                "Patch must contain at least one change in each hunk",
            );
        }
        for (const [lineIndex, line] of hunk.lines.entries()) {
            if (line.startsWith("\\")) {
                const previous = hunk.lines[lineIndex - 1];
                if (
                    line.replace(/\r$/, "") !== noNewlineMarker ||
                    !previous || !/^[ +\-]/.test(previous) ||
                    hunkIndex !== parsed.hunks.length - 1
                ) {
                    throw new Error("Invalid no-newline marker in patch");
                }
                if (previous[0] !== "+") oldNoNewline = true;
                if (previous[0] !== "-") newNoNewline = true;
            } else if (
                (oldNoNewline && line[0] !== "+") ||
                (newNoNewline && line[0] !== "-")
            ) {
                throw new Error("No-newline marker must end its file's lines");
            }
        }
    }
    if (oldNoNewline && content.endsWith("\n")) {
        throw new Error(
            "Patch no-newline marker does not match existing content",
        );
    }

    function applyHunks(
        source: string,
        hunks: StructuredPatchHunk[],
        anchoredLine?: number,
    ): string {
        const count = lineCount(source);
        let anchorMatches = true;
        const result = applyPatch(source, { ...parsed!, hunks }, {
            fuzzFactor: 0,
            autoConvertLineEndings: true,
            compareLine: (lineNumber, line, _operation, patchContent) => {
                const matches = lineNumber >= 1 && lineNumber <= count &&
                    line === patchContent;
                if (anchoredLine !== undefined) {
                    anchorMatches = anchorMatches && matches &&
                        lineNumber === anchoredLine++;
                    return anchorMatches;
                }
                return matches;
            },
        });
        if (result === false) {
            throw new Error("Patch context does not match existing content");
        }
        return result;
    }

    const last = parsed.hunks.at(-1)!;
    if (oldNoNewline || newNoNewline) {
        if (last.oldStart + last.oldLines - 1 !== sourceLineCount) {
            throw new Error(
                "No-newline hunk must match its exact position at EOF",
            );
        }
        // Validate the original EOF before earlier hunks can affect its text.
        const anchoredResult = applyHunks(content, [last], last.oldStart);
        const preceding = parsed.hunks.slice(0, -1);
        if (!preceding.length) return anchoredResult;
        const intermediate = applyHunks(content, preceding);
        const delta = preceding.reduce(
            (sum, hunk) => sum + hunk.newLines - hunk.oldLines,
            0,
        );
        const adjusted = { ...last, oldStart: last.oldStart + delta };
        return applyHunks(intermediate, [adjusted], adjusted.oldStart);
    }
    return applyHunks(content, parsed.hunks);
}

/** Literal text replacement; ambiguity must be explicitly accepted. */
export function replaceText(
    content: string,
    oldText: string,
    newText: string,
    replaceAll = false,
): string {
    if (!oldText.length) {
        throw new Error("oldText must not be empty");
    }
    const first = content.indexOf(oldText);
    if (first < 0) {
        throw new Error("oldText does not match existing content");
    }
    if (!replaceAll && content.indexOf(oldText, first + 1) >= 0) {
        throw new Error("oldText matches multiple locations; use replaceAll");
    }
    let matches = 1;
    if (replaceAll) {
        for (
            let next = content.indexOf(oldText, first + oldText.length);
            next >= 0;
            next = content.indexOf(oldText, next + oldText.length)
        ) {
            matches++;
        }
    }
    // UTF-16 length is a cheap lower bound on UTF-8 bytes for this allocation
    // guard. Workspace writes additionally enforce the exact UTF-8 byte limit.
    const resultLength = content.length + matches *
            (newText.length - oldText.length);
    if (!Number.isSafeInteger(resultLength) || resultLength > MAX_FILE_BYTES) {
        throw new Error(
            `Replacement exceeds the ${MAX_FILE_BYTES}-character limit`,
        );
    }
    return replaceAll
        ? content.split(oldText).join(newText)
        : content.slice(0, first) + newText +
            content.slice(first + oldText.length);
}
