import {
    assert,
    assertEquals,
    assertFalse,
    assertStringIncludes,
} from "@std/assert";
import type { JournalSnapshot } from "@heimdall/admin-contracts/console.ts";
import { JournalSnapshotView } from "@heimdall/core/web/pages/journal.tsx";
import { loadJournalSnapshot } from "@heimdall/core/web/server/journal-snapshot.ts";

const origin = "https://console.example.test";
const token = "server-only-journal-token";
const row = {
    requestId: "request-1",
    status: "error" as const,
    receivedAt: "2026-09-28T04:00:00Z",
    completedAt: "2026-09-28T04:00:01Z",
    model: "example-model",
    operation: "chat",
};
const frame = {
    version: 1,
    streamId: "stream-1",
    requestId: row.requestId,
    seq: 0,
    eventId: "event-0",
    timestamp: row.receivedAt,
    event: { type: "error", message: "上游错误" },
};
const detail = {
    request: {
        ...row,
        request: { input: "<script>alert('request')</script>" },
        response: { output: "<img src=x onerror=alert(1)>" },
        error: { message: "upstream unavailable" },
        usage: {
            requestId: row.requestId,
            inputTokens: 12,
            outputTokens: 3,
            totalTokens: 15,
            updatedAt: row.completedAt,
        },
    },
    frames: [frame],
    nextAfterSeq: 0,
};

Deno.test("request SSR snapshot scopes management reads, preserves filters and redacts the server token", async () => {
    const requests: Request[] = [];
    const q = 'model "x" & plugin=one';
    const query = new URLSearchParams({
        view: "requests",
        q,
        status: "error",
        cursor: "cursor_opaque-1",
        id: ` ${row.requestId} `,
        afterSeq: "0",
    });
    const snapshot = await loadJournalSnapshot({
        authorized: true,
        origin,
        adminAuthToken: ` ${token} `,
        dispatch(request) {
            requests.push(request);
            return Response.json(
                new URL(request.url).searchParams.has("id")
                    ? {
                        ...detail,
                        request: {
                            ...detail.request,
                            request: {
                                [token]: { authorization: `Bearer ${token}` },
                            },
                        },
                        frames: [{ ...frame, seq: 1 }],
                        nextAfterSeq: null,
                    }
                    : { requests: [row], nextCursor: "cursor_opaque-2" },
            );
        },
    }, query);
    assertEquals(requests.length, 2);
    for (const request of requests) {
        const url = new URL(request.url);
        assertEquals(url.origin, origin);
        assertEquals(url.pathname, "/api/admin/requests");
        assertEquals(request.method, "GET");
        assertEquals(request.redirect, "manual");
        assertEquals(request.headers.get("authorization"), `Bearer ${token}`);
        assertEquals(request.headers.get("cookie"), null);
    }
    assertEquals([...new URL(requests[0]!.url).searchParams], [
        ["limit", "30"],
        ["q", q],
        ["status", "error"],
        ["cursor", "cursor_opaque-1"],
    ]);
    assertEquals([...new URL(requests[1]!.url).searchParams], [
        ["id", row.requestId],
        ["frameLimit", "50"],
        ["afterSeq", "0"],
    ]);
    assertEquals(snapshot.q, q);
    assertEquals(snapshot.status, "error");
    assertEquals(snapshot.selectedId, row.requestId);
    assertEquals(snapshot.detail?.frames[0]?.seq, 1);
    assertEquals(snapshot.error, "");
    assertEquals(snapshot.detailError, undefined);
    assertFalse(JSON.stringify(snapshot).includes(token));
});

Deno.test("request SSR renders native filters, safe details and links that keep the current query", () => {
    const snapshot: JournalSnapshot = {
        requests: [row],
        nextCursor: "older_cursor",
        error: "",
        q: 'quoted "model" & <tag>',
        status: "error",
        cursor: "current_cursor",
        selectedId: row.requestId,
        detail,
    };
    const html = (<JournalSnapshotView snapshot={snapshot} />).toString();
    assertStringIncludes(html, 'method="get" action="/admin"');
    assertStringIncludes(html, 'name="view" value="requests"');
    assertStringIncludes(html, 'name="q"');
    assertStringIncludes(html, 'name="status"');
    assertStringIncludes(html, 'name="status" value="error"');
    assertFalse(html.includes("<select"));
    assertStringIncludes(html, "请求记录");
    assertStringIncludes(html, "example-model");
    for (const title of ["用量", "请求", "响应", "错误", "元数据", "事件帧"]) {
        assertStringIncludes(html, title);
    }
    assertStringIncludes(html, "upstream unavailable");
    assertStringIncludes(html, "&lt;script&gt;");
    assertFalse(html.includes("<script>"));
    assertFalse(html.includes("<img src=x"));
    assertFalse(html.includes('name="log"'));
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((match) =>
        new URL(match[1]!.replaceAll("&amp;", "&"), origin)
    );
    const detailLink = links.find((url) =>
        url.pathname === "/admin" &&
        url.searchParams.get("id") === row.requestId &&
        !url.searchParams.has("afterSeq")
    );
    assert(detailLink);
    assertEquals(detailLink.searchParams.get("q"), snapshot.q);
    assertEquals(detailLink.searchParams.get("status"), "error");
    assertEquals(detailLink.searchParams.get("cursor"), "current_cursor");
    const completedFilter = links.find((url) =>
        url.searchParams.get("status") === "completed"
    );
    assert(completedFilter);
    assertEquals(completedFilter.searchParams.get("q"), snapshot.q);
    assertEquals(completedFilter.searchParams.get("cursor"), null);
    assertEquals(completedFilter.searchParams.get("id"), null);
    const next = links.find((url) =>
        url.searchParams.get("cursor") === "older_cursor"
    );
    assert(next);
    assertEquals(next.searchParams.get("id"), null);
    const more = links.find((url) => url.searchParams.has("afterSeq"));
    assert(more);
    assertEquals(more.searchParams.get("afterSeq"), "0");
    assertEquals(more.searchParams.get("id"), row.requestId);
    for (const url of links.filter((url) => url.pathname === "/admin")) {
        assertEquals(url.searchParams.get("view"), "requests");
        assertEquals(url.searchParams.get("log"), null);
    }
    const download = links.find((url) =>
        url.pathname === "/admin/ui/requests/export"
    );
    assert(download);
    assertEquals(download.searchParams.get("id"), row.requestId);
});

