import { assert, assertEquals, assertRejects } from "@std/assert";
import {
    createChatToolset,
    newRunBudget,
} from "@heimdall/core/chat/tools/toolset.ts";
import { createWorkspaceToolPlugin } from "../../plugins/tool-workspace/mod.ts";

function workspaceTools(root: string, readOnly = false) {
    const tools = createChatToolset([
        createWorkspaceToolPlugin({ root, readOnly }),
    ]);
    const budget = newRunBudget();
    const invoke = (name: string, args: Record<string, unknown>) =>
        tools.run(
            {
                callId: crypto.randomUUID(),
                name,
                argumentsText: JSON.stringify(args),
            },
            budget,
            new AbortController().signal,
        );
    const run = async (name: string, args: Record<string, unknown>) => {
        const result = await invoke(name, args);
        assertEquals(result.isError, false, `${name}: ${result.text}`);
        return JSON.parse(result.text) as Record<string, unknown>;
    };
    return { tools, invoke, run };
}

Deno.test("workspace public tools create, inspect, move, discover and remove a revision-checked file", async () => {
    const root = await Deno.makeTempDir({
        prefix: "heimdall-workspace-workflow-",
    });
    const { invoke, run } = workspaceTools(root);
    try {
        await run("workspace_mkdir", { path: "source/nested" });
        await run("workspace_mkdir", { path: "archive" });
        assert((await Deno.stat(`${root}/source/nested`)).isDirectory);
        const content = "maintenance fixture\n第二行\n";
        const written = await run("workspace_write", {
            path: "source/nested/note.txt",
            content,
        });
        const inspected = await run("workspace_stat", {
            path: "source/nested/note.txt",
        });
        assertEquals(inspected.kind, "file");
        assertEquals(inspected.size, new TextEncoder().encode(content).length);
        assertEquals(inspected.revision, written.revision);
        const revision = inspected.revision;
        assert(typeof revision === "string" && revision.length > 0);

        const staleMove = await invoke("workspace_move", {
            path: "source/nested/note.txt",
            destination: "archive/note.txt",
            expectedRevision: "0".repeat(64),
        });
        assertEquals(staleMove.isError, true);
        assertEquals(
            await Deno.readTextFile(`${root}/source/nested/note.txt`),
            content,
        );
        await assertRejects(
            () => Deno.stat(`${root}/archive/note.txt`),
            Deno.errors.NotFound,
        );

        const moved = await run("workspace_move", {
            path: "source/nested/note.txt",
            destination: "archive/note.txt",
            expectedRevision: revision,
        });
        assertEquals(moved.revision, revision);
        await assertRejects(
            () => Deno.stat(`${root}/source/nested/note.txt`),
            Deno.errors.NotFound,
        );
        assertEquals(
            await Deno.readTextFile(`${root}/archive/note.txt`),
            content,
        );
        const found = await run("workspace_find", { pattern: "**/*.txt" });
        assertEquals(found.paths, ["archive/note.txt"]);
        assertEquals(found.truncated, false);
        const read = await run("workspace_read_many", {
            paths: ["archive/note.txt"],
        });
        assert(Array.isArray(read.files));
        assertEquals(read.files.length, 1);
        assertEquals(read.files[0].path, "archive/note.txt");
        assertEquals(read.files[0].content, content);
        assertEquals(read.files[0].revision, revision);
        assertEquals(read.truncated, false);

        const staleRemove = await invoke("workspace_remove", {
            path: "archive/note.txt",
            expectedRevision: "0".repeat(64),
        });
        assertEquals(staleRemove.isError, true);
        assertEquals(
            await Deno.readTextFile(`${root}/archive/note.txt`),
            content,
        );
        const removed = await run("workspace_remove", {
            path: "archive/note.txt",
            expectedRevision: revision,
        });
        assertEquals(removed.removed, true);
        await assertRejects(
            () => Deno.stat(`${root}/archive/note.txt`),
            Deno.errors.NotFound,
        );
        assertEquals(
            (await run("workspace_find", { pattern: "**/*.txt" })).paths,
            [],
        );
        assertEquals(
            (await run("workspace_stat", { path: "archive" })).kind,
            "directory",
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("workspace read-only toolset exposes all query tools and rejects every mutation", async () => {
    const root = await Deno.makeTempDir({
        prefix: "heimdall-workspace-query-only-",
    });
    const content = "Keep this file unchanged.\n";
    await Deno.writeTextFile(`${root}/keep.txt`, content);
    const { tools, invoke, run } = workspaceTools(root, true);
    try {
        assertEquals(tools.definitions.map((tool) => tool.name).sort(), [
            "workspace_find",
            "workspace_list",
            "workspace_read",
            "workspace_read_many",
            "workspace_search",
            "workspace_stat",
        ]);
        const stat = await run("workspace_stat", { path: "keep.txt" });
        assertEquals(stat.kind, "file");
        assertEquals(
            (await run("workspace_find", { pattern: "*.txt" })).paths,
            ["keep.txt"],
        );
        const multiple = await run("workspace_read_many", {
            paths: ["keep.txt", "missing.txt"],
        });
        assert(Array.isArray(multiple.files));
        assertEquals(multiple.files.length, 2);
        assertEquals(multiple.files[0].content, content);
        assertEquals(multiple.files[1].path, "missing.txt");
        assert(typeof multiple.files[1].error === "string");
        const denied: [string, Record<string, unknown>][] = [
            ["workspace_mkdir", { path: "new-directory" }],
            ["workspace_write", { path: "new.txt", content: "new" }],
            ["workspace_edit", {
                path: "keep.txt",
                oldText: "Keep",
                newText: "Change",
                expectedRevision: stat.revision,
            }],
            ["workspace_patch", {
                path: "keep.txt",
                patch:
                    "--- a/keep.txt\n+++ b/keep.txt\n@@ -1 +1 @@\n-Keep this file unchanged.\n+changed\n",
                expectedRevision: stat.revision,
            }],
            ["workspace_move", {
                path: "keep.txt",
                destination: "moved.txt",
                expectedRevision: stat.revision,
            }],
            ["workspace_remove", {
                path: "keep.txt",
                expectedRevision: stat.revision,
            }],
        ];
        for (const [name, args] of denied) {
            assertEquals(tools.isServerTool(name), false);
            assertEquals((await invoke(name, args)).isError, true, name);
        }
        assertEquals(await Deno.readTextFile(`${root}/keep.txt`), content);
        const entries = [];
        for await (const entry of Deno.readDir(root)) entries.push(entry.name);
        assertEquals(entries, ["keep.txt"]);
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});
