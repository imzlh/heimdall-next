import { assert, assertEquals, assertThrows } from "@std/assert";
import { type RequestRecord, StorageConflictError } from "@heimdall/storage";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openSqliteRequestStore } from "@heimdall/core/storage/sqlite-requests.ts";
import { serve } from "@heimdall/core/composition/serve.ts";
import { readServerEnvironment } from "@heimdall/core/composition/runtime-env.ts";
import { systemLog } from "@heimdall/core/observability/system-log.ts";

type Store = ReturnType<typeof openSqliteRequestStore>;
const RECEIVED_AT = "2020-01-01T00:00:00.000Z";

async function withJournal(
    run: (path: string, directory: string) => void | Promise<void>,
): Promise<void> {
    const directory = Deno.makeTempDirSync({ prefix: "heimdall-recovery-" });
    try {
        await run(`${directory}/requests.sqlite`, directory);
    } finally {
        Deno.removeSync(directory, { recursive: true });
    }
}

function seed(store: Store, requestId: string): void {
    store.createRequest({
        requestId,
        receivedAt: RECEIVED_AT,
        request: { content: "journal-only-content" },
    });
    store.appendFrame({
        version: 1,
        requestId,
        streamId: `run:${requestId}`,
        seq: 1,
        eventId: `${requestId}:1`,
        timestamp: RECEIVED_AT,
        event: { kind: "run.started" },
    });
    store.putUsage({
        requestId,
        totalTokens: 3,
        updatedAt: RECEIVED_AT,
    });
}

Deno.test("request journal excludes another writer without changing a live request", () =>
    withJournal((path) => {
        const first = openSqliteRequestStore(path);
        try {
            seed(first, "live");
            assertThrows(
                () =>
                    openSqliteRequestStore(path, { recoverInterrupted: true }),
                StorageConflictError,
                "already open for writing",
            );
            assertEquals(first.getRequest("live")?.status, "running");
            // The sidecar coordinates writers without preventing SQLite readers.
            const reader = new DatabaseSync(path, { readOnly: true });
            try {
                const row = reader.prepare(
                    "SELECT status FROM requests WHERE request_id = ?",
                ).get("live");
                assertEquals(row?.status, "running");
            } finally {
                reader.close();
            }
            first.close();
            first.close();
            const reopened = openSqliteRequestStore(path);
            try {
                assertEquals(reopened.recoveredRequests, 0);
                assertEquals(reopened.getRequest("live")?.status, "running");
                assertEquals(reopened.listFrames("live").length, 1);
            } finally {
                reopened.close();
            }
            assert(Deno.statSync(`${path}.lock`).isFile);
        } finally {
            first.close();
        }
    }));

Deno.test("explicit startup recovery preserves history and enables ordinary retention", () =>
    withJournal((path) => {
        const initial = openSqliteRequestStore(path);
        const terminal = ["completed", "error", "cancelled"] as const;
        const snapshots = new Map<string, RequestRecord | null>();
        try {
            for (const id of ["pending", "running", ...terminal] as const) {
                seed(initial, id);
                initial.updateRequest(id, {
                    status: id,
                    ...(id === "completed" || id === "error" ||
                            id === "cancelled"
                        ? {
                            completedAt: "2020-01-01T00:00:05.000Z",
                            response: { saved: id },
                        }
                        : {}),
                    ...(id === "error" ? { error: { code: "upstream" } } : {}),
                });
                snapshots.set(id, initial.getRequest(id));
            }
        } finally {
            initial.close();
        }
        const beforeRecovery = Date.now();
        const recovered = openSqliteRequestStore(path, {
            recoverInterrupted: true,
        });
        try {
            assertEquals(recovered.recoveredRequests, 2);
            for (const id of ["pending", "running"]) {
                const record = recovered.getRequest(id);
                assertEquals(record?.status, "error");
                assertEquals(record?.error, {
                    code: "process_interrupted",
                    message: "服务进程已中断，请重新发起请求。",
                });
                assert(record?.completedAt);
                assert(Date.parse(record.completedAt) >= beforeRecovery);
                assert(Date.parse(record.completedAt) <= Date.now());
                assertEquals(record?.request, snapshots.get(id)?.request);
                assertEquals(recovered.listFrames(id).length, 1);
                assertEquals(recovered.getUsage(id)?.totalTokens, 3);
            }
            for (const id of terminal) {
                assertEquals(recovered.getRequest(id), snapshots.get(id));
            }
            seed(recovered, "current-process");
            assertEquals(recovered.pruneOlderThan("2021-01-01", 10), {
                deleted: 5,
                done: true,
            });
            assertEquals(recovered.getRequest("pending"), null);
            assertEquals(recovered.listFrames("running"), []);
            assertEquals(recovered.getUsage("running"), null);
            assertEquals(
                recovered.getRequest("current-process")?.status,
                "running",
            );
        } finally {
            recovered.close();
        }
    }));

