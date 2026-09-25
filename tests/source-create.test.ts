import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import type { CreateSourceInput, SourceDto } from "@heimdall/admin-contracts";
import {
    type BuiltinComposition,
    loadBuiltinComposition,
} from "@heimdall/core/composition/builtins.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";
import { createServerApp } from "@heimdall/core/http/app.ts";

const context = {
    request: new Request("http://localhost/admin/sources"),
    requestId: "source-create-test",
};
const sourcePluginId = "heimdall.source.openai-compatible";
const customId = "8d1bc6bf-c85f-4d3b-83d9-925a50f79830";
const presetId = "6826c0aa-9530-46cb-b14c-83e7328e62fa";
const customInput: CreateSourceInput = {
    id: customId,
    name: "主渠道",
    priority: 5,
    sourcePluginId,
    config: {
        id: "openai-compatible",
        baseUrl: "https://custom.example/v1",
        apiKey: "private-custom-key",
    },
};

async function listed(
    composition: BuiltinComposition,
): Promise<readonly SourceDto[]> {
    const provider = composition.catalog.sources;
    return typeof provider === "function"
        ? await provider(context)
        : provider ?? [];
}

Deno.test("source creation keeps custom and preset instances separate, named, prioritized and redacted", async () => {
    await using resources = new AsyncDisposableStack();
    const kv = await Deno.openKv(":memory:");
    resources.defer(() => kv.close());
    const store = new DenoKvConfigStore(kv);
    const options = {
        configStore: store,
        pluginRoot: new URL("../plugins/", import.meta.url),
        env: () => undefined,
    };
    const first = await loadBuiltinComposition(options);
    resources.defer(() => first.close());
    assertExists(first.management.createSource);
    assertExists(first.management.saveSourceConfig);
    await first.management.saveSourceConfig(context, "openai-compatible", {
        baseUrl: "https://default.example/v1",
        apiKey: "private-default-key",
    });
    const app = createServerApp({
        adminCatalog: first.catalog,
        adminManagement: first.management,
    });
    const create = async (input: CreateSourceInput) =>
        await app.request("/admin/sources", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
        });
    const custom = await create(customInput);
    assertEquals(custom.status, 201);
    assertExists(custom.headers.get("etag"));
    const customText = await custom.text();
    assert(!customText.includes("private-custom-key"));
    assert(!customText.includes("baseUrl"));
    const customDto = JSON.parse(customText).source;
    assertEquals([
        customDto.id,
        customDto.name,
        customDto.priority,
        customDto.sourcePluginId,
    ], [customId, "主渠道", 5, sourcePluginId]);
    const preset = await create({
        id: presetId,
        name: "备用预设",
        priority: -10,
        sourcePluginId,
        presetId: "heimdall.preset.newapi",
        config: {
            id: "newapi",
            baseUrl: "https://preset.example/v1",
            apiKey: "private-preset-key",
        },
    });
    assertEquals(preset.status, 201);
    const presetText = await preset.text();
    assert(!presetText.includes("private-preset-key"));
    assertEquals(JSON.parse(presetText).source.id, presetId);
    assertEquals(
        first.sources.list().map((item) => item.id).sort(),
        ["openai-compatible", customId, presetId].sort(),
    );
    assertEquals(first.sources.get("newapi"), undefined);
    assertEquals(
        first.sources.get(customId)?.capabilities.map((item) => item.priority),
        [5, 5, 5, 5, 5],
    );
    assert(
        first.sources.get(presetId)?.capabilities.every((item) =>
            item.priority === -10
        ),
    );
    assertEquals(
        first.sources.select({
            version: 1,
            requestId: "route-priority",
            operation: "generation.create",
            payload: { messages: [] },
            traits: { streaming: true },
        }).id,
        presetId,
    );
    const defaultConfig = await first.management.getSourceConfig?.(
        context,
        "openai-compatible",
    );
    assertEquals(
        (defaultConfig?.config as Record<string, unknown>).baseUrl,
        "https://default.example/v1",
    );
    const duplicate = await create({
        ...customInput,
        name: "不应覆盖",
        priority: -99,
    });
    assertEquals(duplicate.status, 409);
    assertEquals(
        (await listed(first)).find((item) => item.id === customId)?.name,
        "主渠道",
    );

    const second = await loadBuiltinComposition(options);
    resources.defer(() => second.close());
    const restored = (await listed(second)).find((item) =>
        item.id === customId
    );
    assertEquals(
        [restored?.name, restored?.priority, restored?.sourcePluginId],
        ["主渠道", 5, sourcePluginId],
    );
    assert(
        second.sources.get(customId)?.capabilities.every((item) =>
            item.priority === 5
        ),
    );
    const snapshot = await second.management.getSourceConfig?.(
        context,
        customId,
    );
    await second.management.saveSourceConfig?.(context, customId, {
        baseUrl: "https://edited.example/v1",
    }, snapshot?.versionstamp);
    const edited = (await listed(second)).find((item) => item.id === customId);
    assertEquals([edited?.name, edited?.priority, edited?.sourcePluginId], [
        "主渠道",
        5,
        sourcePluginId,
    ]);
    assert(
        second.sources.get(customId)?.capabilities.every((item) =>
            item.priority === 5
        ),
    );
    const savedConfig = await second.management.getSourceConfig?.(
        context,
        customId,
    );
    assertEquals(
        (savedConfig?.config as Record<string, unknown>).apiKeyConfigured,
        true,
    );
    assert(!JSON.stringify(savedConfig).includes("private-custom-key"));
    await second.management.setPluginEnabled?.(context, sourcePluginId, false);
    assertEquals(second.sources.list(), []);
    assertEquals(
        (await listed(second)).find((item) => item.id === customId)?.name,
        "主渠道",
    );

    const environment: Record<string, string> = {
        HEIMDALL_OPENAI_BASE_URL: "https://must-not-overwrite.example/v1",
        HEIMDALL_OPENAI_SOURCE_ID: customId,
    };
    const third = await loadBuiltinComposition({
        ...options,
        env: (name) => environment[name],
    });
    resources.defer(() => third.close());
    assertEquals(third.sources.list(), []);
    await third.management.setPluginEnabled?.(context, sourcePluginId, true);
    assert(
        third.sources.get(customId)?.capabilities.every((item) =>
            item.priority === 5
        ),
    );
    assert(
        third.sources.get(presetId)?.capabilities.every((item) =>
            item.priority === -10
        ),
    );
    const final = (await listed(third)).find((item) => item.id === customId);
    assertEquals([final?.name, final?.priority], ["主渠道", 5]);
});

