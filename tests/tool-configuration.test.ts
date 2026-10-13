import { assert, assertEquals } from "@std/assert";
import { loadBuiltinComposition } from "@heimdall/core/composition/builtins.ts";
import { createServer } from "@heimdall/core/composition/server.ts";
import {
    createChatToolset,
    newRunBudget,
} from "@heimdall/core/chat/tools/toolset.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";

const pluginId = "heimdall.tool.workspace";
const path = "/api/admin/tool-config";
const query = `${path}?pluginId=${pluginId}`;
const readOnlyTools = [
    "workspace_find",
    "workspace_list",
    "workspace_read",
    "workspace_read_many",
    "workspace_search",
    "workspace_stat",
];
const allTools = [
    ...readOnlyTools,
    "workspace_edit",
    "workspace_mkdir",
    "workspace_move",
    "workspace_patch",
    "workspace_remove",
    "workspace_write",
].sort();
type App = ReturnType<typeof createServer>;
type Composition = Awaited<ReturnType<typeof loadBuiltinComposition>>;

interface ToolConfiguration {
    readonly pluginId: string;
    readonly config: { readonly root?: string; readonly readOnly?: boolean };
    readonly configSchema: Record<string, unknown>;
    readonly revision: string | null;
}

async function getConfiguration(app: App): Promise<ToolConfiguration> {
    const response = await app.request(query);
    assertEquals(response.status, 200);
    return await response.json();
}

function saveConfiguration(
    app: App,
    config: unknown,
    revision?: string | null,
) {
    return app.request(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pluginId, config, revision }),
    });
}

async function savedConfiguration(
    response: Response,
): Promise<ToolConfiguration> {
    const body = await response.json();
    assertEquals(response.status, 200, JSON.stringify(body));
    assert(typeof body.revision === "string" && body.revision.length > 0);
    return body;
}

function workspaceTools(composition: Composition) {
    return (composition.toolPlugins()
        .find((plugin) => plugin.manifest.id === pluginId)?.tools ?? [])
        .map((tool) => tool.definition.name)
        .sort();
}

async function readIdentity(composition: Composition) {
    const tools = createChatToolset(composition.toolPlugins());
    const result = await tools.run(
        {
            callId: "read-identity",
            name: "workspace_read",
            argumentsText: JSON.stringify({ path: "identity.txt" }),
        },
        newRunBudget(),
        new AbortController().signal,
    );
    assertEquals(result.isError, false, result.text);
    return JSON.parse(result.text).content;
}

