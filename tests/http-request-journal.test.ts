import { assert, assertEquals, assertMatch } from "@std/assert";
import type {
    FrameDto,
    RequestDetailDto,
    RequestSummaryDto,
} from "@heimdall/admin-contracts";
import type {
    NewRequestRecord,
    RequestStatus,
    RequestStore,
} from "@heimdall/storage";
import type { ServerApp } from "@heimdall/core/http/app.ts";
import { openSqliteRequestStore } from "@heimdall/core/storage/sqlite-requests.ts";
import { createServer } from "../main.ts";

const token = "journal-test-admin-token";
const receivedAt = "2026-09-27T08:00:00.000Z";
const prefixes = ["/admin", "/api/admin"] as const;

interface RequestPage {
    requests: RequestSummaryDto[];
    nextCursor: string | null;
}

interface DetailPage {
    request: RequestDetailDto;
    frames: FrameDto[];
    nextAfterSeq: number | null;
}

function authorized(): RequestInit {
    return {
        headers: {
            authorization: `Bearer ${token}`,
            "x-request-id": "journal-http-test",
        },
    };
}

async function withJournal(
    run: (app: ServerApp, store: RequestStore) => Promise<void>,
): Promise<void> {
    const directory = Deno.makeTempDirSync({ prefix: "journal-http-" });
    const store = openSqliteRequestStore(`${directory}/requests.sqlite`);
    try {
        await run(
            createServer({
                requestJournal: store,
                adminAuthToken: token,
                statsTimeZone: "UTC",
            }),
            store,
        );
    } finally {
        store.close();
        Deno.removeSync(directory, { recursive: true });
    }
}

function seed(
    store: RequestStore,
    requestId: string,
    fields: Partial<Omit<NewRequestRecord, "requestId">> = {},
    status: RequestStatus = "completed",
): void {
    store.createRequest({
        requestId,
        receivedAt,
        operation: "generation.create",
        model: "model-a",
        request: { messages: [{ text: "payload-only-marker" }] },
        ...fields,
    });
    store.updateRequest(requestId, { status });
}

function appendFrames(
    store: RequestStore,
    requestId: string,
    sequences: readonly number[],
): void {
    for (const seq of sequences) {
        store.appendFrame({
            version: 1,
            streamId: `run:${requestId}`,
            requestId,
            seq,
            eventId: `${requestId}:${seq}`,
            timestamp: receivedAt,
            event: { kind: "part.delta", delta: `chunk-${seq}` },
            extensions: { note: `extension-${seq}` },
        });
    }
}

async function list(
    app: ServerApp,
    query: Record<string, string> = {},
): Promise<RequestPage> {
    const response = await app.request(
        `/admin/requests?${new URLSearchParams(query)}`,
        authorized(),
    );
    assertEquals(response.status, 200);
    return await response.json();
}

async function detail(
    app: ServerApp,
    id: string,
    query: Record<string, string> = {},
): Promise<DetailPage> {
    const response = await app.request(
        `/admin/requests?${new URLSearchParams({ id, ...query })}`,
        authorized(),
    );
    assertEquals(response.status, 200);
    return await response.json();
}

function ids(page: RequestPage): string[] {
    return page.requests.map((record) => record.requestId);
}

Deno.test("journal HTTP cursor traverses timestamp ties without skips or duplicate new rows", async () => {
    await withJournal(async (app, store) => {
        seed(store, "req-old", { receivedAt: "2026-09-27T07:00:00.000Z" });
        for (const id of ["req-a", "req-c", "req-b"]) seed(store, id);
        seed(store, "req-new", { receivedAt: "2026-09-27T09:00:00.000Z" });

        const first = await list(app, { limit: "2" });
        assertEquals(ids(first), ["req-new", "req-c"]);
        assert(typeof first.nextCursor === "string");
        assertMatch(first.nextCursor, /^[A-Za-z0-9_-]+$/);

        seed(store, "req-inserted", {
            receivedAt: "2026-09-27T10:00:00.000Z",
        });
        seed(store, "req-d");
        const second = await list(app, {
            limit: "2",
            cursor: first.nextCursor,
        });
        assertEquals(ids(second), ["req-b", "req-a"]);
        assert(typeof second.nextCursor === "string");
        const last = await list(app, {
            limit: "2",
            cursor: second.nextCursor,
        });
        assertEquals(ids(last), ["req-old"]);
        assertEquals(last.nextCursor, null);
        assertEquals(ids(await list(app, { limit: "3" })), [
            "req-inserted",
            "req-new",
            "req-d",
        ]);
    });
});

