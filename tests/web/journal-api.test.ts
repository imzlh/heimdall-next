import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import type {
    FrameDto,
    RequestDetailDto,
    RequestSummaryDto,
} from "@heimdall/admin-contracts";
import {
    exportJournalRequest,
    loadJournalRequest,
    loadJournalRequests,
} from "@heimdall/core/web/client/api/journal.ts";
import {
    AdminApiError,
    clearAdminToken,
    configureAdminTransport,
    setAdminToken,
} from "@heimdall/core/web/client/api/transport.ts";

const row: RequestSummaryDto = {
    requestId: "request-1",
    status: "completed",
    receivedAt: "2026-09-27T04:00:00.000Z",
    completedAt: "2026-09-27T04:00:02.000Z",
    streamId: "stream-1",
    operation: "chat",
    model: "model-1",
    protocolPluginId: "openai-protocol",
    upstreamPluginId: "openai-source",
};
const detail: RequestDetailDto = {
    ...row,
    request: { messages: [{ role: "user", content: "请求原文" }] },
    response: { content: "响应原文" },
    error: null,
    usage: {
        requestId: row.requestId,
        updatedAt: row.completedAt!,
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 2,
        cachedInputTokens: 3,
        cacheWriteTokens: 0,
        totalTokens: 30,
        cost: "0.003",
        currency: "USD",
    },
};
function frame(seq: number): FrameDto {
    return {
        version: 1,
        requestId: row.requestId,
        streamId: row.streamId!,
        seq,
        eventId: `event-${seq}`,
        timestamp: row.receivedAt,
        event: { type: "text.delta", text: `片段 ${seq}` },
        causationId: "incoming-request",
    };
}

function respondWith(
    handler: (
        input: RequestInfo | URL,
        init?: RequestInit,
    ) => Response | Promise<Response>,
) {
    clearAdminToken();
    configureAdminTransport((input, init) =>
        Promise.resolve(handler(input, init))
    );
    return {
        [Symbol.dispose]() {
            configureAdminTransport();
            clearAdminToken();
        },
    };
}

async function invalidResponse(operation: () => Promise<unknown>) {
    const error = await assertRejects(operation, AdminApiError);
    assertEquals(error.code, "invalid_response");
}

Deno.test("journal list preserves encoded filters, bearer authentication and cancellation", async () => {
    const abort = new AbortController();
    const cursor = "2026-09-27 请求?before=1&offset=2+/=";
    const q = "模型 中文?status=error&name=a+b";
    using _transport = respondWith((input, init) => {
        const url = new URL(String(input), "https://heimdall.example");
        assertEquals(url.pathname, "/api/admin/requests");
        assertEquals([...url.searchParams], [
            ["status", "error"],
            ["q", q],
            ["cursor", cursor],
            ["limit", "50"],
        ]);
        assertStrictEquals(init?.signal, abort.signal);
        const headers = new Headers(init?.headers);
        assertEquals(headers.get("authorization"), "Bearer operator-token");
        assertEquals(headers.get("accept"), "application/json");
        return Response.json({ requests: [row], nextCursor: "next-cursor" });
    });
    setAdminToken("operator-token");
    assertEquals(
        await loadJournalRequests({
            status: "error",
            q,
            cursor,
            limit: 50,
            signal: abort.signal,
        }),
        { requests: [row], nextCursor: "next-cursor" },
    );
});

Deno.test("journal list keeps payload bodies off summaries but carries token usage", async () => {
    using _transport = respondWith((input) => {
        assertEquals(input, "/api/admin/requests");
        return Response.json({ requests: [detail], nextCursor: null });
    });
    // Usage is aggregate token counts, not a body, so it survives the summary
    // projection while request/response/error bodies are stripped.
    const summaryRow: RequestSummaryDto = { ...row, usage: detail.usage };
    assertEquals(await loadJournalRequests(), {
        requests: [summaryRow],
        nextCursor: null,
    });
    assertEquals(await loadJournalRequests({ cursor: null }), {
        requests: [summaryRow],
        nextCursor: null,
    });
});

