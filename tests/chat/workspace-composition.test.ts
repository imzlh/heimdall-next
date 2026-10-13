import { assert, assertEquals } from "@std/assert";
import type {
    GenerationRequest,
    InferenceSource,
    StreamFrame,
    ToolResultPart,
} from "@heimdall/contracts";
import { loadBuiltinComposition } from "@heimdall/core/composition/builtins.ts";
import { createServer } from "@heimdall/core/composition/server.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";

const workspaceId = "heimdall.tool.workspace";
const workspaceTools = [
    "workspace_edit",
    "workspace_find",
    "workspace_list",
    "workspace_mkdir",
    "workspace_move",
    "workspace_patch",
    "workspace_read",
    "workspace_read_many",
    "workspace_remove",
    "workspace_search",
    "workspace_stat",
    "workspace_write",
];
const readOnlyWorkspaceTools = [
    "workspace_find",
    "workspace_list",
    "workspace_read",
    "workspace_read_many",
    "workspace_search",
    "workspace_stat",
];

type App = ReturnType<typeof createServer>;
interface ChatReply {
    readonly messages: readonly {
        readonly role: string;
        readonly text: string;
    }[];
    readonly toolCalls: readonly { readonly name: string }[];
}

function fixtureSource(
    reply: (request: GenerationRequest) => StreamFrame["event"] = () => ({
        kind: "part.delta",
        messageId: "reply",
        partId: "text",
        delta: "workspace checked",
    }),
) {
    const requests: GenerationRequest[] = [];
    const source: InferenceSource = {
        id: "workspace-composition-fixture",
        capabilities: [{ operation: "generation.create", streaming: false }],
        execute(input) {
            const request = input.payload as GenerationRequest;
            const isTitle = input.metadata?.purpose === "chat.title";
            if (!isTitle) requests.push(request);
            const events: StreamFrame["event"][] = [
                { kind: "run.started", request: input },
                isTitle
                    ? {
                        kind: "part.delta",
                        messageId: "title",
                        partId: "text",
                        delta: "Workspace maintenance",
                    }
                    : reply(request),
                { kind: "run.completed" },
            ];
            return (async function* () {
                for (const [index, event] of events.entries()) {
                    yield {
                        version: 1 as const,
                        requestId: input.requestId,
                        streamId: `workspace:${input.requestId}`,
                        seq: index + 1,
                        eventId: `workspace-event:${index}`,
                        timestamp: new Date().toISOString(),
                        event,
                    };
                }
            })();
        },
    };
    return { source, requests };
}

function offeredWorkspaceTools(request: GenerationRequest | undefined) {
    return (request?.tools ?? [])
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("workspace_"))
        .sort();
}

function toolResults(request: GenerationRequest): ToolResultPart[] {
    return request.messages.flatMap((message) =>
        message.parts.filter((part) => part.type === "tool_result")
    );
}

async function newConversation(app: App): Promise<string> {
    const response = await app.request("/api/chat/conversations", {
        method: "POST",
    });
    assertEquals(response.status, 201);
    return (await response.json()).conversation.id;
}

async function ask(app: App, conversationId?: string): Promise<ChatReply> {
    const response = await app.request("/api/chat/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            conversationId: conversationId ?? await newConversation(app),
            model: "fixture",
            text: "Update and inspect the workspace.",
        }),
    });
    assertEquals(response.status, 200);
    return await response.json();
}

async function setEnabled(app: App, enabled: boolean): Promise<void> {
    const response = await app.request("/admin/plugin-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pluginId: workspaceId, enabled }),
    });
    assertEquals(response.status, 200);
    await response.body?.cancel();
}

async function configureWorkspace(
    app: App,
    root: string,
    readOnly = false,
): Promise<void> {
    const current = await app.request(
        `/api/admin/tool-config?pluginId=${workspaceId}`,
    );
    assertEquals(current.status, 200);
    const { revision } = await current.json();
    const saved = await app.request("/api/admin/tool-config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            pluginId: workspaceId,
            config: { root, readOnly },
            revision,
        }),
    });
    assertEquals(saved.status, 200, await saved.text());
}