Deno.test("journal HTTP uses default and maximum page sizes and exposes only summaries", async () => {
    await withJournal(async (app, store) => {
        for (let index = 0; index < 110; index++) {
            seed(store, `req-${String(index).padStart(3, "0")}`);
        }
        const standard = await list(app);
        assertEquals(standard.requests.length, 50);
        assert(typeof standard.nextCursor === "string");
        assertEquals(
            JSON.stringify(standard).includes("payload-only-marker"),
            false,
        );
        const maximum = await list(app, { limit: "100" });
        assertEquals(maximum.requests.length, 100);
        assert(typeof maximum.nextCursor === "string");
        const capped = await list(app, { limit: "101" });
        assertEquals(capped, maximum);
        const remainder = await list(app, {
            limit: "100",
            cursor: maximum.nextCursor,
        });
        assertEquals(remainder.requests.length, 10);
        assertEquals(remainder.nextCursor, null);
    });
});

Deno.test("journal HTTP list carries token usage on summaries and omits it otherwise", async () => {
    await withJournal(async (app, store) => {
        seed(store, "req-usage");
        store.putUsage({
            requestId: "req-usage",
            inputTokens: 34001,
            outputTokens: 422,
            cachedInputTokens: 33210,
            cacheWriteTokens: 601,
            totalTokens: 34423,
            extensions: { estimated: true },
            updatedAt: receivedAt,
        });
        seed(store, "req-plain");
        const page = await list(app);
        const usage = page.requests.find((row) => row.requestId === "req-usage")
            ?.usage;
        assertEquals(usage?.inputTokens, 34001);
        assertEquals(usage?.outputTokens, 422);
        assertEquals(usage?.cachedInputTokens, 33210);
        assertEquals(usage?.cacheWriteTokens, 601);
        assertEquals(usage?.extensions, { estimated: true });
        // A request without a usage row leaves the field off the summary.
        const plain = page.requests.find((row) =>
            row.requestId === "req-plain"
        );
        assertEquals(Object.hasOwn(plain!, "usage"), false);
    });
});

Deno.test("journal HTTP summary carries first-token latency and streaming intent", async () => {
    await withJournal(async (app, store) => {
        seed(store, "req-stream", {
            request: { traits: { streaming: true }, payload: { messages: [] } },
        });
        store.markFirstToken("req-stream", "2026-09-27T08:00:01.500Z");
        seed(store, "req-oneshot", {
            request: {
                traits: { streaming: false },
                payload: { messages: [] },
            },
        });

        const page = await list(app);
        const streamed = page.requests.find((row) =>
            row.requestId === "req-stream"
        );
        assertEquals(streamed?.streaming, true);
        assertEquals(streamed?.firstTokenAt, "2026-09-27T08:00:01.500Z");

        const oneshot = page.requests.find((row) =>
            row.requestId === "req-oneshot"
        );
        assertEquals(oneshot?.streaming, false);
        // No content frame was stamped, so first-token stays absent.
        assertEquals(Object.hasOwn(oneshot!, "firstTokenAt"), false);
    });
});

Deno.test("journal HTTP combines trimmed metadata search with status and cursor pagination", async () => {
    await withJournal(async (app, store) => {
        seed(store, "match-1");
        seed(store, "req-2", { model: "provider-match-model" });
        seed(store, "req-3", { operation: "match.operation" });
        seed(store, "req-4", { protocolPluginId: "protocol.match" });
        seed(store, "req-5", { upstreamPluginId: "source.match" });
        seed(store, "req-error", { model: "match" }, "error");
        seed(store, "req-running", { model: "match" }, "running");
        seed(store, "req-hidden", {
            request: { privateText: "match" },
            metadata: { note: "match" },
        });
        store.updateRequest("req-hidden", {
            status: "completed",
            response: { privateText: "match" },
            error: { message: "match" },
        });

        const first = await list(app, {
            status: "completed",
            q: "  match  ",
            limit: "3",
        });
        assertEquals(ids(first), ["req-5", "req-4", "req-3"]);
        assert(typeof first.nextCursor === "string");
        const second = await list(app, {
            status: "completed",
            q: "match",
            limit: "3",
            cursor: first.nextCursor,
        });
        assertEquals(ids(second), ["req-2", "match-1"]);
        assertEquals(second.nextCursor, null);
        assertEquals(ids(await list(app, { q: "match", status: "error" })), [
            "req-error",
        ]);
        assertEquals(ids(await list(app, { q: "payload-only-marker" })), []);
        assertEquals((await list(app, { q: "  " })).requests.length, 8);
        assertEquals(ids(await list(app, { q: "x".repeat(200) })), []);
    });
});

