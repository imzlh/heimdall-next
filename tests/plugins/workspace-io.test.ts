import {
    assert,
    assertEquals,
    assertMatch,
    assertNotEquals,
    assertRejects,
    assertThrows,
} from "@std/assert";
import { basename, join, resolve } from "node:path";
import {
    LocalWorkspace,
    MAX_DIRECTORY_ENTRIES,
    MAX_FILE_BYTES,
} from "../../plugins/tool-workspace/workspace.ts";

const signal = () => new AbortController().signal;

async function withWorkspace(
    test: (workspace: LocalWorkspace, root: string) => Promise<void>,
): Promise<void> {
    const root = await Deno.makeTempDir({ prefix: "heimdall-workspace-io-" });
    const canonicalRoot = await Deno.realPath(root);
    try {
        await test(new LocalWorkspace(root), root);
    } finally {
        assertEquals(await Deno.realPath(root), canonicalRoot);
        assert(basename(root).startsWith("heimdall-workspace-io-"));
        assertEquals(resolve(root), root);
        await Deno.remove(root, { recursive: true });
    }
}

Deno.test("workspace creates parent directories and preserves UTF-8, BOM, and CRLF", async () => {
    await withWorkspace(async (workspace, root) => {
        const content = "\uFEFF你好\r\nsecond line\r\n";
        const written = await workspace.write(
            "src\\nested\\file.txt",
            content,
            undefined,
            signal(),
        );
        assertEquals(written.created, true);
        assertMatch(written.revision, /^[a-f0-9]{64}$/);
        assertEquals(await workspace.read("src/nested/file.txt", signal()), {
            content,
            revision: written.revision,
        });
        assertEquals(
            await Deno.readFile(join(root, "src/nested/file.txt")),
            new TextEncoder().encode(content),
        );
        assertEquals(await workspace.list("src", signal()), {
            entries: [{ name: "nested", kind: "directory" }],
            truncated: false,
        });
        assertEquals(await workspace.list("src/nested", signal()), {
            entries: [{ name: "file.txt", kind: "file" }],
            truncated: false,
        });
    });
});

Deno.test("workspace requires matching revisions and serializes concurrent edits", async () => {
    await withWorkspace(async (workspace, root) => {
        const original = await workspace.write(
            "file.txt",
            "a",
            undefined,
            signal(),
        );
        assertEquals(
            original.revision,
            "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
        );
        await assertRejects(
            () => workspace.write("file.txt", "b", undefined, signal()),
            Error,
            "already exists",
        );
        await assertRejects(
            () => workspace.write("file.txt", "b", "stale", signal()),
            Error,
            "revision does not match",
        );
        let transformations = 0;
        const transform = (content: string) => {
            transformations++;
            return `${content}\r\nb`;
        };
        const results = await Promise.allSettled([
            workspace.edit("file.txt", original.revision, transform, signal()),
            workspace.edit("file.txt", original.revision, transform, signal()),
        ]);
        assertEquals(
            results.filter((result) => result.status === "fulfilled").length,
            1,
        );
        assertEquals(transformations, 1);
        const current = await workspace.read("file.txt", signal());
        assertEquals(current.content, "a\r\nb");
        assertNotEquals(current.revision, original.revision);
        assertEquals(
            await Array.fromAsync(Deno.readDir(root)).then((entries) =>
                entries.map((entry) => entry.name)
            ),
            ["file.txt"],
        );
        const rewritten = await workspace.write(
            "file.txt",
            "",
            current.revision,
            signal(),
        );
        assertEquals(rewritten.created, false);
        assertEquals((await workspace.read("file.txt", signal())).content, "");
    });
});