Deno.test("journal request detail pages keep original bodies and validated usage", async () => {
    const abort = new AbortController();
    const id = "请求?raw=a+b&next=4";
    const expected = {
        request: {
            ...detail,
            requestId: id,
            usage: { ...detail.usage!, requestId: id },
        },
        frames: [1, 3].map((seq) => ({ ...frame(seq), requestId: id })),
        nextAfterSeq: 3,
    };
    using _transport = respondWith((input, init) => {
        const url = new URL(String(input), "https://heimdall.example");
        assertEquals(url.pathname, "/api/admin/requests");
        assertEquals([...url.searchParams], [
            ["id", id],
            ["afterSeq", "0"],
            ["frameLimit", "2"],
        ]);
        assertStrictEquals(init?.signal, abort.signal);
        return Response.json(expected);
    });
    assertEquals(
        await loadJournalRequest(id, {
            afterSeq: 0,
            frameLimit: 2,
            signal: abort.signal,
        }),
        expected,
    );
});

Deno.test("journal request accepts empty terminal frames and null usage", async () => {
    const payload = {
        request: { ...detail, request: null, response: false, usage: null },
        frames: [],
        nextAfterSeq: null,
    };
    using _transport = respondWith((input) => {
        assertEquals(input, "/api/admin/requests?id=request-1");
        return Response.json(payload);
    });
    assertEquals(await loadJournalRequest(row.requestId), payload);
});

Deno.test("journal detail projects only known display fields while preserving JSON bodies", async () => {
    const payload = {
        request: {
            ...detail,
            privateState: "omit from island",
            usage: { ...detail.usage, internalMeter: "omit from island" },
        },
        frames: [{ ...frame(0), privateState: "omit from island" }],
        nextAfterSeq: null,
        internalMetadata: "omit from island",
    };
    using _transport = respondWith(() => Response.json(payload));
    assertEquals(await loadJournalRequest(row.requestId), {
        request: detail,
        frames: [frame(0)],
        nextAfterSeq: null,
    });
});

Deno.test("journal exports all frames and preserves complete JSON with server metadata", async () => {
    const abort = new AbortController();
    const payload = {
        request: {
            ...detail,
            diagnostic: { providerResponseId: "upstream-1" },
        },
        frames: Array.from({ length: 501 }, (_, index) => ({
            ...frame(index),
            diagnostic: { size: index },
        })),
        exportedAt: row.completedAt,
        schemaVersion: 2,
    };
    using _transport = respondWith((input, init) => {
        assertEquals(input, "/api/admin/requests/export?id=request-1");
        assertStrictEquals(init?.signal, abort.signal);
        return Response.json(payload);
    });
    assertEquals(
        await exportJournalRequest(row.requestId, { signal: abort.signal }),
        payload,
    );
});

Deno.test("journal adapters retain management API diagnostics and network failures", async () => {
    for (
        const operation of [
            () => loadJournalRequests(),
            () => loadJournalRequest(row.requestId),
            () => exportJournalRequest(row.requestId),
        ]
    ) {
        using _transport = respondWith(() =>
            Response.json({
                error: { code: "not_found", message: "该请求已被清理" },
            }, {
                status: 404,
                headers: { "x-heimdall-request-id": "lookup-trace" },
            })
        );
        const error = await assertRejects(operation, AdminApiError, "已被清理");
        assertEquals(error.status, 404);
        assertEquals(error.code, "not_found");
        assertEquals(error.requestId, "lookup-trace");
    }
    using _transport = respondWith(() => Promise.reject(new Error("offline")));
    const error = await assertRejects(
        loadJournalRequests,
        AdminApiError,
        "offline",
    );
    assertEquals(error.code, "network_error");
});

Deno.test("journal cancellation stays distinguishable during fetch and body decoding", async () => {
    for (const stage of ["fetch", "json"] as const) {
        const abort = new AbortController();
        const cancellation = new DOMException("已取消", "AbortError");
        using _transport = respondWith((_input, init) => {
            assertStrictEquals(init?.signal, abort.signal);
            abort.abort(cancellation);
            if (stage === "fetch") return Promise.reject(cancellation);
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.error(cancellation);
                    },
                }),
                { headers: { "content-type": "application/json" } },
            );
        });
        assertStrictEquals(
            await assertRejects(() =>
                loadJournalRequests({ signal: abort.signal })
            ),
            cancellation,
        );
    }
});

Deno.test("journal transport preserves custom abort reasons and unsignalled AbortError", async () => {
    const abort = new AbortController();
    const reason = new Error("视图已离开");
    abort.abort(reason);
    using _transport = respondWith(() => Promise.reject(reason));
    assertStrictEquals(
        await assertRejects(() =>
            loadJournalRequests({ signal: abort.signal })
        ),
        reason,
    );
    const cancellation = new DOMException("已取消", "AbortError");
    configureAdminTransport(() => Promise.reject(cancellation));
    assertStrictEquals(await assertRejects(loadJournalRequests), cancellation);
});