Deno.test("journal HTTP searches percent and underscore as literal text", async () => {
    await withJournal(async (app, store) => {
        seed(store, "req-percent", { model: "capacity%remaining" });
        seed(store, "req-underscore", { model: "model_special" });
        seed(store, "req-ordinary", { model: "modelXspecial" });
        assertEquals(ids(await list(app, { q: "%" })), ["req-percent"]);
        assertEquals(ids(await list(app, { q: "_" })), ["req-underscore"]);
        assertEquals(ids(await list(app, { q: "model_special" })), [
            "req-underscore",
        ]);
    });
});

Deno.test("journal HTTP keeps the legacy exclusive before timestamp filter", async () => {
    await withJournal(async (app, store) => {
        seed(store, "req-old", { receivedAt: "2026-09-27T07:00:00.000Z" });
        seed(store, "req-tied-a");
        seed(store, "req-tied-b");
        seed(store, "req-new", { receivedAt: "2026-09-27T09:00:00.000Z" });
        const page = await list(app, { before: receivedAt });
        assertEquals(ids(page), ["req-old"]);
        assertEquals(page.nextCursor, null);
    });
});

Deno.test("journal HTTP detail preserves payloads and paginates noncontiguous frame sequences", async () => {
    await withJournal(async (app, store) => {
        seed(store, "req-frames", {
            request: { messages: [{ role: "user", text: "你好" }] },
            metadata: { channel: "测试渠道" },
        });
        store.updateRequest("req-frames", {
            status: "error",
            completedAt: "2026-09-27T08:00:01.000Z",
            response: { text: "partial" },
            error: { code: "upstream_error", message: "interrupted" },
        });
        store.putUsage({
            requestId: "req-frames",
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 5,
            cost: "0.0005",
            currency: "USD",
            extensions: { estimated: true },
            updatedAt: receivedAt,
        });
        appendFrames(store, "req-frames", [12, 5, 0, 9, 2]);
        const first = await detail(app, "req-frames", {
            afterSeq: "-1",
            frameLimit: "2",
        });
        assertEquals(first.request.status, "error");
        assertEquals(first.request.request, {
            messages: [{ role: "user", text: "你好" }],
        });
        assertEquals(first.request.response, { text: "partial" });
        assertEquals(first.request.error, {
            code: "upstream_error",
            message: "interrupted",
        });
        assertEquals(first.request.usage?.totalTokens, 5);
        assertEquals(first.request.usage?.cost, "0.0005");
        assertEquals(first.request.metadata, { channel: "测试渠道" });
        assertEquals(first.request.usage?.extensions, { estimated: true });
        assertEquals(first.frames.map((frame) => frame.seq), [0, 2]);
        assertEquals(first.frames[0]?.extensions, { note: "extension-0" });
        assertEquals(first.nextAfterSeq, 2);

        const second = await detail(app, "req-frames", {
            afterSeq: String(first.nextAfterSeq),
            frameLimit: "2",
        });
        assertEquals(second.frames.map((frame) => frame.seq), [5, 9]);
        assertEquals(second.nextAfterSeq, 9);
        const last = await detail(app, "req-frames", {
            afterSeq: String(second.nextAfterSeq),
            frameLimit: "2",
        });
        assertEquals(last.frames.map((frame) => frame.seq), [12]);
        assertEquals(last.nextAfterSeq, null);
        const empty = await detail(app, "req-frames", { afterSeq: "12" });
        assertEquals(empty.frames, []);
        assertEquals(empty.nextAfterSeq, null);
    });
});

Deno.test("journal HTTP exports all frames beyond list limits as a JSON attachment", async () => {
    await withJournal(async (app, store) => {
        seed(store, "req-export", { request: { prompt: "完整日志" } });
        const sequences = Array.from({ length: 650 }, (_, index) => index * 2);
        appendFrames(store, "req-export", sequences);
        const standard = await detail(app, "req-export");
        assertEquals(standard.frames.length, 100);
        assertEquals(standard.nextAfterSeq, 198);
        const maximum = await detail(app, "req-export", { frameLimit: "200" });
        assertEquals(maximum.frames.length, 200);
        assertEquals(maximum.nextAfterSeq, 398);
        const capped = await detail(app, "req-export", { frameLimit: "201" });
        assertEquals(capped, maximum);

        for (const prefix of prefixes) {
            const response = await app.request(
                `${prefix}/requests/export?id=req-export`,
                authorized(),
            );
            assertEquals(response.status, 200);
            assertMatch(
                response.headers.get("content-type") ?? "",
                /^application\/json/,
            );
            assertMatch(
                response.headers.get("content-disposition") ?? "",
                /^attachment;/,
            );
            assertEquals(
                response.headers.get("x-heimdall-request-id"),
                "journal-http-test",
            );
            const exported = await response.json();
            assertEquals(exported.request.requestId, "req-export");
            assertEquals(exported.request.request, { prompt: "完整日志" });
            assertEquals(
                (exported.frames as FrameDto[]).map((frame) => frame.seq),
                sequences,
            );
            assertEquals(exported.frames.at(-1).event.delta, "chunk-1298");
            assertEquals(exported.frames.at(-1).extensions, {
                note: "extension-1298",
            });
        }
    });
});

