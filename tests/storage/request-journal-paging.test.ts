import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { openSqliteRequestStore } from "@heimdall/core/storage/sqlite-requests.ts";
import { exportRequestJournal } from "@heimdall/core/http/request-journal-export.ts";

const time = "2026-09-22T00:00:00.000Z";

function request(store: ReturnType<typeof openSqliteRequestStore>, id: string) {
    store.createRequest({
        requestId: id,
        receivedAt: time,
        request: { text: "hidden-payload" },
    });
}

function frame(store: ReturnType<typeof openSqliteRequestStore>, seq: number) {
    store.appendFrame({
        version: 1,
        requestId: "req-stream",
        streamId: "run:req-stream",
        seq,
        eventId: `event:${seq}`,
        timestamp: time,
        event: { kind: "part.delta", delta: `frame ${seq}` },
    });
}

Deno.test("journal cursors keep tied rows reachable after the boundary request is gone", () => {
    const store = openSqliteRequestStore(":memory:");
    try {
        for (const id of ["req-a", "req-c", "req-b"]) request(store, id);
        const first = store.listRequests({ limit: 1 })[0]!;
        assertEquals(first.requestId, "req-c");
        // The cursor is an ordering tuple, not a lookup of a live request.
        assertEquals(
            store.listRequests({ cursor: { ...first, requestId: "req-bb" } })
                .map((entry) => entry.requestId),
            ["req-b", "req-a"],
        );
        request(store, "req-d");
        assertEquals(
            store.listRequests({ cursor: first }).map((entry) =>
                entry.requestId
            ),
            ["req-b", "req-a"],
        );
        store.updateRequest("req-b", { status: "error" });
        assertEquals(
            store.listRequests({ cursor: first, status: "error", q: "req-" })
                .map((entry) => entry.requestId),
            ["req-b"],
        );
    } finally {
        store.close();
    }
});

Deno.test("journal searches literal backslashes and binds SQL metacharacters", () => {
    const store = openSqliteRequestStore(":memory:");
    try {
        request(store, "safe");
        store.createRequest({
            requestId: "special",
            receivedAt: time,
            model: "model\\100%_value",
            request: {},
        });
        for (const q of ["\\", "100%_", "model\\100%_value"]) {
            assertEquals(
                store.listRequests({ q }).map((entry) => entry.requestId),
                ["special"],
            );
        }
        assertEquals(store.listRequests({ q: "' OR 1=1 --" }), []);
        assertEquals(store.listRequests({ q: "hidden-payload" }), []);
    } finally {
        store.close();
    }
});

Deno.test("frame summary reports gaps without treating sequence as a count", () => {
    const store = openSqliteRequestStore(":memory:");
    try {
        request(store, "req-stream");
        assertEquals(store.getFrameSummary("req-stream"), {
            count: 0,
            lastSeq: null,
        });
        frame(store, 0);
        frame(store, 8);
        frame(store, 21);
        assertEquals(store.getFrameSummary("req-stream"), {
            count: 3,
            lastSeq: 21,
        });
        assertEquals(
            store.listFrames("req-stream", 8).map((entry) => entry.seq),
            [21],
        );
        for (const invalid of [-2, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            assertThrows(
                () => store.listFrames("req-stream", invalid),
                TypeError,
            );
        }
        assertThrows(
            () => frame(store, Number.MAX_SAFE_INTEGER + 1),
            TypeError,
        );
    } finally {
        store.close();
    }
});

Deno.test("journal download captures a finite frame range while the request keeps running", async () => {
    const store = openSqliteRequestStore(":memory:");
    try {
        request(store, "req-stream");
        frame(store, 0);
        frame(store, 3);
        const response = exportRequestJournal(
            store,
            store.getRequest("req-stream")!,
            "download-id",
        );
        frame(store, 7);
        const data = await response.json();
        assertEquals(data.frames.map((entry: { seq: number }) => entry.seq), [
            0,
            3,
        ]);
        assertEquals(response.headers.get("cache-control"), "no-store");
        assertEquals(
            response.headers.get("x-heimdall-request-id"),
            "download-id",
        );
    } finally {
        store.close();
    }
});

Deno.test("journal download interrupted by retention fails instead of silently omitting frames", async () => {
    const store = openSqliteRequestStore(":memory:");
    try {
        request(store, "req-stream");
        frame(store, 0);
        frame(store, 3);
        store.updateRequest("req-stream", { status: "completed" });
        const response = exportRequestJournal(
            store,
            store.getRequest("req-stream")!,
            "download-id",
        );
        store.pruneOlderThan("2026-09-23T00:00:00.000Z", 1);
        await assertRejects(
            () => response.json(),
            Error,
            "request journal changed during export",
        );
    } finally {
        store.close();
    }
});
