import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { dirname, join } from "node:path";
import { findFiles, readFiles } from "../../plugins/tool-workspace/query.ts";
import { LocalWorkspace } from "../../plugins/tool-workspace/workspace.ts";

const signal = new AbortController().signal;

async function fixture(
    run: (root: string, workspace: LocalWorkspace) => Promise<void>,
) {
    const root = await Deno.makeTempDir({
        prefix: "heimdall-workspace-query-",
    });
    try {
        await run(root, new LocalWorkspace(root));
    } finally {
        await Deno.remove(root, { recursive: true });
    }
}

async function write(root: string, path: string, content = "text") {
    const target = join(root, path);
    await Deno.mkdir(dirname(target), { recursive: true });
    await Deno.writeTextFile(target, content);
}

Deno.test("workspace find supports native glob syntax and workspace-relative scopes", async () => {
    await fixture(async (root, workspace) => {
        for (
            const path of [
                "root.ts",
                "src/main.ts",
                "src/view.tsx",
                "src/deep/module.ts",
                "src/data.json",
                "src/.hidden.ts",
                ".hidden/secret.ts",
                "node_modules/dep.ts",
                ".git/index.ts",
                ".deno/cache.ts",
                "coverage/report.ts",
                "dist/output.ts",
            ]
        ) await write(root, path);

        const result = await findFiles(
            workspace,
            { pattern: "**/*.ts" },
            signal,
        );
        assertEquals(result.paths, [
            "root.ts",
            "src/deep/module.ts",
            "src/main.ts",
        ]);
        assertEquals(result.truncated, false);
        assert(result.scannedEntries > result.paths.length);
        assertEquals(
            (await findFiles(workspace, {
                pattern: "src/*.{ts,tsx}",
                path: ".\\src\\.",
            }, signal)).paths,
            ["src/main.ts", "src/view.tsx"],
        );
        assertEquals(
            (await findFiles(
                workspace,
                { pattern: "*.ts", path: "src" },
                signal,
            ))
                .paths,
            [],
        );
        assertEquals(
            (await findFiles(workspace, {
                pattern: "**/.*.ts",
                includeHidden: true,
            }, signal)).paths,
            ["src/.hidden.ts"],
        );
        assertEquals(
            (await findFiles(workspace, {
                pattern: ".hidden/**/*.ts",
                includeHidden: true,
            }, signal)).paths,
            [".hidden/secret.ts"],
        );
        assertEquals(
            (await findFiles(workspace, {
                pattern: ".git/**/*.ts",
                includeHidden: true,
            }, signal)).paths,
            [],
        );
    });
});

Deno.test("workspace find reports result and depth bounds without following symlinks", async () => {
    await fixture(async (root, workspace) => {
        await write(root, "a.txt");
        await write(root, "b.txt");
        const exact = await findFiles(workspace, {
            pattern: "*.txt",
            maxResults: 2,
        }, signal);
        assertEquals(exact.truncated, false);
        const limited = await findFiles(workspace, {
            pattern: "*.txt",
            maxResults: 1,
        }, signal);
        assertEquals(limited.paths, ["a.txt"]);
        assertEquals(limited.truncated, true);

        await write(root, `${"nested/".repeat(21)}deep.txt`);
        const deep = await findFiles(
            workspace,
            { pattern: "**/*.txt" },
            signal,
        );
        assertEquals(deep.paths, ["a.txt", "b.txt"]);
        assertEquals(deep.truncated, true);

        try {
            await Deno.symlink(join(root, "nested"), join(root, "alias"), {
                type: "junction",
            });
        } catch (error) {
            if (
                Deno.build.os === "windows" &&
                error instanceof Deno.errors.PermissionDenied
            ) return;
            throw error;
        }
        assertEquals(
            (await findFiles(workspace, { pattern: "alias/**" }, signal)).paths,
            [],
        );
    });
});

Deno.test("workspace find limits serialized output and scanned entries", async () => {
    await fixture(async (root, workspace) => {
        const prefix = "x".repeat(180);
        await write(root, "one.txt");
        for (let i = 0; i < 100; i++) {
            await write(root, `${prefix}${i}.txt`);
        }
        const long = await findFiles(workspace, { pattern: "*.txt" }, signal);
        assert(JSON.stringify(long).length < 18_000);
        assert(long.paths.length < 100);
        assertEquals(long.truncated, true);

        await Promise.all(
            Array.from({ length: 3 }, async (_, directory) => {
                const name = `entries-${directory}`;
                await Deno.mkdir(join(root, name));
                for (let i = 0; i < 750; i++) {
                    await Deno.writeTextFile(join(root, name, `${i}.bin`), "");
                }
            }),
        );
        const bounded = await findFiles(workspace, {
            pattern: "**/*.missing",
        }, signal);
        assertEquals(bounded.scannedEntries, 2_000);
        assertEquals(bounded.truncated, true);
    });
});

