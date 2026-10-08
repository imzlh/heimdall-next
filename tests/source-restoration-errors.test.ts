import { assert, assertEquals, assertExists, assertMatch } from "@std/assert";
import type { SourceDto } from "@heimdall/admin-contracts";
import {
    type BuiltinComposition,
    loadBuiltinComposition,
} from "@heimdall/core/composition/builtins.ts";
import type { StoredSourceConfig } from "@heimdall/core/composition/source-records.ts";
import { createServerApp } from "@heimdall/core/http/app.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";

const pluginId = "heimdall.source.openai-compatible";
const sourceId = "6765b9b2-627f-4792-ae41-44abfd82bca2";
const legacyId = "77334563-657a-44b8-8cb6-6436b780e4a1";
const healthyId = "be031283-57f6-4485-9ddd-a3b913341d29";
const malformedMap = { public: "" };

type CatalogSource = SourceDto & {
    readonly configurationErrorField?: string;
};

function record(id: string): StoredSourceConfig {
    return {
        sourcePluginId: pluginId,
        config: { id, baseUrl: "https://provider.example/v1" },
        name: "持久化渠道",
        enabled: true,
        instanceStateVersion: 1,
    };
}

function admin(composition: BuiltinComposition) {
    const app = createServerApp({
        adminCatalog: composition.catalog,
        adminManagement: composition.management,
    });
    const call = (
        method: string,
        path: string,
        body?: unknown,
        version?: string,
    ) => {
        const headers = new Headers({ "content-type": "application/json" });
        if (version !== undefined) headers.set("if-match", `"${version}"`);
        return app.request(path, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    };
    const source = async (id: string): Promise<CatalogSource> => {
        const response = await call("GET", "/admin/sources");
        assertEquals(response.status, 200);
        const { sources } = await response.json() as {
            sources: CatalogSource[];
        };
        const found = sources.find((item) => item.id === id);
        assertExists(found, `stored source ${id} must remain in the catalog`);
        return found;
    };
    return { call, source };
}

async function load(
    resources: AsyncDisposableStack,
    store: DenoKvConfigStore,
) {
    const composition = await loadBuiltinComposition({
        configStore: store,
        env: () => undefined,
    });
    resources.defer(() => composition.close());
    return { composition, ...admin(composition) };
}

async function fixture(
    resources: AsyncDisposableStack,
    damaged: StoredSourceConfig,
) {
    const kv = await Deno.openKv(":memory:");
    resources.defer(() => kv.close());
    const store = new DenoKvConfigStore(kv);
    const scope = store.namespace("heimdall", "source-config");
    await scope.set([sourceId], damaged);
    await scope.set([healthyId], record(healthyId));
    return { store, scope, ...await load(resources, store) };
}

function assertQuarantined(
    composition: BuiltinComposition,
    source: CatalogSource,
    field: "modelMap" | "config",
) {
    assertEquals(source.configurationErrorField, field);
    assertExists(source.configurationError);
    assertMatch(source.configurationError, /[\u3400-\u9fff]/u);
    assertEquals(source.enabled, false);
    assertEquals(composition.sources.get(source.id), undefined);
    if (field === "modelMap") assertEquals(source.modelMap, {});
}

Deno.test("malformed host and disabled legacy model mappings preserve records and quarantine across KV reopen", async () => {
    await using resources = new AsyncDisposableStack();
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-source-restoration-",
    });
    resources.defer(() => Deno.remove(directory, { recursive: true }));
    const path = `${directory}/config.sqlite`;
    const damaged = {
        ...record(sourceId),
        modelMap: malformedMap,
    };
    const legacy = {
        ...record(legacyId),
        enabled: false,
        config: {
            id: legacyId,
            baseUrl: "https://provider.example/v1",
            modelMap: malformedMap,
        },
    };
    const versions = new Map<string, string>();
    for (const cycle of [0, 1]) {
        await using cycleResources = new AsyncDisposableStack();
        const kv = await Deno.openKv(path);
        cycleResources.defer(() => kv.close());
        const store = new DenoKvConfigStore(kv);
        const scope = store.namespace("heimdall", "source-config");
        if (cycle === 0) {
            versions.set(sourceId, await scope.set([sourceId], damaged));
            versions.set(legacyId, await scope.set([legacyId], legacy));
            await scope.set([healthyId], record(healthyId));
        }
        const runtime = await load(cycleResources, store);
        assertExists(runtime.composition.sources.get(healthyId));
        for (
            const [id, value] of [[sourceId, damaged], [
                legacyId,
                legacy,
            ]] as const
        ) {
            const shown = await runtime.source(id);
            assertQuarantined(runtime.composition, shown, "modelMap");
            assertEquals(shown.instanceEnabled, value.enabled);
            assertEquals(await scope.get([id]), {
                value,
                versionstamp: versions.get(id)!,
            });
        }
    }
});