Deno.test("memory request journals remain independently writable", () => {
    const first = openSqliteRequestStore(":memory:");
    const second = openSqliteRequestStore(":memory:", {
        recoverInterrupted: true,
    });
    try {
        seed(first, "same-id");
        seed(second, "same-id");
        assertEquals(first.getRequest("same-id")?.status, "running");
        assertEquals(second.getRequest("same-id")?.status, "running");
        assertEquals(second.recoveredRequests, 0);
    } finally {
        first.close();
        second.close();
    }
});

Deno.test("physical directory aliases share request journal writer ownership", () =>
    withJournal((_path, directory) => {
        const actual = `${directory}/actual`;
        const alias = `${directory}/alias`;
        Deno.mkdirSync(actual);
        Deno.symlinkSync(actual, alias, {
            type: Deno.build.os === "windows" ? "junction" : "dir",
        });
        const first = openSqliteRequestStore(`${alias}/requests.sqlite`);
        try {
            seed(first, "through-alias");
            assertThrows(
                () => openSqliteRequestStore(`${actual}/requests.sqlite`),
                StorageConflictError,
            );
            if (Deno.build.os === "windows") {
                assertThrows(
                    () => openSqliteRequestStore(`${actual}/REQUESTS.sqlite`),
                    StorageConflictError,
                );
            }
        } finally {
            first.close();
        }
        const reopened = openSqliteRequestStore(`${actual}/requests.sqlite`);
        try {
            assertEquals(
                reopened.getRequest("through-alias")?.status,
                "running",
            );
        } finally {
            reopened.close();
        }
    }));

Deno.test("failed request journal initialization releases database and writer lock", () =>
    withJournal((path) => {
        const future = new DatabaseSync(path);
        future.exec("PRAGMA user_version = 2");
        future.close();
        for (let attempt = 0; attempt < 2; attempt++) {
            assertThrows(
                () =>
                    openSqliteRequestStore(path, { recoverInterrupted: true }),
                Error,
                "unsupported request journal schema version 2",
            );
        }
        const repair = new DatabaseSync(path);
        repair.exec("PRAGMA user_version = 1");
        repair.close();
        const reopened = openSqliteRequestStore(path);
        try {
            seed(reopened, "after-initialization-error");
        } finally {
            reopened.close();
        }
    }));

Deno.test("invalid SQLite bytes do not strand request journal ownership", () =>
    withJournal((path) => {
        Deno.writeTextFileSync(path, "not a SQLite database");
        for (let attempt = 0; attempt < 2; attempt++) {
            const failure = assertThrows(() => openSqliteRequestStore(path));
            assert(!(failure instanceof StorageConflictError));
        }
        Deno.removeSync(path);
        const reopened = openSqliteRequestStore(path);
        try {
            seed(reopened, "after-file-repair");
        } finally {
            reopened.close();
        }
    }));

