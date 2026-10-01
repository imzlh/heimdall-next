import { assert, assertEquals, assertExists, assertFalse } from "@std/assert";
import type { SourceDto } from "@heimdall/admin-contracts";
import { UI_LIMITS } from "@heimdall/admin-contracts/ui.ts";
import type { InferenceSource } from "@heimdall/contracts";
import { loadBuiltinComposition } from "@heimdall/core/composition/builtins.ts";
import { createServerApp } from "@heimdall/core/http/app.ts";

const sourceId = "bc84a114-1e11-4257-a3dd-37fd69435259";
const sourcePluginId = "heimdall.source.openai-compatible";
const context = {
    request: new Request("http://localhost/admin/status"),
    requestId: "source-ui-snapshot",
};

async function fixture() {
    const composition = await loadBuiltinComposition({ env: () => undefined });
    try {
        assertExists(composition.management.createSource);
        await composition.management.createSource(context, {
            id: sourceId,
            name: "Snapshot fixture",
            priority: 3,
            sourcePluginId,
            config: { baseUrl: "https://source.example/v1" },
        });
        const list = async (): Promise<readonly SourceDto[]> => {
            const provider = composition.catalog.sources;
            return typeof provider === "function"
                ? await provider(context)
                : provider ?? [];
        };
        return { composition, list };
    } catch (error) {
        await composition.close();
        throw error;
    }
}

function source(
    uiSnapshot: NonNullable<InferenceSource["uiSnapshot"]>,
): InferenceSource {
    return {
        id: sourceId,
        capabilities: [{
            operation: "generation.create",
            models: ["live-model"],
            streaming: true,
        }],
        execute() {
            throw new Error("listing must not execute a source");
        },
        probe() {
            throw new Error("listing must not probe a source");
        },
        uiSnapshot,
    };
}

Deno.test("source catalog transports detached live plugin state through status and preserves it across priority edits", async () => {
    const { composition, list } = await fixture();
    await using resources = new AsyncDisposableStack();
    resources.defer(() => composition.close());
    const state = {
        summary: { revision: 1 },
        entries: ["first"],
        available: true,
    };
    const live = source(() => state);
    composition.sources.upsert(live);
    composition.sources.recordProbe(sourceId, {
        ok: true,
        message: "ready",
        models: ["discovered-model"],
    });
    const initial = (await list())[0]!;
    assertExists(initial.ui);
    assertEquals(initial.ui, state);
    assertEquals(initial.models, ["discovered-model", "live-model"]);
    assertEquals(initial.name, "Snapshot fixture");
    assertEquals(initial.probe?.ok, true);
    assert(initial.ui !== state);
    assert(initial.ui.summary !== state.summary);
    state.summary.revision = 2;
    state.entries.push("second");
    assertEquals(initial.ui.summary, { revision: 1 });
    assertEquals(initial.ui.entries, ["first"]);

    assertExists(composition.management.updateSource);
    await composition.management.updateSource(context, sourceId, {
        priority: 7,
    });
    const updated = (await list())[0]!;
    assertEquals(updated.priority, 7);
    assertEquals(updated.ui, state);
    assertEquals(updated.models, ["discovered-model", "live-model"]);

    const app = createServerApp({ adminCatalog: composition.catalog });
    const response = await app.request("/admin/status");
    assertEquals(response.status, 200);
    const status = await response.json();
    assertEquals(status.sources[0].ui, state);

    await composition.management.updateSource(context, sourceId, {
        enabled: false,
    });
    assertEquals(composition.sources.get(sourceId), undefined);
    const disabled = (await list())[0]!;
    assertEquals(disabled.enabled, false);
    assertFalse(Object.hasOwn(disabled, "ui"));
});

Deno.test("invalid or throwing plugin snapshots cannot hide source metadata or other source snapshots", async () => {
    const { composition, list } = await fixture();
    await using resources = new AsyncDisposableStack();
    resources.defer(() => composition.close());
    const live = source(() => ({ initial: true }));
    composition.sources.upsert(live);
    composition.sources.register({
        ...source(() => ({ message: "other source remains available" })),
        id: "other-source",
    });
    composition.sources.recordProbe(sourceId, {
        ok: false,
        message: "retry later",
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const serializationChangesShape = Object.defineProperty(
        { valid: true },
        "toJSON",
        {
            value: () => [],
        },
    );
    const invalid: unknown[] = [
        undefined,
        null,
        [],
        "text",
        { value: Number.NaN },
        { value: new Date() },
        { value: 1n },
        { value: () => "not JSON" },
        { value: "x".repeat(UI_LIMITS.jsonBytes) },
        JSON.parse('{"__proto__":{"unsafe":true}}'),
        serializationChangesShape,
        cycle,
    ];
    const unavailable = async () => {
        const rows = await list();
        const row = rows.find((entry) => entry.id === sourceId)!;
        assertEquals(row.name, "Snapshot fixture");
        assertEquals(row.enabled, true);
        assertEquals(row.models, ["live-model"]);
        assertEquals(row.health, "cooldown");
        assertEquals(row.probe?.message, "retry later");
        assertFalse(Object.hasOwn(row, "ui"));
        assertEquals(rows.find((entry) => entry.id === "other-source")?.ui, {
            message: "other source remains available",
        });
    };
    for (const value of invalid) {
        live.uiSnapshot = () => value as never;
        await unavailable();
    }
    live.uiSnapshot = () => {
        throw new Error("private plugin diagnostic");
    };
    await unavailable();
    Object.defineProperty(live, "uiSnapshot", {
        get() {
            throw new Error("private accessor diagnostic");
        },
    });
    await unavailable();
});
