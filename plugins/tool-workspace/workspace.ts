import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const MAX_FILE_BYTES = 1_048_576;
export const MAX_DIRECTORY_ENTRIES = 1000;

type FileContents = { content: string; revision: string };
type WriteResult = { revision: string; created: boolean };
type DirectoryEntry = {
    name: string;
    kind: "file" | "directory" | "symlink" | "other";
};

class WorkspaceError extends Error {}

function checkCancelled(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new WorkspaceError("Workspace operation cancelled.");
    }
}

function components(path: string): string[] {
    if (path.length > 1024) {
        throw new WorkspaceError(
            "Workspace paths must not exceed 1024 characters.",
        );
    }
    if (
        path.includes("\0") || path.includes(":") ||
        /^[\\/]/.test(path) || isAbsolute(path)
    ) {
        throw new WorkspaceError("Use a relative path inside the workspace.");
    }
    const parts = path.split(/[\\/]/).filter((part) => part && part !== ".");
    if (
        parts.some((part) =>
            part === ".." || /[. ]$/.test(part) ||
            /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)
        )
    ) {
        throw new WorkspaceError("Path contains an unsupported component.");
    }
    return parts;
}

function within(root: string, path: string): boolean {
    const difference = relative(root, path);
    return difference === "" ||
        (!isAbsolute(difference) && difference !== ".." &&
            !difference.startsWith("../") && !difference.startsWith("..\\"));
}

function regularFile(info: Deno.FileInfo): void {
    if (!info.isFile || info.isSymlink) {
        throw new WorkspaceError("Path must refer to a regular text file.");
    }
    if (info.nlink !== null && info.nlink > 1) {
        throw new WorkspaceError(
            "Files with multiple hard links are unsupported.",
        );
    }
    if (info.size > MAX_FILE_BYTES) {
        throw new WorkspaceError(
            `File exceeds the ${MAX_FILE_BYTES}-byte limit.`,
        );
    }
}

function decode(bytes: Uint8Array): string {
    let content: string;
    try {
        // Keep a leading BOM as content so read/edit/write is lossless.
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
            .decode(
                bytes,
            );
    } catch {
        throw new WorkspaceError("File must contain valid UTF-8 text.");
    }
    if (content.includes("\0")) {
        throw new WorkspaceError(
            "Binary files containing NUL bytes are unsupported.",
        );
    }
    return content;
}

function encode(content: string): Uint8Array<ArrayBuffer> {
    if (content.length > MAX_FILE_BYTES) {
        throw new WorkspaceError(
            `File exceeds the ${MAX_FILE_BYTES}-byte limit.`,
        );
    }
    const bytes = new TextEncoder().encode(content);
    if (bytes.length > MAX_FILE_BYTES) {
        throw new WorkspaceError(
            `File exceeds the ${MAX_FILE_BYTES}-byte limit.`,
        );
    }
    if (decode(bytes) !== content) {
        throw new WorkspaceError("Content must contain valid Unicode text.");
    }
    return bytes;
}