for (const legacy of [false, true]) {
    const replacements: Readonly<Record<string, string>>[] = [
        {},
        { public: "upstream" },
    ];
    for (const replacement of replacements) {
        const description = legacy ? "legacy" : "host";
        const repair = Object.keys(replacement).length === 0
            ? "empty"
            : "valid";
        Deno.test(`${description} model mapping quarantine repairs with ${repair} PATCH only after a successful CAS`, async () => {
            await using resources = new AsyncDisposableStack();
            const damaged: StoredSourceConfig = legacy
                ? {
                    ...record(sourceId),
                    enabled: false,
                    config: {
                        id: sourceId,
                        baseUrl: "https://provider.example/v1",
                        modelMap: malformedMap,
                    },
                }
                : { ...record(sourceId), modelMap: malformedMap };
            const runtime = await fixture(resources, damaged);
            const before = await runtime.scope.get<StoredSourceConfig>([
                sourceId,
            ]);
            assertExists(before);
            const concurrent = { ...before.value, name: "另一个窗口已更新" };
            const currentVersion = await runtime.scope.set(
                [sourceId],
                concurrent,
            );
            const rejected = await runtime.call(
                "PATCH",
                `/admin/sources?id=${sourceId}`,
                { modelMap: replacement },
                before.versionstamp,
            );
            assertEquals(rejected.status, 409, await rejected.clone().text());
            await rejected.body?.cancel();
            assertEquals(await runtime.scope.get([sourceId]), {
                value: concurrent,
                versionstamp: currentVersion,
            });
            assertQuarantined(
                runtime.composition,
                await runtime.source(sourceId),
                "modelMap",
            );
            assertExists(runtime.composition.sources.get(healthyId));

            const response = await runtime.call(
                "PATCH",
                `/admin/sources?id=${sourceId}`,
                { modelMap: replacement },
                currentVersion,
            );
            assertEquals(response.status, 200, await response.clone().text());
            const { source } = await response.json() as {
                source: CatalogSource;
            };
            assertEquals(source.configurationError, undefined);
            assertEquals(source.configurationErrorField, undefined);
            assertEquals(source.modelMap, replacement);
            assertEquals(source.instanceEnabled, !legacy);
            const saved = await runtime.scope.get<StoredSourceConfig>([
                sourceId,
            ]);
            assertExists(saved);
            assertEquals(saved.value.modelMap, replacement);
            assertEquals(saved.value.name, concurrent.name);
            assertEquals(saved.versionstamp, response.headers.get("etag"));
            assert(!Object.hasOwn(saved.value.config as object, "modelMap"));
            if (legacy) {
                assertEquals(
                    runtime.composition.sources.get(sourceId),
                    undefined,
                );
                const enabled = await runtime.call(
                    "PATCH",
                    `/admin/sources?id=${sourceId}`,
                    { enabled: true },
                    saved.versionstamp,
                );
                assertEquals(enabled.status, 200, await enabled.clone().text());
                await enabled.body?.cancel();
            }
            assertExists(runtime.composition.sources.get(sourceId));
            const restarted = await load(resources, runtime.store);
            assertExists(restarted.composition.sources.get(sourceId));
            const restored = await restarted.source(sourceId);
            assertEquals(restored.configurationError, undefined);
            assertEquals(restored.configurationErrorField, undefined);
            assertEquals(restored.modelMap, replacement);
        });
    }
}

