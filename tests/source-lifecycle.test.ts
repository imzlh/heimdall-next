import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import type { SourceDto } from "@heimdall/admin-contracts";
import { loadBuiltinComposition } from "@heimdall/core/composition/builtins.ts";
import { createServerApp } from "@heimdall/core/http/app.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";

const pluginId = "heimdall.source.openai-compatible";
const sourceId = "be63055d-9252-4f98-a120-0aeb0b8331eb";
const secondId = "2dafae46-e78f-44e2-b42c-1bb2a7b354d2";
const context = {
    request: new Request("http://localhost/admin/sources"),
    requestId: "source-lifecycle",
};
const config = {
    baseUrl: "https://source.example/v1",
    apiKey: "lifecycle-private-key",
};
const input = {
    id: sourceId,
    name: "主渠道",
    priority: 10,
    sourcePluginId: pluginId,
    config,
};

async function setup(
    env: (name: string) => string | undefined = () => undefined,
) {
    const resources = new AsyncDisposableStack();
    const kv = await Deno.openKv(":memory:");
    resources.defer(() => kv.close());
    const store = new DenoKvConfigStore(kv);
    const load = async () => {
        const composition = await loadBuiltinComposition({
            configStore: store,
            env,
        });
        resources.defer(() => composition.close());
        const app = createServerApp({
            adminAuthToken: "operator-key",
            adminCatalog: composition.catalog,
            adminManagement: composition.management,
        });
        const call = async (
            method: string,
            path: string,
            body?: unknown,
            version?: string,
        ) => {
            const headers = new Headers({
                authorization: "Bearer operator-key",
                "content-type": "application/json",
            });
            if (version) headers.set("if-match", `"${version}"`);
            return await app.request(path, {
                method,
                headers,
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        };
        const list = async (): Promise<SourceDto[]> => {
            const response = await call("GET", "/admin/sources");
            assertEquals(response.status, 200);
            return (await response.json()).sources;
        };
        return { composition, call, list, app };
    };
    return { resources, store, load, ...await load() };
}

Deno.test("channel metadata edits affect routing, share config CAS and survive restart without exposing secrets", async () => {
    const fixture = await setup();
    await using _resources = fixture.resources;
    const { composition, call, list } = fixture;
    const created = await call("POST", "/admin/sources", input);
    assertEquals(created.status, 201);
    const originalVersion = created.headers.get("etag")!;
    await created.body?.cancel();
    const second = await call("POST", "/api/admin/sources", {
        ...input,
        id: secondId,
        name: "备份",
        priority: 0,
    });
    assertEquals(second.status, 201);
    await second.body?.cancel();
    const select = () =>
        composition.sources.select({
            version: 1,
            requestId: "priority",
            operation: "generation.create",
            payload: { messages: [] },
            traits: { streaming: true },
        }).id;
    assertEquals(select(), secondId);
    composition.sources.recordProbe(sourceId, {
        ok: true,
        message: "ready",
        models: ["discovered-model"],
    });
    const running = composition.sources.get(sourceId);
    const renamed = await call("PATCH", `/admin/sources?id=${sourceId}`, {
        name: "仅调整名称",
    }, originalVersion);
    assertEquals(renamed.status, 200);
    const renamedVersion = renamed.headers.get("etag")!;
    await renamed.body?.cancel();
    assertEquals(composition.sources.get(sourceId), running);
    assertEquals(composition.sources.discoveredModels(sourceId), [
        "discovered-model",
    ]);
    const probe = composition.sources.probeOf(sourceId);
    const patched = await call("PATCH", `/api/admin/sources?id=${sourceId}`, {
        name: "  主服务  ",
        priority: -10,
    }, renamedVersion);
    assertEquals(patched.status, 200);
    const patchedText = await patched.text();
    assert(!patchedText.includes(config.apiKey));
    assert(!patchedText.includes(config.baseUrl));
    const updated = JSON.parse(patchedText).source;
    assertEquals([
        updated.name,
        updated.priority,
        updated.enabled,
        updated.instanceEnabled,
        updated.pluginEnabled,
    ], ["主服务", -10, true, true, true]);
    assertEquals(updated.versionstamp, patched.headers.get("etag"));
    assertEquals(select(), sourceId);
    assertEquals(composition.sources.discoveredModels(sourceId), [
        "discovered-model",
    ]);
    assertEquals(composition.sources.probeOf(sourceId), probe);

    const stale = await call("PATCH", `/admin/sources?id=${sourceId}`, {
        name: "旧窗口",
    }, originalVersion);
    assertEquals(stale.status, 409);
    await stale.body?.cancel();
    const staleConfig = await call(
        "PUT",
        `/admin/source-config?id=${sourceId}`,
        { config: { baseUrl: "https://stale.example/v1" } },
        originalVersion,
    );
    assertEquals(staleConfig.status, 409);
    await staleConfig.body?.cancel();
    const saved = await call("PUT", `/admin/source-config?id=${sourceId}`, {
        config: { baseUrl: "https://updated.example/v1" },
    }, updated.versionstamp);
    assertEquals(saved.status, 200);
    await saved.body?.cancel();
    const current = (await list()).find((source) => source.id === sourceId)!;
    assertEquals([current.name, current.priority], ["主服务", -10]);
    assert(current.versionstamp !== updated.versionstamp);
    const restarted = await fixture.load();
    const restored = (await restarted.list()).find((source) =>
        source.id === sourceId
    );
    assertExists(restored);
    assertEquals(restored?.probe, undefined);
    assertEquals(current.probe, undefined);
    assertEquals(restored, current);
    assert(
        restarted.composition.sources.get(sourceId)?.capabilities.every((
            capability,
        ) => capability.priority === -10),
    );
    const snapshot = await restarted.composition.management.getSourceConfig?.(
        context,
        sourceId,
    );
    assertEquals(
        (snapshot?.config as Record<string, unknown>).apiKeyConfigured,
        true,
    );
    assert(!JSON.stringify(snapshot).includes(config.apiKey));
});

Deno.test("instance and plugin switches remain independent across edits, new channels and restarts", async () => {
    const fixture = await setup();
    await using _resources = fixture.resources;
    const { composition, call, list } = fixture;
    await composition.management.createSource?.(context, input);
    await composition.management.createSource?.(context, {
        ...input,
        id: secondId,
    });
    const disabled = await call("PATCH", `/admin/sources?id=${sourceId}`, {
        enabled: false,
    });
    assertEquals(disabled.status, 200);
    const instance = (await disabled.json()).source;
    assertEquals([
        instance.enabled,
        instance.instanceEnabled,
        instance.pluginEnabled,
    ], [false, false, true]);
    assertEquals(composition.sources.get(sourceId), undefined);
    assertExists(composition.sources.get(secondId));
    await composition.management.setPluginEnabled?.(context, pluginId, false);
    assertEquals(composition.sources.list(), []);
    await composition.management.saveSourceConfig?.(context, sourceId, {
        baseUrl: "https://edited.example/v1",
    });
    await composition.management.updateSource?.(context, secondId, {
        name: "父插件已停用",
    });
    const thirdId = "715cf5bd-f786-4b90-8c9c-70a06b1f3f01";
    await composition.management.createSource?.(context, {
        ...input,
        id: thirdId,
    });
    assertEquals(composition.sources.list(), []);
    assert(
        (await list()).every((source) =>
            source.pluginEnabled === false && source.enabled === false
        ),
    );
    const restarted = await fixture.load();
    assertEquals(restarted.composition.sources.list(), []);
    await restarted.composition.management.setPluginEnabled?.(
        context,
        pluginId,
        true,
    );
    assertEquals(restarted.composition.sources.get(sourceId), undefined);
    assertEquals(
        restarted.composition.sources.list().map((source) => source.id).sort(),
        [secondId, thirdId].sort(),
    );
    const storedDisabled = (await restarted.list()).find((source) =>
        source.id === sourceId
    )!;
    assertEquals([
        storedDisabled.instanceEnabled,
        storedDisabled.pluginEnabled,
        storedDisabled.enabled,
    ], [false, true, false]);
    await restarted.composition.management.updateSource?.(context, sourceId, {
        enabled: true,
    }, storedDisabled.versionstamp);
    assertExists(restarted.composition.sources.get(sourceId));
});

Deno.test("deletion uses config CAS, removes credentials and slots, and cannot be revived by stale forms or environment bootstrap", async () => {
    const fixture = await setup((name) =>
        ({
            HEIMDALL_OPENAI_BASE_URL: config.baseUrl,
            HEIMDALL_OPENAI_API_KEY: config.apiKey,
        } as Record<string, string>)[name]
    );
    await using _resources = fixture.resources;
    const id = "openai-compatible";
    const initial = (await fixture.list())[0]!;
    assertEquals(initial.id, id);
    const edit = await fixture.call("PATCH", `/admin/sources?id=${id}`, {
        name: "将被删除",
    }, initial.versionstamp);
    assertEquals(edit.status, 200);
    const version = edit.headers.get("etag")!;
    await edit.body?.cancel();
    const stale = await fixture.call(
        "DELETE",
        `/api/admin/sources?id=${id}`,
        undefined,
        initial.versionstamp,
    );
    assertEquals(stale.status, 409);
    await stale.body?.cancel();
    assertExists(fixture.composition.sources.get(id));
    const deleted = await fixture.call(
        "DELETE",
        `/api/admin/sources?id=${id}`,
        undefined,
        version,
    );
    assertEquals(deleted.status, 200);
    assertEquals(await deleted.json(), { sourceId: id, deleted: true });
    assertEquals(await fixture.list(), []);
    assertEquals(fixture.composition.sources.get(id), undefined);
    assertEquals(await fixture.composition.sourcePluginIds(), {});
    const stored = await fixture.store.namespace("heimdall", "source-config")
        .get([id]);
    assertEquals(stored?.value, {
        sourcePluginId: pluginId,
        config: null,
        enabled: false,
        deleted: true,
        instanceStateVersion: 1,
    });
    const staleSave = await fixture.call(
        "PUT",
        `/admin/source-config?id=${id}`,
        { config },
        version,
    );
    assertEquals(staleSave.status, 404);
    await staleSave.body?.cancel();
    assertEquals(
        await fixture.composition.management.getSourceConfig?.(context, id),
        null,
    );
    const repeated = await fixture.call("DELETE", `/admin/sources?id=${id}`);
    assertEquals(repeated.status, 404);
    await repeated.body?.cancel();
    const restarted = await fixture.load();
    assertEquals(await restarted.list(), []);
    await restarted.composition.management.setPluginEnabled?.(
        context,
        pluginId,
        true,
    );
    assertEquals(restarted.composition.sources.list(), []);
    assertEquals(await restarted.composition.sourcePluginIds(), {});
});

Deno.test("concurrent lifecycle changes admit one CAS writer and failed writes do not block later operations", async () => {
    const fixture = await setup();
    await using _resources = fixture.resources;
    await fixture.composition.management.createSource?.(context, input);
    const source = (await fixture.list())[0]!;
    const responses = await Promise.all([
        fixture.call("PATCH", `/admin/sources?id=${sourceId}`, {
            enabled: false,
        }, source.versionstamp),
        fixture.call(
            "PATCH",
            `/api/admin/sources?id=${sourceId}`,
            { enabled: false, priority: -20 },
            source.versionstamp,
        ),
    ]);
    assertEquals(responses.map((response) => response.status).sort(), [
        200,
        409,
    ]);
    for (const response of responses) await response.body?.cancel();
    const current = (await fixture.list())[0]!;
    assertEquals(current.instanceEnabled, false);
    await assertRejects(() =>
        Promise.resolve(
            fixture.composition.management.updateSource?.(context, sourceId, {
                name: "",
            }),
        )
    );
    const recover = await fixture.call(
        "PATCH",
        `/admin/sources?id=${sourceId}`,
        { enabled: true },
        current.versionstamp,
    );
    assertEquals(recover.status, 200);
    await recover.body?.cancel();
    assertExists(fixture.composition.sources.get(sourceId));
});

Deno.test("legacy plugin-disabled records migrate without re-enabling explicit instance switches", async () => {
    for (
        const scenario of [
            { legacy: true, pluginEnabled: false, instanceEnabled: true },
            { legacy: false, pluginEnabled: false, instanceEnabled: false },
            { legacy: true, pluginEnabled: true, instanceEnabled: false },
        ]
    ) {
        const fixture = await setup();
        await using _resources = fixture.resources;
        await fixture.composition.management.setPluginEnabled?.(
            context,
            pluginId,
            scenario.pluginEnabled,
        );
        const sources = fixture.store.namespace("heimdall", "source-config");
        await sources.set([sourceId], {
            sourcePluginId: pluginId,
            name: "保留名称",
            priority: -3,
            config: { ...config, id: sourceId },
            enabled: false,
            ...(scenario.legacy ? {} : { instanceStateVersion: 1 }),
        });
        const restarted = await fixture.load();
        const source = (await restarted.list())[0]!;
        assertEquals([
            source.name,
            source.priority,
            source.instanceEnabled,
            source.pluginEnabled,
            source.enabled,
        ], [
            "保留名称",
            -3,
            scenario.instanceEnabled,
            scenario.pluginEnabled,
            false,
        ]);
        const migrated =
            (await sources.get<Record<string, unknown>>([sourceId]))!.value;
        assertEquals(migrated.instanceStateVersion, 1);
        assertEquals(migrated.enabled, scenario.instanceEnabled);
        assertEquals(migrated.config, { ...config, id: sourceId });
        await restarted.composition.management.setPluginEnabled?.(
            context,
            pluginId,
            true,
        );
        assertEquals(
            restarted.composition.sources.get(sourceId) !== undefined,
            scenario.instanceEnabled,
        );
        const twice = await fixture.load();
        assertEquals(
            (await twice.list())[0]?.instanceEnabled,
            scenario.instanceEnabled,
        );
    }
});
