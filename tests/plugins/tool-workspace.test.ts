import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { join } from "node:path";
import { validateWorkspaceConfig } from "../../plugins/tool-workspace/config.ts";
import {
    createWorkspaceToolPlugin,
    toolPlugin,
} from "../../plugins/tool-workspace/mod.ts";
import {
    createChatToolset,
    newRunBudget,
} from "@heimdall/core/chat/tools/toolset.ts";

async function fixture(run: (root: string, invoke: Invoke) => Promise<void>) {
    const root = await Deno.makeTempDir({
        prefix: "heimdall-workspace-tools-",
    });
    const toolset = createChatToolset([createWorkspaceToolPlugin({ root })]);
    const invoke: Invoke = (name, args) =>
        toolset.run(
            {
                callId: crypto.randomUUID(),
                name,
                argumentsText: JSON.stringify(args),
            },
            newRunBudget(),
            new AbortController().signal,
        );
    try {
        await run(root, invoke);
    } finally {
        await Deno.remove(root, { recursive: true });
    }
}

type Invoke = (
    name: string,
    args: Record<string, unknown>,
) => Promise<{ text: string; isError: boolean }>;

Deno.test("workspace tools write, read, patch and reject stale or ambiguous edits", async () => {
    await fixture(async (root, invoke) => {
        const created = await invoke("workspace_write", {
            path: "src/test.txt",
            content: "first\r\nsecond\r\n",
        });
        assertEquals(created.isError, false);
        const read = await invoke("workspace_read", { path: "src/test.txt" });
        assertEquals(read.isError, false);
        const { revision } = JSON.parse(read.text);
        const patched = await invoke("workspace_patch", {
            path: "src/test.txt",
            expectedRevision: revision,
            patch:
                "--- a/src/test.txt\n+++ b/src/test.txt\n@@ -1,2 +1,2 @@\n first\n-second\n+changed\n",
        });
        assertEquals(patched.isError, false, patched.text);
        assertEquals(
            await Deno.readTextFile(join(root, "src/test.txt")),
            "first\r\nchanged\r\n",
        );
        const stale = await invoke("workspace_write", {
            path: "src/test.txt",
            content: "overwrite",
            expectedRevision: revision,
        });
        assertEquals(stale.isError, true);
        assertMatch(stale.text, /revision/i);
        const noRevision = await invoke("workspace_write", {
            path: "src/test.txt",
            content: "overwrite",
        });
        assertEquals(noRevision.isError, true);
        const mismatch = await invoke("workspace_patch", {
            path: "src/test.txt",
            expectedRevision: JSON.parse(patched.text).revision,
            patch:
                "--- a/test\n+++ b/test\n@@ -1 +1 @@\n-missing\n+replacement\n",
        });
        assertEquals(mismatch.isError, true);
        assertEquals(
            await Deno.readTextFile(join(root, "src/test.txt")),
            "first\r\nchanged\r\n",
        );

        const repeated = await invoke("workspace_write", {
            path: "repeat.txt",
            content: "same same",
        });
        const args = {
            path: "repeat.txt",
            oldText: "same",
            newText: "new",
            expectedRevision: JSON.parse(repeated.text).revision,
        };
        assertEquals((await invoke("workspace_edit", args)).isError, true);
        assertEquals(
            await Deno.readTextFile(join(root, "repeat.txt")),
            "same same",
        );
        assertEquals(
            (await invoke("workspace_edit", { ...args, replaceAll: true }))
                .isError,
            false,
        );
        assertEquals(
            await Deno.readTextFile(join(root, "repeat.txt")),
            "new new",
        );
    });
});

Deno.test("workspace read pages escaped long lines without host result truncation", async () => {
    await fixture(async (root, invoke) => {
        const content = '头\t\u0001"\\😀'.repeat(5_000);
        await Deno.writeTextFile(join(root, "long.txt"), content);
        let offset = 0;
        let reconstructed = "";
        let revision: string | undefined;
        do {
            const result = await invoke("workspace_read", {
                path: "long.txt",
                offset,
            });
            assertEquals(result.isError, false, result.text);
            assert(result.text.length <= 18_000);
            const page = JSON.parse(result.text);
            revision ??= page.revision;
            assertEquals(page.revision, revision);
            assertEquals(page.offset, offset);
            assert(page.nextOffset > offset);
            reconstructed += page.content;
            offset = page.nextOffset;
            assertEquals(page.truncated, offset < content.length);
        } while (offset < content.length);
        assertEquals(reconstructed, content);
        assertEquals(
            (await invoke("workspace_read", {
                path: "long.txt",
                offset: content.length + 1,
            })).isError,
            true,
        );
        const eof = await invoke("workspace_read", {
            path: "long.txt",
            offset: content.length,
        });
        assertEquals(JSON.parse(eof.text).content, "");
        await Deno.writeTextFile(join(root, "emoji.txt"), "😀x");
        const emoji = JSON.parse(
            (await invoke("workspace_read", {
                path: "emoji.txt",
                limit: 1,
            })).text,
        );
        assertEquals(emoji.content, "😀");
        assertEquals(emoji.nextOffset, 2);
        assertEquals(
            (await invoke("workspace_read", { path: "emoji.txt", offset: 1 }))
                .isError,
            true,
        );
    });
});

