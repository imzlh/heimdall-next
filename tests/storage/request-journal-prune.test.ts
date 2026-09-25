import { assertEquals } from "@std/assert";
import { openSqliteRequestStore } from "@heimdall/core/storage/sqlite-requests.ts";

type Store = ReturnType<typeof openSqliteRequestStore>;

function seed(store: Store, id: string, receivedAt: string): void {
    store.createRequest({
        requestId: id,
        receivedAt,
        operation: "generation.create",
        request: { ok: true },
    });
    store.appendFrame({
        version: 1,
        streamId: `run:${id}`,
        requestId: id,
        seq: 1,
        eventId: `${id}:1`,
        timestamp: receivedAt,
        event: { kind: "run.started" },
    });
    store.putUsage({
        requestId: id,
        inputTokens: 1,
        totalTokens: 1,
        updatedAt: receivedAt,
    });
}

Deno.test("pruneOlderThan removes aged requests with their frames and usage", () => {
    const directory = Deno.makeTempDirSync({ prefix: "heimdall-prune-" });
    const store = openSqliteRequestStore(`${directory}/requests.sqlite`);
    try {
        seed(store, "old", "2020-01-01T00:00:00.000Z");
        seed(store, "new", "2030-01-01T00:00:00.000Z");
        assertEquals(store.pruneOlderThan("2025-01-01T00:00:00.000Z", 100), {
            deleted: 1,
            done: true,
        });
        assertEquals(store.getRequest("old"), null);
        assertEquals(store.listFrames("old").length, 0);
        assertEquals(store.getUsage("old"), null);
        assertEquals(store.getRequest("new")?.requestId, "new");
        assertEquals(store.listFrames("new").length, 1);
        assertEquals(store.getUsage("new")?.totalTokens, 1);
    } finally {
        store.close();
        Deno.removeSync(directory, { recursive: true });
    }
});
Deno.test("pruneOlderThan honors the delete budget across sweeps", () => {
    const directory = Deno.makeTempDirSync({
        prefix: "heimdall-prune-budget-",
    });
    const store = openSqliteRequestStore(`${directory}/requests.sqlite`);
    try {
        seed(store, "a", "2020-01-01T00:00:00.000Z");
        seed(store, "b", "2020-01-02T00:00:00.000Z");
        seed(store, "c", "2020-01-03T00:00:00.000Z");
        assertEquals(store.pruneOlderThan("2025-01-01T00:00:00.000Z", 2), {
            deleted: 2,
            done: false,
        });
        assertEquals(store.pruneOlderThan("2025-01-01T00:00:00.000Z", 2), {
            deleted: 1,
            done: true,
        });
        assertEquals(store.listRequests().length, 0);
    } finally {
        store.close();
        Deno.removeSync(directory, { recursive: true });
    }
});