Deno.test("source creation requires exact plugin identity and preset ownership", async () => {
    const composition = await loadBuiltinComposition({ env: () => undefined });
    try {
        const create = composition.management.createSource;
        assertExists(create);
        const missing = await assertRejects(() =>
            Promise.resolve(
                create(context, {
                    ...customInput,
                    sourcePluginId: "openai-compatible",
                }),
            )
        );
        assertEquals((missing as Error & { status: number }).status, 404);
        const mismatched = await assertRejects(() =>
            Promise.resolve(
                create(context, {
                    ...customInput,
                    sourcePluginId: "heimdall.source.anthropic",
                    presetId: "heimdall.preset.newapi",
                }),
            )
        );
        assertEquals((mismatched as Error & { status: number }).status, 400);
        assertEquals(await listed(composition), []);
    } finally {
        await composition.close();
    }
});

Deno.test("concurrent creation of one draft admits exactly one durable source", async () => {
    await using resources = new AsyncDisposableStack();
    const kv = await Deno.openKv(":memory:");
    resources.defer(() => kv.close());
    const composition = await loadBuiltinComposition({
        configStore: new DenoKvConfigStore(kv),
        env: () => undefined,
    });
    resources.defer(() => composition.close());
    const create = composition.management.createSource;
    assertExists(create);
    const outcomes = await Promise.allSettled([
        create(context, customInput),
        create(context, { ...customInput, name: "并发草稿" }),
    ]);
    assertEquals(
        outcomes.filter((item) => item.status === "fulfilled").length,
        1,
    );
    const rejected = outcomes.find((item) => item.status === "rejected");
    assert(rejected?.status === "rejected");
    assertEquals(rejected.reason.status, 409);
    assertEquals((await listed(composition)).length, 1);
    assertEquals(composition.sources.list().length, 1);
});