Deno.test("request SSR skips all management reads and query reflection without a console session", async () => {
    let reads = 0;
    const snapshot = await loadJournalSnapshot(
        {
            authorized: false,
            adminAuthToken: token,
            dispatch() {
                reads++;
                return Response.json({ requests: [row], nextCursor: null });
            },
        },
        new URLSearchParams({
            id: row.requestId,
            q: "private-search",
            status: "error",
        }),
    );
    assertEquals(reads, 0);
    assertEquals(snapshot, { requests: [], nextCursor: null, error: "" });
});

Deno.test("request SSR rejects invalid or ambiguous filters before reading management data", async () => {
    for (
        const query of [
            `q=${"a".repeat(201)}`,
            "q=one%00two",
            "status=failed",
            "q=one&q=two",
            "status=error&status=completed",
            "cursor=one&cursor=two",
            "cursor=%2Fbad",
            `cursor=${"a".repeat(2049)}`,
        ]
    ) {
        let reads = 0;
        const snapshot = await loadJournalSnapshot({
            authorized: true,
            dispatch() {
                reads++;
                return Response.json({ requests: [row], nextCursor: null });
            },
        }, new URLSearchParams(query));
        assertEquals(reads, 0, query);
        assertStringIncludes(snapshot.error, "筛选条件无效");
    }
    for (
        const suffix of [
            "&id=another",
            "&afterSeq=0&afterSeq=1",
            "&afterSeq=NaN",
            "&afterSeq=-2",
            "&afterSeq=1.5",
            "&afterSeq=9007199254740992",
        ]
    ) {
        const calls: URL[] = [];
        const snapshot = await loadJournalSnapshot({
            authorized: true,
            dispatch(request) {
                calls.push(new URL(request.url));
                return Response.json({ requests: [row], nextCursor: null });
            },
        }, new URLSearchParams(`id=${row.requestId}${suffix}`));
        assertEquals(calls.length, 1, suffix);
        assertFalse(calls[0]!.searchParams.has("id"));
        assertEquals(snapshot.requests.length, 1);
        assert(snapshot.detailError);
        assertEquals(snapshot.detail, undefined);
    }
});

Deno.test("request SSR preserves the successful resource when list or detail fails", async () => {
    for (const failing of ["list", "detail"]) {
        const snapshot = await loadJournalSnapshot({
            authorized: true,
            adminAuthToken: token,
            dispatch(request) {
                const isDetail = new URL(request.url).searchParams.has("id");
                if (isDetail === (failing === "detail")) {
                    return new Response(token, { status: 401 });
                }
                return Response.json(
                    isDetail ? detail : { requests: [row], nextCursor: null },
                );
            },
        }, new URLSearchParams({ id: row.requestId }));
        if (failing === "list") {
            assertEquals(snapshot.requests.length, 0);
            assertStringIncludes(snapshot.error, "401");
            assertEquals(snapshot.detail?.request.requestId, row.requestId);
        } else {
            assertEquals(snapshot.requests.length, 1);
            assertEquals(snapshot.error, "");
            assertStringIncludes(snapshot.detailError ?? "", "401");
        }
        assertFalse(JSON.stringify(snapshot).includes(token));
    }
});

Deno.test("request SSR cancels oversized responses without reading or exposing diagnostics", async () => {
    let cancelled = false;
    let pulled = false;
    const snapshot = await loadJournalSnapshot({
        authorized: true,
        dispatch: () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    pull() {
                        pulled = true;
                    },
                    cancel() {
                        cancelled = true;
                    },
                }, { highWaterMark: 0 }),
                { headers: { "content-length": "5000000" } },
            ),
    }, new URLSearchParams());
    assert(cancelled);
    assertFalse(pulled);
    assertStringIncludes(snapshot.error, "暂时无法读取");
});
