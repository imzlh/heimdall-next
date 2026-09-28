import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type {
    FrameDto,
    RequestDetailDto,
    RequestSummaryDto,
} from "@heimdall/admin-contracts";
import { createJournalController } from "@heimdall/core/web/client/journal/controller.ts";
import type {
    JournalApi,
    JournalDetail,
    JournalExport,
    JournalInitial,
    JournalList,
    JournalQuery,
} from "@heimdall/core/web/client/journal/types.ts";

function summary(id = "first"): RequestSummaryDto {
    return {
        requestId: id,
        status: "completed",
        receivedAt: "2026-09-27T12:00:00Z",
        model: "test-model",
        operation: "chat",
    };
}
function detail(id = "first"): RequestDetailDto {
    return {
        ...summary(id),
        request: { messages: [{ role: "user", content: "hello" }] },
        response: { text: "world" },
    };
}
function frame(id: string, seq: number): FrameDto {
    return {
        version: 1,
        requestId: id,
        streamId: `stream-${id}`,
        seq,
        eventId: `event-${seq}`,
        timestamp: "2026-09-27T12:00:00Z",
        event: { type: "chunk", text: `piece-${seq}` },
    };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
function setup(initial?: JournalInitial) {
    const lists: {
        query: JournalQuery;
        deferred: ReturnType<typeof deferred<JournalList>>;
    }[] = [];
    const details: {
        id: string;
        options: Parameters<JournalApi["detail"]>[1];
        deferred: ReturnType<typeof deferred<JournalDetail>>;
    }[] = [];
    const exports: {
        id: string;
        options: Parameters<JournalApi["export"]>[1];
        deferred: ReturnType<typeof deferred<JournalExport>>;
    }[] = [];
    const api: JournalApi = {
        list(query) {
            const pending = deferred<JournalList>();
            lists.push({ query, deferred: pending });
            return pending.promise;
        },
        detail(id, options) {
            const pending = deferred<JournalDetail>();
            details.push({ id, options, deferred: pending });
            return pending.promise;
        },
        export(id, options) {
            const pending = deferred<JournalExport>();
            exports.push({ id, options, deferred: pending });
            return pending.promise;
        },
    };
    return {
        controller: createJournalController({ api, initial }),
        lists,
        details,
        exports,
    };
}
const initial: JournalInitial = {
    requests: [summary()],
    nextCursor: "page-2",
    error: "",
};

Deno.test("journal uses SSR list and selected detail without a duplicate startup request", () => {
    const { controller, lists, details } = setup({
        ...initial,
        selectedId: "first",
        detail: {
            request: detail(),
            frames: [frame("first", 0)],
            nextAfterSeq: null,
        },
    });
    controller.start();
    controller.start();
    assertEquals(lists.length, 0);
    assertEquals(details.length, 0);
    assertEquals(controller.getState().detail?.requestId, "first");
    assertEquals(controller.getState().frames.length, 1);
    controller.dispose();
});

Deno.test("journal filters cancel prior reads and stale results cannot replace the new filter", async () => {
    const { controller, lists } = setup(initial);
    const first = controller.filter("old-model", "error");
    const second = controller.filter("  new-model  ", "completed");
    assert(lists[0]!.query.signal!.aborted);
    assertEquals(lists[1]!.query.q, "new-model");
    assertEquals(lists[1]!.query.status, "completed");
    lists[1]!.deferred.resolve({
        requests: [summary("new")],
        nextCursor: null,
    });
    await second;
    lists[0]!.deferred.resolve({
        requests: [summary("old")],
        nextCursor: "obsolete",
    });
    await first;
    assertEquals(controller.getState().requests[0]?.requestId, "new");
    assertEquals(controller.getState().nextCursor, null);
    assertEquals(controller.getState().loading, false);
    controller.dispose();
});

Deno.test("journal pagination preserves the cursor trail, refreshes the current page and returns", async () => {
    const { controller, lists } = setup(initial);
    const next = controller.next();
    assertEquals(lists[0]!.query.cursor, "page-2");
    lists[0]!.deferred.resolve({
        requests: [summary("older")],
        nextCursor: "page-3",
    });
    await next;
    assertEquals(controller.getState().page, 2);
    assertEquals(controller.getState().canPrevious, true);
    await controller.tickAutoRefresh();
    assertEquals(lists.length, 1, "auto refresh must not reset a paged result");
    const refresh = controller.refresh();
    assertEquals(lists[1]!.query.cursor, "page-2");
    lists[1]!.deferred.resolve({
        requests: [summary("older-updated")],
        nextCursor: "page-3",
    });
    await refresh;
    assertEquals(controller.getState().page, 2);
    const back = controller.previous();
    assertEquals(lists[2]!.query.cursor, null);
    lists[2]!.deferred.resolve({
        requests: [summary()],
        nextCursor: "page-2-new",
    });
    await back;
    assertEquals(controller.getState().cursor, null);
    assertEquals(controller.getState().page, 1);
    assertEquals(controller.getState().canPrevious, false);
    controller.dispose();
});

Deno.test("journal failed next-page requests retain records and retry the failed cursor", async () => {
    const { controller, lists } = setup(initial);
    const next = controller.next();
    lists[0]!.deferred.reject(new Error("offline"));
    await next;
    assertEquals(controller.getState().requests, initial.requests);
    assertEquals(controller.getState().page, 1);
    assertStringIncludes(controller.getState().error, "offline");
    const retry = controller.retry();
    assertEquals(lists[1]!.query.cursor, "page-2");
    lists[1]!.deferred.resolve({
        requests: [summary("older")],
        nextCursor: null,
    });
    await retry;
    assertEquals(controller.getState().page, 2);
    assertEquals(controller.getState().error, "");
    controller.dispose();
});

Deno.test("journal auto refresh only runs on the visible first page and aborts when hidden", async () => {
    const { controller, lists } = setup(initial);
    controller.setVisible(false);
    await controller.tickAutoRefresh();
    controller.setVisible(true);
    controller.setAutoRefresh(false);
    await controller.tickAutoRefresh();
    assertEquals(lists.length, 0);
    controller.setAutoRefresh(true);
    const refresh = controller.tickAutoRefresh();
    assertEquals(lists.length, 1);
    await controller.tickAutoRefresh();
    assertEquals(lists.length, 1, "do not overlap interval requests");
    controller.setVisible(false);
    assert(lists[0]!.query.signal!.aborted);
    lists[0]!.deferred.resolve({
        requests: [summary("hidden-result")],
        nextCursor: null,
    });
    await refresh;
    assertEquals(controller.getState().requests, initial.requests);
    assertEquals(controller.getState().loading, false);
    controller.dispose();
});

Deno.test("journal manual refresh remains available when automatic refresh is disabled", async () => {
    const { controller, lists } = setup(initial);
    controller.setAutoRefresh(false);
    const refresh = controller.refresh();
    controller.setVisible(false);
    assertEquals(lists[0]!.query.signal!.aborted, false);
    lists[0]!.deferred.resolve({ requests: [], nextCursor: null });
    await refresh;
    assertEquals(controller.getState().requests.length, 0);
    controller.dispose();
});

Deno.test("journal selection changes and close abort stale detail reads without stale errors", async () => {
    const { controller, details } = setup(initial);
    const first = controller.select("first");
    const second = controller.select("second");
    assert(details[0]!.options.signal!.aborted);
    details[1]!.deferred.resolve({
        request: detail("second"),
        frames: [],
        nextAfterSeq: null,
    });
    await second;
    details[0]!.deferred.reject(new Error("obsolete failure"));
    await first;
    assertEquals(controller.getState().detail?.requestId, "second");
    assertEquals(controller.getState().detailError, "");
    const third = controller.select("third");
    controller.closeDetail();
    assert(details[2]!.options.signal!.aborted);
    details[2]!.deferred.resolve({
        request: detail("third"),
        frames: [],
        nextAfterSeq: null,
    });
    await third;
    assertEquals(controller.getState().selectedId, "");
    assertEquals(controller.getState().detail, null);
    controller.dispose();
});

Deno.test("journal frame pagination appends frames, retains rows on error and cancels on selection", async () => {
    const { controller, details } = setup({
        ...initial,
        selectedId: "first",
        detail: {
            request: detail(),
            frames: [frame("first", 0)],
            nextAfterSeq: 0,
        },
    });
    const more = controller.moreFrames();
    assertEquals(
        details[0]!.options.afterSeq,
        0,
        "sequence zero is a valid cursor",
    );
    details[0]!.deferred.reject(new Error("temporary"));
    await more;
    assertEquals(controller.getState().frames.length, 1);
    const retry = controller.moreFrames();
    details[1]!.deferred.resolve({
        request: detail(),
        frames: [frame("first", 1)],
        nextAfterSeq: 1,
    });
    await retry;
    assertEquals(controller.getState().frames.map((frame) => frame.seq), [
        0,
        1,
    ]);
    assertEquals(controller.getState().framesError, "");
    const last = controller.moreFrames();
    const other = controller.select("second");
    assert(details[2]!.options.signal!.aborted);
    details[2]!.deferred.resolve({
        request: detail(),
        frames: [frame("first", 2)],
        nextAfterSeq: null,
    });
    await last;
    details[3]!.deferred.resolve({
        request: detail("second"),
        frames: [],
        nextAfterSeq: null,
    });
    await other;
    assertEquals(controller.getState().frames, []);
    controller.dispose();
});

Deno.test("journal changing filters closes detail and cancels pending exports", async () => {
    const { controller, lists, exports } = setup({
        ...initial,
        selectedId: "first",
        detail: { request: detail(), frames: [], nextAfterSeq: null },
    });
    let copied = false;
    const exporting = controller.exportDetail("copy", () => {
        copied = true;
    });
    const filtering = controller.filter("new", "");
    assert(exports[0]!.options.signal!.aborted);
    assertEquals(controller.getState().selectedId, "");
    exports[0]!.deferred.resolve({
        request: detail(),
        frames: [frame("first", 0)],
    });
    await exporting;
    assertEquals(copied, false);
    lists[0]!.deferred.resolve({ requests: [], nextCursor: null });
    await filtering;
    controller.dispose();
});

Deno.test("journal copy/download obtains the complete export and exposes retryable consumer errors", async () => {
    const { controller, exports } = setup({
        ...initial,
        selectedId: "first",
        detail: {
            request: detail(),
            frames: [frame("first", 0)],
            nextAfterSeq: 0,
        },
    });
    const first = controller.exportDetail("copy", () => {
        throw new Error("clipboard denied");
    });
    exports[0]!.deferred.resolve({
        request: detail(),
        frames: [frame("first", 0), frame("first", 1)],
    });
    await first;
    assertStringIncludes(controller.getState().actionError, "clipboard denied");
    assertEquals(controller.getState().action, "");
    let output = "";
    let filename = "";
    const second = controller.exportDetail("download", (json, name) => {
        output = json;
        filename = name;
    });
    exports[1]!.deferred.resolve({
        request: detail(),
        frames: [frame("first", 0), frame("first", 1)],
    });
    await second;
    assertEquals(JSON.parse(output).frames.length, 2);
    assertEquals(filename, "heimdall-request-first.json");
    assertEquals(controller.getState().actionError, "");
    assertEquals(controller.getState().notice, "完整 JSON 已下载");
    controller.dispose();
});

Deno.test("journal disposing cancels network work and no later result notifies subscribers", async () => {
    const { controller, lists, details } = setup(initial);
    let notices = 0;
    controller.subscribe(() => notices++);
    const reading = controller.refresh();
    const selecting = controller.select("first");
    controller.dispose();
    const before = notices;
    assert(lists[0]!.query.signal!.aborted);
    assert(details[0]!.options.signal!.aborted);
    lists[0]!.deferred.resolve({ requests: [], nextCursor: null });
    details[0]!.deferred.resolve({
        request: detail(),
        frames: [],
        nextAfterSeq: null,
    });
    await Promise.all([reading, selecting]);
    assertEquals(notices, before);
});

Deno.test("journal SSR historical cursor keeps filters on refresh and can return to latest", async () => {
    const { controller, lists } = setup({
        ...initial,
        q: "provider",
        status: "error",
        cursor: "deep-link-cursor",
    });
    await controller.tickAutoRefresh();
    assertEquals(lists.length, 0);
    const first = controller.first();
    assertEquals(lists[0]!.query, {
        q: "provider",
        status: "error",
        cursor: null,
        limit: 30,
        signal: lists[0]!.query.signal,
    });
    lists[0]!.deferred.resolve({ requests: [], nextCursor: null });
    await first;
    assertEquals(controller.getState().cursor, null);
    controller.dispose();
});