Deno.test("journal list rejects malformed rows and pagination instead of corrupting state", async () => {
    let payload: unknown;
    using _transport = respondWith(() => Response.json(payload));
    const invalid = [
        null,
        [],
        {},
        { requests: null, nextCursor: null },
        { requests: [row] },
        { requests: [row], nextCursor: 12 },
        { requests: [row], nextCursor: "" },
        { requests: [], nextCursor: "cursor" },
        { requests: [row], nextCursor: "current" },
        { requests: [row, row], nextCursor: null },
        ...[
            null,
            [],
            { ...row, requestId: "" },
            { ...row, status: "unknown" },
            { ...row, receivedAt: "invalid-date" },
            { ...row, receivedAt: null },
            { ...row, completedAt: 1 },
            { ...row, model: [] },
            { ...row, operation: false },
            { ...row, protocolPluginId: null },
        ].map((value) => ({ requests: [value], nextCursor: null })),
    ];
    for (const value of invalid) {
        payload = value;
        await invalidResponse(() => loadJournalRequests({ cursor: "current" }));
    }
    payload = { requests: [], nextCursor: null };
    assertEquals(await loadJournalRequests(), payload);
});

Deno.test("journal detail rejects mismatched request IDs, usage and frame pagination", async () => {
    let payload: unknown;
    const valid = { request: detail, frames: [frame(2)], nextAfterSeq: null };
    using _transport = respondWith(() => Response.json(payload));
    const { request: _requestBody, ...withoutRequestBody } = detail;
    const invalid = [
        null,
        [],
        {},
        { ...valid, request: { ...detail, requestId: "different" } },
        { ...valid, request: withoutRequestBody },
        { ...valid, frames: null },
        { ...valid, frames: [] as FrameDto[], nextAfterSeq: 2 },
        { ...valid, nextAfterSeq: undefined },
        { ...valid, nextAfterSeq: "2" },
        { ...valid, nextAfterSeq: 3 },
        { ...valid, nextAfterSeq: -1 },
        { ...valid, nextAfterSeq: 2.5 },
        { ...valid, frames: [frame(2), frame(2)] },
        { ...valid, frames: [frame(3), frame(2)] },
        ...[
            null,
            [],
            { ...frame(2), requestId: "different" },
            { ...frame(2), seq: 1 },
            { ...frame(2), seq: -1 },
            { ...frame(2), seq: 2.5 },
            { ...frame(2), seq: Number.MAX_SAFE_INTEGER + 1 },
            { ...frame(2), event: undefined },
            { ...frame(2), eventId: null },
            { ...frame(2), streamId: "" },
            { ...frame(2), version: 0 },
            { ...frame(2), timestamp: "invalid" },
            { ...frame(2), causationId: {} },
        ].map((value) => ({ ...valid, frames: [value] })),
        ...[
            [],
            { ...detail.usage, requestId: "different" },
            { ...detail.usage, updatedAt: "invalid" },
            { ...detail.usage, inputTokens: -1 },
            { ...detail.usage, outputTokens: 1.5 },
            { ...detail.usage, reasoningTokens: "2" },
            { ...detail.usage, cachedInputTokens: null },
            { ...detail.usage, cost: 1 },
            { ...detail.usage, currency: false },
        ].map((usage) => ({ ...valid, request: { ...detail, usage } })),
    ];
    for (const value of invalid) {
        payload = value;
        await invalidResponse(() =>
            loadJournalRequest(row.requestId, { afterSeq: 1 })
        );
    }
});

Deno.test("journal rejects invalid JSON and validates exports before offering a download", async () => {
    using _transport = respondWith(() =>
        new Response("{incomplete", {
            headers: { "content-type": "application/json" },
        })
    );
    await invalidResponse(loadJournalRequests);
    await invalidResponse(() => loadJournalRequest(row.requestId));
    await invalidResponse(() => exportJournalRequest(row.requestId));
    for (
        const payload of [
            { request: detail },
            { request: detail, frames: [{ ...frame(0), requestId: "other" }] },
            { request: { ...detail, request: undefined }, frames: [] },
        ]
    ) {
        configureAdminTransport(() => Promise.resolve(Response.json(payload)));
        await invalidResponse(() => exportJournalRequest(row.requestId));
    }
});
