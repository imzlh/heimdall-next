import { assert, assertEquals, assertRejects } from "@std/assert";
import { basename, join, resolve } from "node:path";
import { LocalWorkspace } from "../../plugins/tool-workspace/workspace.ts";

const signal = () => new AbortController().signal;

async function fixture(
    run: (workspace: LocalWorkspace, root: string) => Promise<void>,
) {
    const root = await Deno.makeTempDir({
        prefix: "heimdall-workspace-management-",
    });
    const canonical = await Deno.realPath(root);
    try {
        await run(new LocalWorkspace(root), root);
    } finally {
        assert(basename(root).startsWith("heimdall-workspace-management-"));
        assertEquals(resolve(root), root);
        assertEquals(await Deno.realPath(root), canonical);
        await Deno.remove(root, { recursive: true });
    }
}

Deno.test("workspace stat, recursive mkdir, move and remove preserve text and revisions", async () => {
    await fixture(async (workspace, root) => {
        assertEquals(await workspace.mkdir("one/nested", signal()), {
            created: true,
        });
        assertEquals(await workspace.mkdir("one/nested", signal()), {
            created: false,
        });
        assertEquals(await workspace.mkdir(".", signal()), { created: false });
        const directory = await workspace.stat("one", signal());
        assertEquals(directory.kind, "directory");
        assertEquals(directory.size, 0);
        assertEquals(directory.revision, undefined);
        const content = "\uFEFF你好\r\nworld\r\n";
        const original = await workspace.write(
            "one/nested/file.txt",
            content,
            undefined,
            signal(),
        );
        const metadata = await workspace.stat("one/nested/file.txt", signal());
        assertEquals(metadata.kind, "file");
        assertEquals(metadata.size, new TextEncoder().encode(content).length);
        assertEquals(metadata.revision, original.revision);
        assert(
            metadata.modifiedAt === null ||
                Number.isFinite(Date.parse(metadata.modifiedAt)),
        );
        await workspace.mkdir("two", signal());
        assertEquals(
            await workspace.move(
                "one/nested/file.txt",
                "two/renamed.txt",
                original.revision,
                signal(),
            ),
            { revision: original.revision },
        );
        assertEquals(
            await Deno.readTextFile(join(root, "two/renamed.txt")),
            content,
        );
        await assertRejects(
            () => Deno.lstat(join(root, "one/nested/file.txt")),
            Deno.errors.NotFound,
        );
        assertEquals(
            await workspace.remove(
                "two/renamed.txt",
                original.revision,
                signal(),
            ),
            { removed: true },
        );
        assertEquals((await workspace.list("two", signal())).entries, []);
    });
});

Deno.test("workspace management rejects stale revisions, existing destinations and directories", async () => {
    await fixture(async (workspace, root) => {
        const source = await workspace.write(
            "source.txt",
            "source",
            undefined,
            signal(),
        );
        await workspace.write(
            "destination.txt",
            "destination",
            undefined,
            signal(),
        );
        await workspace.mkdir("directory", signal());
        await assertRejects(
            () => workspace.move("source.txt", "new.txt", "stale", signal()),
            Error,
            "revision",
        );
        await assertRejects(
            () => workspace.remove("source.txt", "stale", signal()),
            Error,
            "revision",
        );
        for (
            const destination of ["destination.txt", "directory", "source.txt"]
        ) {
            await assertRejects(() =>
                workspace.move(
                    "source.txt",
                    destination,
                    source.revision,
                    signal(),
                )
            );
        }
        await assertRejects(
            () =>
                workspace.move(
                    "source.txt",
                    "missing/new.txt",
                    source.revision,
                    signal(),
                ),
            Error,
            "does not exist",
        );
        await assertRejects(
            () => workspace.move("directory", "new", source.revision, signal()),
            Error,
            "regular text file",
        );
        await assertRejects(
            () => workspace.remove("directory", source.revision, signal()),
            Error,
            "regular text file",
        );
        await assertRejects(
            () => workspace.mkdir("source.txt", signal()),
            Error,
            "not a directory",
        );
        assertEquals(
            await Deno.readTextFile(join(root, "source.txt")),
            "source",
        );
        assertEquals(
            await Deno.readTextFile(join(root, "destination.txt")),
            "destination",
        );
        await Deno.writeFile(join(root, "binary"), new Uint8Array([0]));
        await assertRejects(
            () => workspace.stat("binary", signal()),
            Error,
            "NUL",
        );
        await assertRejects(
            () => workspace.remove("binary", source.revision, signal()),
            Error,
            "NUL",
        );
    });
});