Deno.test("journal HTTP reports null cursors for empty lists and details without frames", async () => {
    await withJournal(async (app, store) => {
        assertEquals(await list(app), { requests: [], nextCursor: null });
        seed(store, "req-empty");
        const page = await detail(app, "req-empty");
        assertEquals(page.frames, []);
        assertEquals(page.nextAfterSeq, null);
    });
});

Deno.test("journal HTTP rejects malformed cursors, bounds, sequence values, dates, and identifiers", async () => {
    await withJournal(async (app, store) => {
        seed(store, "req-valid");
        const queries: Record<string, string>[] = [
            { status: "successful" },
            { limit: "0" },
            { limit: "1.5" },
            { limit: "1e2" },
            { limit: "9007199254740992" },
            { q: "x".repeat(201) },
            { before: "not-a-date" },
            { before: "2026-99-99T00:00:00.000Z" },
            { before: "2026-02-30T00:00:00.000Z" },
            { before: "2026-01-01T99:00:00Z" },
            { cursor: "" },
            { cursor: "not!base64" },
            { cursor: "e30" },
            { cursor: "W10" },
            { cursor: "bnVsbA" },
            { cursor: "_w" },
            { cursor: "x".repeat(3_000) },
            { id: "" },
            { id: "   " },
            { id: "invalid/path" },
            { id: "invalid\\path" },
            { id: "x".repeat(201) },
            { id: "req-valid", afterSeq: "-2" },
            { id: "req-valid", afterSeq: "0.5" },
            { id: "req-valid", afterSeq: "1e2" },
            { id: "req-valid", afterSeq: "NaN" },
            { id: "req-valid", afterSeq: "1x" },
            { id: "req-valid", afterSeq: "9007199254740992" },
            { id: "req-valid", frameLimit: "0" },
            { id: "req-valid", frameLimit: "9007199254740992" },
            { id: "req-valid", frameLimit: "1.5" },
        ];
        for (const query of queries) {
            const response = await app.request(
                `/admin/requests?${new URLSearchParams(query)}`,
                authorized(),
            );
            assertEquals(response.status, 400, JSON.stringify(query));
            assertEquals(
                response.headers.get("x-heimdall-request-id"),
                "journal-http-test",
            );
            const body = await response.json();
            assertEquals(
                body.error.code,
                "invalid_request",
                JSON.stringify(query),
            );
        }
        for (const query of ["", "?id=", "?id=%20", "?id=bad%2Fid"]) {
            const response = await app.request(
                `/admin/requests/export${query}`,
                authorized(),
            );
            assertEquals(response.status, 400, query);
        }
    });
});

Deno.test("journal HTTP returns not found for unknown detail and export ids", async () => {
    await withJournal(async (app) => {
        for (const prefix of prefixes) {
            for (
                const path of [
                    "/requests?id=unknown",
                    "/requests/export?id=unknown",
                ]
            ) {
                const response = await app.request(
                    `${prefix}${path}`,
                    authorized(),
                );
                assertEquals(response.status, 404);
                assertEquals((await response.json()).error.code, "not_found");
            }
        }
    });
});

Deno.test("journal HTTP requires admin authentication for lists, detail, and exports on both prefixes", async () => {
    await withJournal(async (app, store) => {
        seed(store, "req-auth");
        for (const prefix of prefixes) {
            for (
                const path of [
                    "/requests",
                    "/requests?id=req-auth",
                    "/requests/export?id=req-auth",
                ]
            ) {
                for (
                    const authorization of [undefined, "Bearer invalid-token"]
                ) {
                    const response = await app.request(`${prefix}${path}`, {
                        headers: authorization === undefined
                            ? {}
                            : { authorization },
                    });
                    assertEquals(response.status, 401, `${prefix}${path}`);
                }
                const response = await app.request(
                    `${prefix}${path}`,
                    authorized(),
                );
                assertEquals(response.status, 200, `${prefix}${path}`);
            }
        }
    });
});