Deno.test("workspace rejects read-only writes and cancelled operations without changing files", async () => {
    await withWorkspace(async (workspace, root) => {
        const original = await workspace.write(
            "file.txt",
            "original",
            undefined,
            signal(),
        );
        const readOnly = new LocalWorkspace(root, true);
        assertEquals(
            (await readOnly.read("file.txt", signal())).content,
            "original",
        );
        await assertRejects(
            () => readOnly.write("new/other.txt", "other", undefined, signal()),
            Error,
            "read-only",
        );
        await assertRejects(
            () =>
                readOnly.edit(
                    "file.txt",
                    original.revision,
                    () => "other",
                    signal(),
                ),
            Error,
            "read-only",
        );
        const controller = new AbortController();
        await assertRejects(
            () =>
                workspace.edit("file.txt", original.revision, () => {
                    controller.abort();
                    return "other";
                }, controller.signal),
            Error,
            "cancelled",
        );
        await assertRejects(
            () => workspace.read("file.txt", controller.signal),
            Error,
            "cancelled",
        );
        await assertRejects(
            () => workspace.list(".", controller.signal),
            Error,
            "cancelled",
        );
        await assertRejects(
            () =>
                workspace.write(
                    "new.txt",
                    "other",
                    undefined,
                    controller.signal,
                ),
            Error,
            "cancelled",
        );
        assertEquals(
            await Deno.readTextFile(join(root, "file.txt")),
            "original",
        );
        assertEquals((await workspace.list(".", signal())).entries, [{
            name: "file.txt",
            kind: "file",
        }]);
    });
});

Deno.test("workspace rejects traversal, absolute paths, Windows aliases, and host path disclosure", async () => {
    assertThrows(() => new LocalWorkspace("  "), Error, "root is required");
    await withWorkspace(async (workspace, root) => {
        for (
            const path of [
                "../outside.txt",
                "inside/../../outside.txt",
                "..\\outside.txt",
                "/outside.txt",
                "C:\\outside.txt",
                "C:outside.txt",
                "\\\\host\\share\\file.txt",
                "file.txt:stream",
                "nul.txt",
                "folder./file.txt",
                "folder /file.txt",
                "file\0.txt",
                "a".repeat(1025),
            ]
        ) {
            await assertRejects(() =>
                workspace.write(path, "other", undefined, signal())
            );
        }
        const error = await assertRejects(() =>
            workspace.read("missing.txt", signal())
        );
        assert(error instanceof Error);
        assert(!error.message.includes(root));
        assertEquals((await workspace.list("", signal())).entries, []);
        await assertRejects(
            () => workspace.read(".", signal()),
            Error,
            "regular text file",
        );
    });
});

Deno.test("workspace cleans interrupted creations and temporary replacement files", async () => {
    await withWorkspace(async (workspace, root) => {
        const original = await workspace.write(
            "file.txt",
            "original",
            undefined,
            signal(),
        );
        const controller = new AbortController();
        const makeTempFile = Deno.makeTempFile;
        Deno.makeTempFile = async (options) => {
            const temporary = await makeTempFile(options);
            controller.abort();
            return temporary;
        };
        try {
            await assertRejects(
                () =>
                    workspace.write(
                        "file.txt",
                        "replacement",
                        original.revision,
                        controller.signal,
                    ),
                Error,
                "cancelled",
            );
        } finally {
            Deno.makeTempFile = makeTempFile;
        }
        const creation = new AbortController();
        const open = Deno.open;
        Deno.open = async (path, options) => {
            const file = await open(path, options);
            if (options?.createNew) creation.abort();
            return file;
        };
        try {
            await assertRejects(
                () =>
                    workspace.write(
                        "new.txt",
                        "new",
                        undefined,
                        creation.signal,
                    ),
                Error,
                "cancelled",
            );
        } finally {
            Deno.open = open;
        }
        assertEquals(
            await Deno.readTextFile(join(root, "file.txt")),
            "original",
        );
        assertEquals((await workspace.list(".", signal())).entries, [{
            name: "file.txt",
            kind: "file",
        }]);
    });
});