Deno.test("unrelated source metadata and provider config edits cannot clear a model mapping quarantine", async () => {
    await using resources = new AsyncDisposableStack();
    const runtime = await fixture(resources, {
        ...record(sourceId),
        modelMap: malformedMap,
    });
    for (
        const patch of [
            { name: "只修改名称" },
            { enabled: false },
            { enabled: true },
            { middleware: [] },
        ]
    ) {
        const response = await runtime.call(
            "PATCH",
            `/admin/sources?id=${sourceId}`,
            patch,
        );
        assertEquals(response.status, 200, await response.clone().text());
        await response.body?.cancel();
        assertQuarantined(
            runtime.composition,
            await runtime.source(sourceId),
            "modelMap",
        );
        assertEquals(
            (await runtime.scope.get<StoredSourceConfig>([sourceId]))?.value
                .modelMap,
            malformedMap,
        );
    }
    const savedConfig = await runtime.call(
        "PUT",
        `/admin/source-config?id=${sourceId}`,
        {
            config: {
                baseUrl: "https://provider.example/v1",
                apiKey: "updated-key",
            },
        },
    );
    assertEquals(savedConfig.status, 409, await savedConfig.clone().text());
    assertEquals(
        (await savedConfig.json()).error.code,
        "source_model_map_invalid",
    );
    assertQuarantined(
        runtime.composition,
        await runtime.source(sourceId),
        "modelMap",
    );
    const restarted = await load(resources, runtime.store);
    assertQuarantined(
        restarted.composition,
        await restarted.source(sourceId),
        "modelMap",
    );
    assertExists(restarted.composition.sources.get(healthyId));
});

Deno.test("invalid provider config stays durable and cataloged until source-config saves a repair", async () => {
    await using resources = new AsyncDisposableStack();
    const damaged = {
        ...record(sourceId),
        modelMap: { public: "upstream" },
        config: {
            id: sourceId,
            baseUrl: "invalid-provider-url",
            apiKey: "preserved-private-key",
        },
    };
    const runtime = await fixture(resources, damaged);
    const preserved = await runtime.scope.get<StoredSourceConfig>([sourceId]);
    assertExists(
        preserved,
        "provider validation must not delete persisted config",
    );
    assertEquals(preserved.value, damaged);
    assertQuarantined(
        runtime.composition,
        await runtime.source(sourceId),
        "config",
    );
    assertExists(runtime.composition.sources.get(healthyId));
    const restarted = await load(resources, runtime.store);
    assertQuarantined(
        restarted.composition,
        await restarted.source(sourceId),
        "config",
    );
    assertEquals(await runtime.scope.get([sourceId]), preserved);

    const response = await restarted.call(
        "PUT",
        `/admin/source-config?id=${sourceId}`,
        { config: { baseUrl: "https://provider.example/v1" } },
        preserved.versionstamp,
    );
    assertEquals(response.status, 200, await response.clone().text());
    await response.body?.cancel();
    const repaired = await restarted.source(sourceId);
    assertEquals(repaired.configurationError, undefined);
    assertEquals(repaired.configurationErrorField, undefined);
    assertEquals(repaired.modelMap, damaged.modelMap);
    assertEquals(repaired.enabled, true);
    assertExists(restarted.composition.sources.get(sourceId));
    const stored = await runtime.scope.get<StoredSourceConfig>([sourceId]);
    assertEquals(
        (stored?.value.config as { baseUrl: string }).baseUrl,
        "https://provider.example/v1",
    );
    const healthy = await load(resources, runtime.store);
    assertEquals(
        (await healthy.source(sourceId)).configurationError,
        undefined,
    );
    assertExists(healthy.composition.sources.get(sourceId));
});