Deno.test({
    name: "Windows request journal rejects trailing-dot aliases before locking",
    ignore: Deno.build.os !== "windows",
    fn: () =>
        withJournal((path) => {
            assertThrows(
                () => openSqliteRequestStore(`${path}.`),
                TypeError,
                "must not end in a dot or space",
            );
            assertThrows(() => Deno.statSync(path), Deno.errors.NotFound);
            assertThrows(
                () => Deno.statSync(`${path}..lock`),
                Deno.errors.NotFound,
            );
        }),
});

Deno.test("request journal rejects dangling links without locking a different path", () =>
    withJournal((path, directory) => {
        Deno.symlinkSync(`${directory}/missing`, path, {
            type: Deno.build.os === "windows" ? "junction" : "file",
        });
        assertThrows(
            () => openSqliteRequestStore(path),
            TypeError,
            "symbolic link must target an existing file",
        );
        assertThrows(() => Deno.statSync(`${path}.lock`), Deno.errors.NotFound);
    }));

Deno.test("request journal rejects hard-link aliases with independent lock names", () =>
    withJournal((path, directory) => {
        const initial = new DatabaseSync(path);
        initial.close();
        const alias = `${directory}/alias.sqlite`;
        Deno.linkSync(path, alias);
        for (const candidate of [path, alias]) {
            assertThrows(
                () => openSqliteRequestStore(candidate),
                TypeError,
                "must not use hard links",
            );
        }
    }));

Deno.test("a process exit releases request ownership for restart recovery", () =>
    withJournal(async (path) => {
        const module = new URL(
            "../../src/storage/sqlite-requests.ts",
            import.meta.url,
        ).href;
        const configuration = new URL("../../deno.json", import.meta.url);
        const script = `
            import { openSqliteRequestStore } from ${JSON.stringify(module)};
            const store = openSqliteRequestStore(${JSON.stringify(path)});
            store.createRequest({requestId:"orphaned", receivedAt:${
            JSON.stringify(RECEIVED_AT)
        }, request:{}});
            Deno.exit(19);
        `;
        const output = await new Deno.Command(Deno.execPath(), {
            args: [
                "eval",
                "--cached-only",
                "--node-modules-dir=none",
                "--config",
                fileURLToPath(configuration),
                script,
            ],
            stdout: "piped",
            stderr: "piped",
        }).output();
        assertEquals(output.code, 19, new TextDecoder().decode(output.stderr));
        const restarted = openSqliteRequestStore(path, {
            recoverInterrupted: true,
        });
        try {
            assertEquals(restarted.recoveredRequests, 1);
            assertEquals(restarted.getRequest("orphaned")?.status, "error");
        } finally {
            restarted.close();
        }
    }));

Deno.test("server startup opts into request recovery and logs only the count", () =>
    withJournal(async (path, directory) => {
        const initial = openSqliteRequestStore(path);
        seed(initial, "private-request-id");
        initial.close();
        const previous = systemLog.list().nextAfterSeq;
        const environment = readServerEnvironment(() => undefined, directory);
        const controller = new AbortController();
        await serve({
            environment: {
                ...environment,
                port: 0,
                kvPath: ":memory:",
                requestsPath: path,
                chatPath: ":memory:",
                chatAssetsPath: ":memory:",
                runtimeSettings: {
                    ...environment.runtimeSettings,
                    probeIntervalMs: 0,
                },
            },
            signal: controller.signal,
            onListen: () => controller.abort(),
        });
        const events = systemLog.list({ afterSeq: previous }).entries;
        const recovery = events.find((entry) =>
            entry.scope === "startup" && entry.message.includes("1 条请求")
        );
        assert(recovery);
        assertEquals(recovery.detail, undefined);
        assert(!JSON.stringify(events).includes("private-request-id"));
        assert(!JSON.stringify(events).includes("journal-only-content"));
        const reopened = openSqliteRequestStore(path);
        try {
            assertEquals(
                reopened.getRequest("private-request-id")?.status,
                "error",
            );
        } finally {
            reopened.close();
        }
    }));