Deno.test("workspace management respects read-only, cancellation and relative path boundaries", async () => {
    await fixture(async (workspace, root) => {
        const source = await workspace.write(
            "source.txt",
            "source",
            undefined,
            signal(),
        );
        const readOnly = new LocalWorkspace(root, true);
        assertEquals(
            (await readOnly.stat("source.txt", signal())).revision,
            source.revision,
        );
        await assertRejects(
            () => readOnly.mkdir("new", signal()),
            Error,
            "read-only",
        );
        await assertRejects(
            () =>
                readOnly.move(
                    "source.txt",
                    "new.txt",
                    source.revision,
                    signal(),
                ),
            Error,
            "read-only",
        );
        await assertRejects(
            () => readOnly.remove("source.txt", source.revision, signal()),
            Error,
            "read-only",
        );
        const aborted = AbortSignal.abort();
        await assertRejects(
            () => workspace.stat("source.txt", aborted),
            Error,
            "cancelled",
        );
        await assertRejects(
            () => workspace.mkdir("new/nested", aborted),
            Error,
            "cancelled",
        );
        await assertRejects(
            () =>
                workspace.move(
                    "source.txt",
                    "new.txt",
                    source.revision,
                    aborted,
                ),
            Error,
            "cancelled",
        );
        await assertRejects(
            () => workspace.remove("source.txt", source.revision, aborted),
            Error,
            "cancelled",
        );
        await assertRejects(() => workspace.stat("../outside", signal()));
        await assertRejects(() => workspace.mkdir("../outside", signal()));
        await assertRejects(() =>
            workspace.move(
                "source.txt",
                "../outside",
                source.revision,
                signal(),
            )
        );
        await assertRejects(() =>
            workspace.remove("../outside", source.revision, signal())
        );
        assertEquals((await workspace.list(".", signal())).entries, [{
            name: "source.txt",
            kind: "file",
        }]);
    });
});

Deno.test("workspace interrupted moves clean their new destination and preserve the source", async () => {
    await fixture(async (workspace, root) => {
        const source = await workspace.write(
            "source.txt",
            "source",
            undefined,
            signal(),
        );
        const controller = new AbortController();
        const open = Deno.open;
        Deno.open = async (path, options) => {
            const file = await open(path, options);
            if (options?.createNew) controller.abort();
            return file;
        };
        try {
            await assertRejects(
                () =>
                    workspace.move(
                        "source.txt",
                        "new.txt",
                        source.revision,
                        controller.signal,
                    ),
                Error,
                "cancelled",
            );
        } finally {
            Deno.open = open;
        }
        assertEquals(
            await Deno.readTextFile(join(root, "source.txt")),
            "source",
        );
        assertEquals((await workspace.list(".", signal())).entries, [{
            name: "source.txt",
            kind: "file",
        }]);
    });
});

Deno.test("workspace moves preserve an externally changed source and remove the incomplete copy", async () => {
    await fixture(async (workspace, root) => {
        const source = await workspace.write(
            "source.txt",
            "source",
            undefined,
            signal(),
        );
        const open = Deno.open;
        Deno.open = async (path, options) => {
            const file = await open(path, options);
            if (options?.createNew) {
                await Deno.writeTextFile(
                    join(root, "source.txt"),
                    "changed externally",
                );
            }
            return file;
        };
        try {
            await assertRejects(
                () =>
                    workspace.move(
                        "source.txt",
                        "new.txt",
                        source.revision,
                        signal(),
                    ),
                Error,
                "revision",
            );
        } finally {
            Deno.open = open;
        }
        assertEquals(
            await Deno.readTextFile(join(root, "source.txt")),
            "changed externally",
        );
        assertEquals((await workspace.list(".", signal())).entries, [{
            name: "source.txt",
            kind: "file",
        }]);
    });
});

Deno.test("workspace management refuses symbolic links when supported", async () => {
    await fixture(async (workspace, root) => {
        const source = await workspace.write(
            "source.txt",
            "source",
            undefined,
            signal(),
        );
        try {
            await Deno.symlink(
                join(root, "source.txt"),
                join(root, "link.txt"),
                { type: "file" },
            );
        } catch (error) {
            if (
                error instanceof Deno.errors.PermissionDenied ||
                error instanceof Deno.errors.NotSupported
            ) return;
            throw error;
        }
        await assertRejects(
            () => workspace.stat("link.txt", signal()),
            Error,
            "Symbolic links",
        );
        await assertRejects(
            () => workspace.mkdir("link.txt/nested", signal()),
            Error,
            "Symbolic links",
        );
        await assertRejects(
            () =>
                workspace.move(
                    "link.txt",
                    "new.txt",
                    source.revision,
                    signal(),
                ),
            Error,
            "Symbolic links",
        );
        await assertRejects(
            () =>
                workspace.move(
                    "source.txt",
                    "link.txt",
                    source.revision,
                    signal(),
                ),
            Error,
            "Symbolic links",
        );
        await assertRejects(
            () => workspace.remove("link.txt", source.revision, signal()),
            Error,
            "Symbolic links",
        );
        assertEquals(
            await Deno.readTextFile(join(root, "source.txt")),
            "source",
        );
    });
});