Deno.test("tool configuration validates before saving and rejects missing or stale revisions without changing active tools", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-tool-config-",
    });
    using kv = await Deno.openKv(":memory:");
    const configStore = new DenoKvConfigStore(kv);
    const composition = await loadBuiltinComposition({
        configStore,
        env: () => undefined,
    });
    const app = createServer({
        adminCatalog: composition.catalog,
        adminManagement: composition.management,
    });
    try {
        await Deno.writeTextFile(
            `${directory}/identity.txt`,
            "active workspace",
        );
        const initial = await getConfiguration(app);
        assertEquals(initial.pluginId, pluginId);
        assertEquals(initial.revision, null);
        assert(
            initial.configSchema !== null &&
                typeof initial.configSchema === "object",
        );
        assertEquals(workspaceTools(composition), []);

        const config = {
            root: await Deno.realPath(directory),
            readOnly: false,
        };
        const missingRevision = await saveConfiguration(app, config);
        assertEquals(missingRevision.status, 400);
        await missingRevision.body?.cancel();
        assertEquals((await getConfiguration(app)).revision, null);

        const first = await savedConfiguration(
            await saveConfiguration(app, config, null),
        );
        assertEquals(first.config, config);
        assertEquals(workspaceTools(composition), allTools);
        assertEquals(await readIdentity(composition), "active workspace");

        const second = await savedConfiguration(
            await saveConfiguration(
                app,
                { ...config, readOnly: true },
                first.revision,
            ),
        );
        assert(first.revision !== second.revision);
        assertEquals(workspaceTools(composition), readOnlyTools);
        for (const revision of [null, first.revision]) {
            const stale = await saveConfiguration(app, config, revision);
            assertEquals(stale.status, 409);
            await stale.body?.cancel();
        }
        for (
            const invalid of [
                { root: `${directory}/missing`, readOnly: false },
                { root: `${directory}/identity.txt`, readOnly: false },
                { root: "relative/path", readOnly: false },
                { root: config.root, readOnly: "false" },
                { root: config.root, extra: true },
                null,
                [],
            ]
        ) {
            const rejected = await saveConfiguration(
                app,
                invalid,
                second.revision,
            );
            assertEquals(rejected.status, 400, JSON.stringify(invalid));
            await rejected.body?.cancel();
        }
        assertEquals(await getConfiguration(app), second);
        assertEquals(workspaceTools(composition), readOnlyTools);
        assertEquals(await readIdentity(composition), "active workspace");
        const persisted = await configStore.namespace("heimdall", "tool-config")
            .get([pluginId]);
        assertEquals(persisted?.versionstamp, second.revision);
        assertEquals(persisted?.value, { config: second.config });

        const catalog = await (await app.request("/api/admin/plugins")).json();
        const plugin = catalog.plugins.find((item: { id: string }) =>
            item.id === pluginId
        );
        assert(plugin);
        assert(!("config" in plugin));
        assert(!JSON.stringify(catalog).includes(JSON.stringify(config.root)));

        const nextDirectory = `${directory}/next`;
        await Deno.mkdir(nextDirectory);
        await Deno.writeTextFile(
            `${nextDirectory}/identity.txt`,
            "next workspace",
        );
        const competing = await Promise.all([
            saveConfiguration(app, config, second.revision),
            saveConfiguration(
                app,
                { root: nextDirectory, readOnly: true },
                second.revision,
            ),
        ]);
        assertEquals(competing.map((response) => response.status).sort(), [
            200,
            409,
        ]);
        const winner = await savedConfiguration(
            competing.find((response) => response.status === 200)!,
        );
        await competing.find((response) => response.status === 409)?.body
            ?.cancel();
        assertEquals(await getConfiguration(app), winner);
        const wonNextDirectory =
            winner.config.root === await Deno.realPath(nextDirectory);
        assertEquals(
            await readIdentity(composition),
            wonNextDirectory ? "next workspace" : "active workspace",
        );
        assertEquals(
            workspaceTools(composition),
            winner.config.readOnly ? readOnlyTools : allTools,
        );
    } finally {
        await composition.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("tool configuration survives a failed startup validation and can be repaired using its persisted revision", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-tool-repair-",
    });
    using kv = await Deno.openKv(":memory:");
    const configStore = new DenoKvConfigStore(kv);
    const invalid = { root: `${directory}/deleted-workspace`, readOnly: false };
    const revision = await configStore.namespace("heimdall", "tool-config")
        .set([pluginId], { config: invalid });
    let composition = await loadBuiltinComposition({
        configStore,
        env: () => undefined,
    });
    const app = createServer({
        adminCatalog: composition.catalog,
        adminManagement: composition.management,
    });
    try {
        const broken = await getConfiguration(app);
        assertEquals(broken.revision, revision);
        assertEquals(broken.config, invalid);
        assertEquals(workspaceTools(composition), []);
        const catalogBefore = await (await app.request("/api/admin/plugins"))
            .json();
        assert(
            catalogBefore.plugins.find((item: { id: string }) =>
                item.id === pluginId
            )?.lastError,
        );
        const repaired = await savedConfiguration(
            await saveConfiguration(
                app,
                { root: directory, readOnly: false },
                revision,
            ),
        );
        assert(repaired.revision !== revision);
        assertEquals(workspaceTools(composition), allTools);
        const catalogAfter = await (await app.request("/api/admin/plugins"))
            .json();
        assertEquals(
            catalogAfter.plugins.find((item: { id: string }) =>
                item.id === pluginId
            )?.lastError,
            undefined,
        );
        await composition.close();
        composition = await loadBuiltinComposition({
            configStore,
            env: () => undefined,
        });
        const restarted = createServer({
            adminCatalog: composition.catalog,
            adminManagement: composition.management,
        });
        assertEquals(await getConfiguration(restarted), repaired);
        assertEquals(workspaceTools(composition), allTools);
    } finally {
        await composition.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("tool configuration uses admin bearer authentication and the authenticated session bridge", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-tool-auth-" });
    using kv = await Deno.openKv(":memory:");
    const composition = await loadBuiltinComposition({
        configStore: new DenoKvConfigStore(kv),
        env: () => undefined,
    });
    const token = "tool-config-admin-token";
    const origin = "http://localhost";
    const app = createServer({
        adminAuthToken: token,
        adminCatalog: composition.catalog,
        adminManagement: composition.management,
    });
    const config = { root: directory, readOnly: true };
    try {
        for (const method of ["GET", "PUT"]) {
            for (const authorization of [undefined, "Bearer wrong-token"]) {
                const headers = new Headers({
                    "content-type": "application/json",
                });
                if (authorization) headers.set("authorization", authorization);
                const denied = await app.request(
                    method === "GET" ? query : path,
                    {
                        method,
                        headers,
                        ...(method === "PUT"
                            ? {
                                body: JSON.stringify({
                                    pluginId,
                                    config,
                                    revision: null,
                                }),
                            }
                            : {}),
                    },
                );
                assertEquals(denied.status, 401);
                await denied.body?.cancel();
            }
        }
        const authorized = await app.request(query, {
            headers: { authorization: `Bearer ${token}` },
        });
        assertEquals(authorized.status, 200);
        assertEquals((await authorized.json()).revision, null);

        const login = await app.request(`${origin}/admin/session`, {
            method: "POST",
            headers: { origin },
            body: new URLSearchParams({ token }),
        });
        assertEquals(login.status, 303);
        const cookie = login.headers.get("set-cookie")?.split(";")[0];
        assert(cookie);
        await login.body?.cancel();
        const bridge = (
            target: string,
            method: string,
            body?: unknown,
            session = true,
        ) => app.request(`${origin}/admin/ui/request`, {
            method: "POST",
            headers: {
                origin,
                "content-type": "application/json",
                ...(session ? { cookie } : {}),
            },
            body: JSON.stringify({ path: target, method, body }),
        });
        const noSession = await bridge(query, "GET", undefined, false);
        assertEquals(noSession.status, 401);
        await noSession.body?.cancel();
        const initial = await bridge(query, "GET");
        assertEquals(initial.status, 200);
        assertEquals((await initial.json()).revision, null);
        const saved = await savedConfiguration(
            await bridge(path, "PUT", { pluginId, config, revision: null }),
        );
        assertEquals(saved.config.readOnly, true);
        assertEquals(workspaceTools(composition), readOnlyTools);
        const fetched = await bridge(query, "GET");
        assertEquals(fetched.status, 200);
        assertEquals(await fetched.json(), saved);

        for (const target of [`${path}/child`, `${path}/`, `${path}-extra`]) {
            const denied = await bridge(target, "PUT", {
                pluginId,
                config,
                revision: saved.revision,
            });
            assertEquals(denied.status, 403);
            await denied.body?.cancel();
        }
        for (const method of ["POST", "DELETE", "PATCH"]) {
            const denied = await bridge(path, method, {
                pluginId,
                config,
                revision: saved.revision,
            });
            assertEquals(denied.status, 403);
            await denied.body?.cancel();
        }
    } finally {
        await composition.close();
        await Deno.remove(directory, { recursive: true });
    }
});