Deno.test("workspace composition executes Chat writes, reads and revision-checked edits", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-workspace-chat-",
    });
    const kv = await Deno.openKv(":memory:");
    const store = openSqliteChatStore(":memory:");
    const builtins = await loadBuiltinComposition({
        configStore: new DenoKvConfigStore(kv),
        env: () => undefined,
    });
    const initialContent = "export const answer = 1;\n";
    const updatedContent = "export const answer = 2;\n";
    const { source, requests } = fixtureSource((request) => {
        const results = toolResults(request);
        const call = (
            callId: string,
            name: string,
            args: Record<string, unknown>,
        ): StreamFrame["event"] => ({
            kind: "tool.call",
            messageId: `assistant:${callId}`,
            callId,
            name,
            argumentsText: JSON.stringify(args),
        });
        if (results.length === 0) {
            return call("create", "workspace_write", {
                path: "answer.ts",
                content: initialContent,
            });
        }
        if (results.length === 1) {
            return call("read-before", "workspace_read", { path: "answer.ts" });
        }
        if (results.length === 2) {
            const read = JSON.parse(String(results.at(-1)?.result));
            return call("edit", "workspace_edit", {
                path: "answer.ts",
                oldText: "answer = 1",
                newText: "answer = 2",
                expectedRevision: read.revision,
            });
        }
        if (results.length === 3) {
            return call("read-after", "workspace_read", { path: "answer.ts" });
        }
        return {
            kind: "part.delta",
            messageId: "reply",
            partId: "text",
            delta: "Updated answer.ts to 2.",
        };
    });
    const app = createServer({
        sources: [source],
        adminCatalog: builtins.catalog,
        adminManagement: builtins.management,
        chat: { store, tools: builtins.toolPlugins },
    });
    try {
        await configureWorkspace(app, directory);
        const response = await ask(app);
        assertEquals(response.toolCalls, []);
        assertEquals(response.messages.at(-1)?.text, "Updated answer.ts to 2.");
        assertEquals(requests.length, 5);
        assertEquals(offeredWorkspaceTools(requests[0]), workspaceTools);
        const results = toolResults(requests.at(-1)!);
        assertEquals(results.map((result) => result.callId), [
            "create",
            "read-before",
            "edit",
            "read-after",
        ]);
        const before = JSON.parse(String(results[1]?.result));
        const after = JSON.parse(String(results[3]?.result));
        assertEquals(before.path, "answer.ts");
        assertEquals(before.content, initialContent);
        assertEquals(after.content, updatedContent);
        assert(
            typeof before.revision === "string" && before.revision.length > 0,
        );
        assert(typeof after.revision === "string" && after.revision.length > 0);
        assert(before.revision !== after.revision);
        assertEquals(
            await Deno.readTextFile(`${directory}/answer.ts`),
            updatedContent,
        );
    } finally {
        await builtins.close();
        store.close();
        kv.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("workspace conversation selection and persisted plugin state control the next Chat request", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-workspace-state-",
    });
    const kv = await Deno.openKv(":memory:");
    const store = openSqliteChatStore(":memory:");
    const options = {
        configStore: new DenoKvConfigStore(kv),
        env: () => undefined,
    };
    let builtins = await loadBuiltinComposition(options);
    const { source, requests } = fixtureSource();
    const server = () =>
        createServer({
            sources: [source],
            adminCatalog: builtins.catalog,
            adminManagement: builtins.management,
            chat: { store, tools: builtins.toolPlugins },
        });
    let app = server();
    try {
        await configureWorkspace(app, directory);
        const catalog = await (await app.request("/admin/plugins")).json();
        const workspace = catalog.plugins.find((plugin: { id: string }) =>
            plugin.id === workspaceId
        );
        assertEquals(workspace?.kind, "tool");
        assertEquals(workspace?.enabled, true);
        assertEquals(workspace?.canToggle, true);
        await ask(app);
        assertEquals(offeredWorkspaceTools(requests.at(-1)), workspaceTools);

        const mutedConversation = await newConversation(app);
        const muted = await app.request(
            `/api/chat/conversation?id=${mutedConversation}`,
            {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ disabledTools: [workspaceId] }),
            },
        );
        assertEquals(muted.status, 200);
        assertEquals((await muted.json()).conversation.disabledTools, [
            workspaceId,
        ]);
        await ask(app, mutedConversation);
        assertEquals(offeredWorkspaceTools(requests.at(-1)), []);
        await ask(app);
        assertEquals(offeredWorkspaceTools(requests.at(-1)), workspaceTools);

        await setEnabled(app, false);
        await ask(app);
        assertEquals(offeredWorkspaceTools(requests.at(-1)), []);
        await builtins.close();
        builtins = await loadBuiltinComposition(options);
        app = server();
        await ask(app);
        assertEquals(offeredWorkspaceTools(requests.at(-1)), []);
        await setEnabled(app, true);
        await ask(app);
        assertEquals(offeredWorkspaceTools(requests.at(-1)), workspaceTools);
        await ask(app, mutedConversation);
        assertEquals(offeredWorkspaceTools(requests.at(-1)), []);
    } finally {
        await builtins.close();
        store.close();
        kv.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("workspace configuration withholds unconfigured tools and read-only mutations from the model", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-workspace-config-",
    });
    const kv = await Deno.openKv(":memory:");
    const store = openSqliteChatStore(":memory:");
    const builtins = await loadBuiltinComposition({
        configStore: new DenoKvConfigStore(kv),
        env: () => undefined,
    });
    const { source, requests } = fixtureSource();
    const app = createServer({
        sources: [source],
        adminCatalog: builtins.catalog,
        adminManagement: builtins.management,
        chat: { store, tools: builtins.toolPlugins },
    });
    try {
        await ask(app);
        assertEquals(offeredWorkspaceTools(requests.at(-1)), []);
        await configureWorkspace(app, directory, true);
        await ask(app);
        assertEquals(
            offeredWorkspaceTools(requests.at(-1)),
            readOnlyWorkspaceTools,
        );
        await configureWorkspace(app, "");
        await ask(app);
        assertEquals(offeredWorkspaceTools(requests.at(-1)), []);
    } finally {
        await builtins.close();
        store.close();
        kv.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("workspace management switches the live Chat root and restores it after restart", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-workspace-live-",
    });
    const firstRoot = `${directory}/first`;
    const nextRoot = `${directory}/next`;
    await Deno.mkdir(firstRoot);
    await Deno.mkdir(nextRoot);
    await Deno.writeTextFile(`${firstRoot}/identity.txt`, "first workspace");
    await Deno.writeTextFile(`${nextRoot}/identity.txt`, "next workspace");
    const kv = await Deno.openKv(":memory:");
    const store = openSqliteChatStore(":memory:");
    const options = {
        configStore: new DenoKvConfigStore(kv),
        env: () => undefined,
    };
    let builtins = await loadBuiltinComposition(options);
    const { source, requests } = fixtureSource((request) => {
        const results = toolResults(request);
        if (results.length === 0) {
            return {
                kind: "tool.call",
                messageId: "assistant:read",
                callId: "read-identity",
                name: "workspace_read",
                argumentsText: JSON.stringify({ path: "identity.txt" }),
            };
        }
        const result = JSON.parse(String(results.at(-1)?.result));
        return {
            kind: "part.delta",
            messageId: "reply",
            partId: "text",
            delta: result.content,
        };
    });
    const server = () =>
        createServer({
            sources: [source],
            adminCatalog: builtins.catalog,
            adminManagement: builtins.management,
            chat: { store, tools: builtins.toolPlugins },
        });
    let app = server();
    try {
        await configureWorkspace(app, firstRoot);
        assertEquals((await ask(app)).messages.at(-1)?.text, "first workspace");
        await configureWorkspace(app, nextRoot, true);
        assertEquals((await ask(app)).messages.at(-1)?.text, "next workspace");
        assertEquals(
            offeredWorkspaceTools(requests.at(-1)),
            readOnlyWorkspaceTools,
        );
        await builtins.close();
        builtins = await loadBuiltinComposition(options);
        app = server();
        assertEquals((await ask(app)).messages.at(-1)?.text, "next workspace");
        assertEquals(
            offeredWorkspaceTools(requests.at(-1)),
            readOnlyWorkspaceTools,
        );
    } finally {
        await builtins.close();
        store.close();
        kv.close();
        await Deno.remove(directory, { recursive: true });
    }
});