Deno.test("workspace read many preserves independent errors, revisions and pagination", async () => {
    await fixture(async (root, workspace) => {
        await write(root, "first.txt", "abc😀def");
        await write(root, "second.txt", "longer text");
        const batch = await readFiles(workspace, {
            paths: ["first.txt", "missing.txt", "../escape", "second.txt"],
            limit: 4,
        }, signal);
        assertEquals(batch.files.length, 4);
        assertEquals(batch.truncated, true);
        const first = batch.files[0]!;
        assert("content" in first);
        assertEquals(first.content, "abc");
        assertEquals(first.offset, 0);
        assertEquals(first.nextOffset, 3);
        assertEquals(first.totalChars, 8);
        assertMatch(first.revision, /^[a-f0-9]{64}$/);
        assert("error" in batch.files[1]!);
        assert("error" in batch.files[2]!);
        const next = await readFiles(workspace, {
            paths: ["first.txt"],
            offset: first.nextOffset,
            limit: 1,
        }, signal);
        const emoji = next.files[0]!;
        assert("content" in emoji);
        assertEquals(emoji.content, "😀");
        assertEquals(emoji.nextOffset, 5);
        assertEquals(emoji.revision, first.revision);
        const eof = (await readFiles(workspace, {
            paths: ["first.txt"],
            offset: first.totalChars,
        }, signal)).files[0]!;
        assert("content" in eof);
        assertEquals(eof.content, "");
        assertEquals(eof.truncated, false);
    });
});

Deno.test("workspace read many fits escaped content and long paths while every file advances", async () => {
    await fixture(async (root, workspace) => {
        const content = '\u0001\t"\\😀'.repeat(1_000);
        const paths = Array.from(
            { length: 10 },
            (_, index) => `${"p".repeat(150)}-${index}.txt`,
        );
        await Promise.all(paths.map((path) => write(root, path, content)));
        const result = await readFiles(
            workspace,
            { paths, limit: 4_000 },
            signal,
        );
        assert(JSON.stringify(result).length < 18_000);
        assertEquals(result.files.length, 10);
        for (const file of result.files) {
            assert("content" in file);
            assert(file.nextOffset > 0);
            assertEquals(file.nextOffset, file.content.length);
            assertEquals(file.content, content.slice(0, file.nextOffset));
            assertEquals(file.truncated, true);
            assert(!/[\uD800-\uDBFF]$/.test(file.content));
            const next = (await readFiles(workspace, {
                paths: [file.path],
                offset: file.nextOffset,
                limit: 1,
            }, signal)).files[0]!;
            assert("content" in next);
            assertEquals(next.revision, file.revision);
            assertEquals(next.offset, file.nextOffset);
        }
    });
});

Deno.test("workspace query tools reject malformed input and cancellation", async () => {
    await fixture(async (_root, workspace) => {
        for (
            const args of [
                { pattern: "../*.ts" },
                { pattern: "/**" },
                { pattern: "C:/src/*" },
                { pattern: "" },
                { pattern: "x".repeat(1_025) },
                { pattern: "*", includeHidden: "true" },
                { pattern: "*", maxResults: 101 },
                { pattern: "*", maxResults: 1.5 },
                { pattern: "*", unknown: true },
                { pattern: "*", path: "../" },
            ]
        ) await assertRejects(() => findFiles(workspace, args, signal));
        for (
            const args of [
                { paths: [] },
                { paths: Array(11).fill("a") },
                { paths: [1] },
                { paths: [""] },
                { paths: "a" },
                { paths: ["a"], limit: 4_001 },
                { paths: ["a"], offset: -1 },
                { paths: ["a"], unknown: true },
            ]
        ) await assertRejects(() => readFiles(workspace, args, signal));
        await assertRejects(() =>
            findFiles(workspace, { pattern: "**/*" }, AbortSignal.abort())
        );
        await assertRejects(() =>
            readFiles(workspace, { paths: ["missing"] }, AbortSignal.abort())
        );
    });
});

Deno.test("workspace find rejects brace ranges before matching while preserving alternatives", async () => {
    await fixture(async (root, workspace) => {
        await write(root, "main.ts");
        for (
            const pattern of [
                "{1..1000000000}.ts",
                "{-1000000000..1000000000..2}.ts",
                "{a..z}.ts",
                "{Z..a..2}.ts",
                "{src,{1..1000000000}}/*.ts",
                "{1..{9,1000000000}}.ts",
                "{{1,2}..1000000000}.ts",
            ]
        ) {
            await assertRejects(
                () => findFiles(workspace, { pattern }, signal),
                Error,
                "brace ranges are unsupported",
            );
        }
        assertEquals(
            (await findFiles(workspace, { pattern: "*.{ts,tsx}" }, signal))
                .paths,
            ["main.ts"],
        );
    });
});

Deno.test("workspace find bounds brace alternatives and rejects extglob", async () => {
    await fixture(async (root, workspace) => {
        await write(root, "main.ts");
        for (
            const pattern of [
                `${"{a,b}".repeat(9)}.ts`,
                "{a,b,c,d,e,f,g,h,i,j}.ts",
                `${"{".repeat(9)}main${"}".repeat(9)}.ts`,
                "?(main).ts",
                "*(main).ts",
                "+(main).ts",
                "@(main).ts",
                "!(main).ts",
            ]
        ) {
            await assertRejects(
                () => findFiles(workspace, { pattern }, signal),
                Error,
                "extglob is unsupported",
            );
        }
        for (const pattern of ["**/m?in.[tj]s", "{main,index}.{ts,tsx}"]) {
            assertEquals(
                (await findFiles(workspace, { pattern }, signal)).paths,
                ["main.ts"],
            );
        }
    });
});