Deno.test("workspace bounds file bytes and rejects binary or invalid text", async () => {
    await withWorkspace(async (workspace, root) => {
        await Deno.writeFile(
            join(root, "binary.txt"),
            new Uint8Array([97, 0, 98]),
        );
        await Deno.writeFile(
            join(root, "invalid.txt"),
            new Uint8Array([0xc0, 0xaf]),
        );
        await Deno.writeFile(
            join(root, "large.txt"),
            new Uint8Array(MAX_FILE_BYTES + 1),
        );
        await assertRejects(
            () => workspace.read("binary.txt", signal()),
            Error,
            "NUL",
        );
        await assertRejects(
            () => workspace.read("invalid.txt", signal()),
            Error,
            "UTF-8",
        );
        await assertRejects(
            () => workspace.read("large.txt", signal()),
            Error,
            "byte limit",
        );
        for (
            const content of [
                "\0",
                "\ud800",
                "x".repeat(MAX_FILE_BYTES + 1),
                "好".repeat(MAX_FILE_BYTES / 2),
            ]
        ) {
            await assertRejects(() =>
                workspace.write("new.txt", content, undefined, signal())
            );
        }
        const content = "x".repeat(MAX_FILE_BYTES);
        const result = await workspace.write(
            "maximum.txt",
            content,
            undefined,
            signal(),
        );
        assertEquals(await workspace.read("maximum.txt", signal()), {
            content,
            revision: result.revision,
        });
    });
});

Deno.test("workspace directory listings stop at the configured entry limit", async () => {
    await withWorkspace(async (workspace, root) => {
        for (let offset = 0; offset < MAX_DIRECTORY_ENTRIES + 1; offset += 50) {
            await Promise.all(
                Array.from({
                    length: Math.min(50, MAX_DIRECTORY_ENTRIES + 1 - offset),
                }, (_, index) =>
                    Deno.writeTextFile(
                        join(root, `${offset + index}.txt`),
                        "",
                    )),
            );
        }
        const result = await workspace.list(".", signal());
        assertEquals(result.entries.length, MAX_DIRECTORY_ENTRIES);
        assertEquals(result.truncated, true);
    });
});

Deno.test("workspace rejects symbolic links and hard links when supported", async () => {
    await withWorkspace(async (workspace, root) => {
        const outside = join(root, "outside");
        const inside = join(root, "inside");
        await Deno.mkdir(outside);
        await Deno.mkdir(inside);
        await Deno.writeTextFile(join(outside, "file.txt"), "original");
        const scoped = new LocalWorkspace(inside);
        try {
            await Deno.symlink(outside, join(inside, "linked"), {
                type: "dir",
            });
            await Deno.symlink(
                join(outside, "file.txt"),
                join(inside, "linked.txt"),
                { type: "file" },
            );
        } catch (error) {
            if (
                !(error instanceof Deno.errors.PermissionDenied) &&
                !(error instanceof Deno.errors.NotSupported)
            ) throw error;
            return;
        }
        await assertRejects(
            () => scoped.read("linked/file.txt", signal()),
            Error,
            "Symbolic links",
        );
        await assertRejects(
            () => scoped.read("linked.txt", signal()),
            Error,
            "Symbolic links",
        );
        await assertRejects(
            () => scoped.list("linked", signal()),
            Error,
            "Symbolic links",
        );
        await assertRejects(
            () => scoped.write("linked/new.txt", "other", undefined, signal()),
            Error,
            "Symbolic links",
        );
        await assertRejects(
            () => scoped.write("linked.txt", "other", undefined, signal()),
            Error,
            "Symbolic links",
        );
        assertEquals(
            (await scoped.list(".", signal())).entries.every((entry) =>
                entry.kind === "symlink"
            ),
            true,
        );
        await Deno.link(join(outside, "file.txt"), join(inside, "hard.txt"));
        if ((await Deno.lstat(join(inside, "hard.txt"))).nlink !== null) {
            await assertRejects(
                () => scoped.read("hard.txt", signal()),
                Error,
                "hard links",
            );
            await assertRejects(
                () => scoped.write("hard.txt", "other", "stale", signal()),
                Error,
                "hard links",
            );
        }
        assertEquals(
            await Deno.readTextFile(join(outside, "file.txt")),
            "original",
        );
        assertEquals((await workspace.list(".", signal())).entries.length, 2);
    });
});