Deno.test("workspace search is literal, bounded and reports skipped files", async () => {
    await fixture(async (root, invoke) => {
        await Deno.mkdir(join(root, "src"));
        await Deno.mkdir(join(root, "node_modules"));
        await Deno.writeTextFile(
            join(root, "src", "sample.txt"),
            "a.b here\naxb does not match\nA.B there\na.b again\n",
        );
        await Deno.writeTextFile(join(root, ".hidden"), "a.b\n");
        await Deno.writeTextFile(
            join(root, "node_modules", "dep.txt"),
            "a.b\n",
        );
        await Deno.writeFile(join(root, "binary"), new Uint8Array([0]));
        const result = await invoke("workspace_search", { query: "a.b" });
        assertEquals(result.isError, false, result.text);
        const data = JSON.parse(result.text);
        assertEquals(data.matches.map((item: { line: number }) => item.line), [
            1,
            4,
        ]);
        assertEquals(data.matches[0].path, "src/sample.txt");
        assertEquals(data.matches[0].column, 1);
        assertEquals(data.skippedFiles, 1);
        const emptyRoot = await invoke("workspace_search", {
            query: "a.b",
            path: "",
        });
        assertEquals(JSON.parse(emptyRoot.text).matches, data.matches);
        const limited = await invoke("workspace_search", {
            path: "src",
            query: "A.B",
            caseSensitive: false,
            maxResults: 1,
        });
        assertEquals(JSON.parse(limited.text).matches.length, 1);
        assertEquals(JSON.parse(limited.text).truncated, true);
        const hidden = await invoke("workspace_search", {
            query: "a.b",
            includeHidden: true,
        });
        assertEquals(JSON.parse(hidden.text).matches.length, 3);
        const listing = await invoke("workspace_list", {});
        assertEquals(
            JSON.parse(listing.text).entries.some((item: { name: string }) =>
                item.name === "src"
            ),
            true,
        );
    });
});

Deno.test("workspace search charges failed reads against the traversal budget", async () => {
    await fixture(async (root, invoke) => {
        for (let i = 0; i < 6; i++) {
            await Deno.writeFile(
                join(root, `binary-${i}`),
                new Uint8Array([0]),
            );
        }
        const result = await invoke("workspace_search", { query: "anything" });
        assertEquals(result.isError, false);
        const data = JSON.parse(result.text);
        assertEquals(data.scannedFiles, 0);
        assertEquals(data.skippedFiles, 4);
        assertEquals(data.truncated, true);
    });
});

Deno.test("workspace tool validation rejects malformed input and cancellation before mutation", async () => {
    await fixture(async (root, invoke) => {
        for (
            const args of [
                { path: "file", content: "text", unexpected: true },
                { path: "file", content: 3 },
                { path: "file", content: "text", expectedRevision: "bad" },
                { path: "../escape", content: "text" },
            ]
        ) {
            assertEquals((await invoke("workspace_write", args)).isError, true);
        }
        const plugin = createWorkspaceToolPlugin({ root });
        const writer = plugin.tools.find((tool) =>
            tool.definition.name === "workspace_write"
        )!;
        for (const argumentsText of ["[]", "null", "{", "x".repeat(32_769)]) {
            const result = await writer.execute({
                name: "workspace_write",
                callId: "bad",
                argumentsText,
            }, {
                budget: newRunBudget(),
                signal: new AbortController().signal,
            });
            assertEquals(result.isError, true);
        }
        const result = await writer.execute({
            name: "workspace_write",
            callId: "aborted",
            argumentsText: JSON.stringify({ path: "file", content: "text" }),
        }, { budget: newRunBudget(), signal: AbortSignal.abort() });
        assertEquals(result.isError, true);
        assertMatch(result.text, /cancelled/i);
        assertEquals(Array.from(Deno.readDirSync(root)), []);
    });
});

Deno.test("workspace factory requires explicit root and omits mutations in read-only mode", () => {
    const env = () => {
        throw new Error("Workspace must never read environment variables");
    };
    assertEquals(toolPlugin.create({ env }).tools, []);
    const plugin = toolPlugin.create({
        env,
        config: { root: Deno.cwd(), readOnly: true },
    });
    assertEquals(plugin.tools.map((tool) => tool.definition.name), [
        "workspace_list",
        "workspace_read",
        "workspace_search",
        "workspace_find",
        "workspace_read_many",
        "workspace_stat",
    ]);
});

Deno.test("workspace configuration validates persisted directory settings without environment access", async () => {
    await fixture(async (root) => {
        assertEquals(await validateWorkspaceConfig({ root, readOnly: true }), {
            root: await Deno.realPath(root),
            readOnly: true,
        });
        assertEquals(await validateWorkspaceConfig({}), {
            root: "",
            readOnly: false,
        });
        for (
            const config of [
                { root: "relative/path" },
                { root, readOnly: "true" },
                { root, extra: true },
                { root: join(root, "missing") },
                { root: null },
            ]
        ) await assertRejects(() => validateWorkspaceConfig(config), TypeError);
        await Deno.writeTextFile(join(root, "not-directory"), "text");
        await assertRejects(
            () =>
                validateWorkspaceConfig({ root: join(root, "not-directory") }),
            TypeError,
        );
    });
});