async function revision(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

function sameFile(left: Deno.FileInfo, right: Deno.FileInfo): boolean {
    return left.ino !== null && right.ino !== null &&
        left.ino === right.ino && left.dev === right.dev;
}

/**
 * Text file operations scoped to a configured directory. Revision checks and
 * serialization protect callers of this instance; they are not an OS sandbox
 * or an atomic compare-and-swap against other filesystem processes.
 */
export class LocalWorkspace {
    readonly #configuredRoot: string;
    #canonicalRoot: Promise<string> | undefined;
    #mutation: Promise<void> = Promise.resolve();

    constructor(root: string, readonly readOnly = false) {
        if (!root.trim() || root.includes("\0")) {
            throw new WorkspaceError("A non-empty workspace root is required.");
        }
        this.#configuredRoot = resolve(root);
    }

    async #run<T>(action: () => Promise<T>): Promise<T> {
        try {
            return await action();
        } catch (error) {
            if (error instanceof WorkspaceError) throw error;
            if (error instanceof Deno.errors.NotFound) {
                throw new WorkspaceError("Workspace path does not exist.");
            }
            if (error instanceof Deno.errors.AlreadyExists) {
                throw new WorkspaceError(
                    "File already exists; read its revision before writing.",
                );
            }
            if (
                error instanceof Deno.errors.PermissionDenied ||
                error instanceof Deno.errors.NotCapable
            ) {
                throw new WorkspaceError("Workspace access was denied.");
            }
            if (error instanceof Deno.errors.NotADirectory) {
                throw new WorkspaceError("A parent path is not a directory.");
            }
            throw new WorkspaceError("Workspace operation failed.");
        }
    }

    async #root(signal: AbortSignal): Promise<string> {
        checkCancelled(signal);
        this.#canonicalRoot ??= Deno.realPath(this.#configuredRoot);
        const root = await this.#canonicalRoot;
        const info = await Deno.lstat(root);
        if (info.isSymlink || !info.isDirectory) {
            throw new WorkspaceError(
                "Configured workspace root must be a directory.",
            );
        }
        if (relative(root, await Deno.realPath(root)) !== "") {
            throw new WorkspaceError("Configured workspace root has moved.");
        }
        checkCancelled(signal);
        return root;
    }

    async #target(
        path: string,
        signal: AbortSignal,
        createParents = false,
        allowMissing = false,
    ): Promise<string> {
        const parts = components(path);
        const root = await this.#root(signal);
        let target = root;
        for (const [index, part] of parts.entries()) {
            checkCancelled(signal);
            target = join(target, part);
            const parent = index < parts.length - 1;
            let info: Deno.FileInfo;
            try {
                info = await Deno.lstat(target);
            } catch (error) {
                if (!(error instanceof Deno.errors.NotFound)) throw error;
                if (parent && createParents) {
                    checkCancelled(signal);
                    try {
                        await Deno.mkdir(target);
                    } catch (mkdirError) {
                        if (
                            !(mkdirError instanceof Deno.errors.AlreadyExists)
                        ) {
                            throw mkdirError;
                        }
                    }
                    info = await Deno.lstat(target);
                } else if (!parent && allowMissing) {
                    checkCancelled(signal);
                    return target;
                } else {
                    throw error;
                }
            }
            if (info.isSymlink) {
                throw new WorkspaceError(
                    "Symbolic links in workspace paths are unsupported.",
                );
            }
            if (parent && !info.isDirectory) {
                throw new WorkspaceError("A parent path is not a directory.");
            }
            if (!within(root, await Deno.realPath(target))) {
                throw new WorkspaceError("Path is outside the workspace.");
            }
        }
        checkCancelled(signal);
        return target;
    }

    async #read(path: string, signal: AbortSignal): Promise<FileContents> {
        const target = await this.#target(path, signal);
        regularFile(await Deno.lstat(target));
        checkCancelled(signal);
        const file = await Deno.open(target, { read: true });
        try {
            regularFile(await file.stat());
            await this.#target(path, signal);
            const buffer = new Uint8Array(MAX_FILE_BYTES + 1);
            let length = 0;
            while (length < buffer.length) {
                checkCancelled(signal);
                const count = await file.read(buffer.subarray(length));
                if (count === null) break;
                length += count;
            }
            if (length > MAX_FILE_BYTES) {
                throw new WorkspaceError(
                    `File exceeds the ${MAX_FILE_BYTES}-byte limit.`,
                );
            }
            const bytes = buffer.slice(0, length);
            const content = decode(bytes);
            const result = { content, revision: await revision(bytes) };
            checkCancelled(signal);
            return result;
        } finally {
            file.close();
        }
    }

    read(path: string, signal: AbortSignal): Promise<FileContents> {
        return this.#run(() => this.#read(path, signal));
    }

    stat(
        path: string,
        signal: AbortSignal,
    ): Promise<{
        kind: "file" | "directory";
        size: number;
        modifiedAt: string | null;
        revision?: string;
    }> {
        return this.#run(async () => {
            const target = await this.#target(path, signal);
            const info = await Deno.lstat(target);
            const modifiedAt = info.mtime?.toISOString() ?? null;
            if (info.isDirectory) {
                checkCancelled(signal);
                return { kind: "directory", size: 0, modifiedAt };
            }
            regularFile(info);
            const file = await this.#read(path, signal);
            return {
                kind: "file",
                size: encode(file.content).length,
                modifiedAt,
                revision: file.revision,
            };
        });
    }

    mkdir(path: string, signal: AbortSignal): Promise<{ created: boolean }> {
        return this.#mutate(signal, async () => {
            const target = await this.#target(path, signal, true, true);
            checkCancelled(signal);
            try {
                await Deno.mkdir(target);
                return { created: true };
            } catch (error) {
                if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
                await this.#target(path, signal);
                if (!(await Deno.lstat(target)).isDirectory) {
                    throw new WorkspaceError(
                        "Path already exists and is not a directory.",
                    );
                }
                checkCancelled(signal);
                return { created: false };
            }
        });
    }

    async #readExpected(
        path: string,
        expectedRevision: string,
        signal: AbortSignal,
    ): Promise<FileContents> {
        const current = await this.#read(path, signal);
        if (current.revision !== expectedRevision) {
            throw new WorkspaceError(
                "File revision does not match; read the file again before editing.",
            );
        }
        return current;
    }

    /** Copy exclusively, verify both files, then remove the source. Not atomic. */
    move(
        path: string,
        destination: string,
        expectedRevision: string,
        signal: AbortSignal,
    ): Promise<{ revision: string }> {
        return this.#mutate(signal, async () => {
            const source = await this.#readExpected(
                path,
                expectedRevision,
                signal,
            );
            const sourcePath = await this.#target(path, signal);
            const sourceInfo = await Deno.lstat(sourcePath);
            regularFile(sourceInfo);
            const target = await this.#target(destination, signal, false, true);
            checkCancelled(signal);
            let file: Deno.FsFile;
            try {
                file = await Deno.open(target, {
                    write: true,
                    createNew: true,
                    mode: (sourceInfo.mode ?? 0o666) & 0o777,
                });
            } catch (error) {
                if (error instanceof Deno.errors.AlreadyExists) {
                    throw new WorkspaceError(
                        "Move destination already exists; choose a new path.",
                    );
                }
                throw error;
            }
            let identity: Deno.FileInfo | undefined;
            let completed = false;
            try {
                try {
                    identity = await file.stat();
                    regularFile(identity);
                    await this.#target(destination, signal);
                    await this.#writeAll(file, encode(source.content), signal);
                } finally {
                    file.close();
                }
                await this.#target(destination, signal);
                if (!sameFile(identity, await Deno.lstat(target))) {
                    throw new WorkspaceError(
                        "Move destination changed; source was preserved.",
                    );
                }
                await this.#readExpected(destination, expectedRevision, signal);
                await this.#readExpected(path, expectedRevision, signal);
                await this.#target(path, signal);
                const currentSourceInfo = await Deno.lstat(sourcePath);
                regularFile(currentSourceInfo);
                if (!sameFile(sourceInfo, currentSourceInfo)) {
                    throw new WorkspaceError(
                        "Move source changed; read the source again.",
                    );
                }
                checkCancelled(signal);
                await Deno.remove(sourcePath);
                completed = true;
                return { revision: source.revision };
            } finally {
                if (!completed && identity) {
                    await this.#removeOwned(target, identity);
                }
            }
        });
    }

    remove(
        path: string,
        expectedRevision: string,
        signal: AbortSignal,
    ): Promise<{ removed: true }> {
        return this.#mutate(signal, async () => {
            await this.#readExpected(path, expectedRevision, signal);
            const target = await this.#target(path, signal);
            regularFile(await Deno.lstat(target));
            checkCancelled(signal);
            await Deno.remove(target);
            return { removed: true };
        });
    }

    list(
        path: string,
        signal: AbortSignal,
    ): Promise<{ entries: DirectoryEntry[]; truncated: boolean }> {
        return this.#run(async () => {
            const target = await this.#target(path, signal);
            if (!(await Deno.lstat(target)).isDirectory) {
                throw new WorkspaceError("Path must refer to a directory.");
            }
            const entries: DirectoryEntry[] = [];
            let truncated = false;
            for await (const entry of Deno.readDir(target)) {
                checkCancelled(signal);
                if (entries.length === MAX_DIRECTORY_ENTRIES) {
                    truncated = true;
                    break;
                }
                entries.push({
                    name: entry.name,
                    kind: entry.isSymlink
                        ? "symlink"
                        : entry.isDirectory
                        ? "directory"
                        : entry.isFile
                        ? "file"
                        : "other",
                });
            }
            entries.sort((left, right) => left.name.localeCompare(right.name));
            checkCancelled(signal);
            return { entries, truncated };
        });
    }

    #mutate<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
        return this.#run(async () => {
            checkCancelled(signal);
            if (this.readOnly) {
                throw new WorkspaceError("Workspace is read-only.");
            }
            const pending = this.#mutation.then(async () => {
                checkCancelled(signal);
                return await action();
            });
            this.#mutation = pending.then(() => {}, () => {});
            return await pending;
        });
    }

    async #writeAll(
        file: Deno.FsFile,
        bytes: Uint8Array,
        signal: AbortSignal,
    ): Promise<void> {
        let offset = 0;
        while (offset < bytes.length) {
            checkCancelled(signal);
            const count = await file.write(bytes.subarray(offset));
            if (count === 0) {
                throw new WorkspaceError("Unable to write file content.");
            }
            offset += count;
        }
        checkCancelled(signal);
        await file.sync();
        checkCancelled(signal);
    }

    async #write(
        path: string,
        content: string,
        expectedRevision: string | undefined,
        signal: AbortSignal,
    ): Promise<WriteResult> {
        const bytes = encode(content);
        const nextRevision = await revision(bytes);
        const target = await this.#target(
            path,
            signal,
            expectedRevision === undefined,
            expectedRevision === undefined,
        );
        if (expectedRevision === undefined) {
            checkCancelled(signal);
            const file = await Deno.open(target, {
                write: true,
                createNew: true,
            });
            let identity: Deno.FileInfo | undefined;
            let completed = false;
            try {
                identity = await file.stat();
                regularFile(identity);
                await this.#target(path, signal);
                await this.#writeAll(file, bytes, signal);
                completed = true;
            } finally {
                file.close();
                if (!completed && identity) {
                    await this.#removeOwned(target, identity);
                }
            }
            return { revision: nextRevision, created: true };
        }

        const current = await this.#read(path, signal);
        if (current.revision !== expectedRevision) {
            throw new WorkspaceError(
                "File revision does not match; read the file again before editing.",
            );
        }
        const originalInfo = await Deno.lstat(target);
        regularFile(originalInfo);
        checkCancelled(signal);
        const temporary = await Deno.makeTempFile({
            dir: dirname(target),
            prefix: ".heimdall-write-",
        });
        let temporaryInfo: Deno.FileInfo | undefined;
        try {
            temporaryInfo = await Deno.lstat(temporary);
            const file = await Deno.open(temporary, { write: true });
            try {
                await this.#writeAll(file, bytes, signal);
            } finally {
                file.close();
            }
            if (Deno.build.os !== "windows" && originalInfo.mode !== null) {
                await Deno.chmod(temporary, originalInfo.mode & 0o777);
            }
            // Check again immediately before replacement, without claiming an
            // atomic revision check against writers outside this instance.
            if (
                (await this.#read(path, signal)).revision !== expectedRevision
            ) {
                throw new WorkspaceError(
                    "File revision does not match; read the file again before editing.",
                );
            }
            await this.#target(path, signal);
            checkCancelled(signal);
            await Deno.rename(temporary, target);
        } finally {
            if (temporaryInfo) {
                await this.#removeOwned(temporary, temporaryInfo);
            }
        }
        return { revision: nextRevision, created: false };
    }

    async #removeOwned(path: string, identity: Deno.FileInfo): Promise<void> {
        try {
            const current = await Deno.lstat(path);
            if (!current.isSymlink && sameFile(identity, current)) {
                await Deno.remove(path);
            }
        } catch {
            // Preserve the original failure; do not remove a replaced path.
        }
    }

    write(
        path: string,
        content: string,
        expectedRevision: string | undefined,
        signal: AbortSignal,
    ): Promise<WriteResult> {
        return this.#mutate(
            signal,
            () => this.#write(path, content, expectedRevision, signal),
        );
    }

    edit(
        path: string,
        expectedRevision: string,
        transform: (content: string) => string,
        signal: AbortSignal,
    ): Promise<WriteResult> {
        return this.#mutate(signal, async () => {
            const current = await this.#read(path, signal);
            if (current.revision !== expectedRevision) {
                throw new WorkspaceError(
                    "File revision does not match; read the file again before editing.",
                );
            }
            let content: string;
            try {
                content = transform(current.content);
            } catch (error) {
                throw new WorkspaceError(
                    error instanceof Error
                        ? error.message
                        : "Content transformation failed.",
                );
            }
            return await this.#write(path, content, expectedRevision, signal);
        });
    }
}
