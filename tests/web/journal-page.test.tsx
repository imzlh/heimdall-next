/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { render, useState } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import type { RequestSummaryDto } from "@heimdall/admin-contracts";
import { configureAdminTransport } from "@heimdall/core/web/client/api/transport.ts";
import { RequestJournalPage } from "@heimdall/core/web/client/journal/page.tsx";
import type { JournalInitial } from "@heimdall/core/web/client/journal/types.ts";
import { installTestDom, type TestElement } from "./helpers/jsx-dom.ts";

const row: RequestSummaryDto = {
    requestId: "request-1",
    status: "completed",
    receivedAt: "2026-09-27T12:00:00Z",
    completedAt: "2026-09-27T12:00:01Z",
    model: "test-model",
    operation: "chat",
};
const initial: JournalInitial = {
    requests: [row],
    nextCursor: "cursor-next",
    error: "",
};

function button(root: TestElement, text: string): TestElement {
    const element = root.querySelectorAll("button").find((element) =>
        element.textContent.trim() === text
    );
    assert(element, `Missing ${text}: ${root.textContent}`);
    return element;
}
function find(root: TestElement, selector: string) {
    const element = root.querySelector(selector);
    assert(element, `Missing ${selector}`);
    return element;
}
function clickLink(element: TestElement) {
    const event = new Event("click", { cancelable: true });
    Object.defineProperty(event, "button", { value: 0 });
    element.dispatchEvent(event);
}
function pendingResponse() {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}
async function setup(
    respond: (
        url: URL,
        init: RequestInit | undefined,
    ) => Response | Promise<Response>,
    snapshot: JournalInitial = initial,
) {
    const dom = installTestDom();
    const events = new EventTarget();
    Object.defineProperties(dom.document, {
        addEventListener: { value: events.addEventListener.bind(events) },
        removeEventListener: { value: events.removeEventListener.bind(events) },
        visibilityState: { configurable: true, value: "visible" },
    });
    const requests: { url: URL; init?: RequestInit }[] = [];
    configureAdminTransport((input, init) => {
        const url = new URL(String(input), "http://localhost");
        requests.push({ url, init });
        return Promise.resolve(respond(url, init));
    });
    let unmount = () => {};
    function App() {
        const [active, setActive] = useState(true);
        unmount = () => setActive(false);
        return active
            ? <RequestJournalPage revision={0} initial={snapshot} />
            : null;
    }
    await dom.act(() => render(<App />, dom.root as unknown as HTMLElement));
    return {
        ...dom,
        requests,
        async cleanup() {
            await dom.act(unmount);
            configureAdminTransport();
            dom.restore();
        },
    };
}

Deno.test("journal page begins with SSR data, exposes native filters and preserves pagination controls", async () => {
    const test = await setup((url) =>
        Response.json({
            requests: [{
                ...row,
                requestId: url.searchParams.has("cursor")
                    ? "request-older"
                    : "request-filtered",
            }],
            nextCursor: null,
        })
    );
    try {
        assertEquals(test.requests.length, 0);
        assertStringIncludes(test.root.textContent, "test-model");
        assert(button(test.root, "上一页").disabled);
        const search = find(test.root, 'input[name="q"]');
        await test.act(() => {
            search.value = "provider";
            search.dispatchEvent(new Event("input"));
        });
        await test.act(() => button(test.root, "搜索").click());
        await test.act();
        assertEquals(test.requests[0]!.url.searchParams.get("q"), "provider");
        assertStringIncludes(test.root.textContent, "request-filtered");
        assert(button(test.root, "下一页").disabled);
        await test.act(() => button(test.root, "清除筛选").click());
        await test.act();
        assertEquals(test.requests[1]!.url.searchParams.get("q"), null);
        assertEquals(find(test.root, 'input[name="q"]').value, "");
    } finally {
        await test.cleanup();
    }
});

Deno.test("journal drawer shows all payload sections, loads frames, and restores trigger focus on Escape", async () => {
    const test = await setup((url) => {
        const more = url.searchParams.has("afterSeq");
        return Response.json({
            request: {
                ...row,
                request: { input: "hello" },
                response: { output: "world" },
                usage: {
                    requestId: row.requestId,
                    updatedAt: row.receivedAt,
                    inputTokens: 12,
                    outputTokens: 4,
                    totalTokens: 16,
                },
            },
            frames: [{
                version: 1,
                streamId: "s",
                requestId: row.requestId,
                seq: more ? 1 : 0,
                eventId: more ? "e1" : "e0",
                timestamp: row.receivedAt,
                event: { type: more ? "done" : "chunk" },
            }],
            nextAfterSeq: more ? null : 0,
        });
    });
    try {
        const trigger = find(test.root, 'a[aria-label="查看请求 request-1"]');
        await test.act(() => {
            trigger.focus();
            clickLink(trigger);
        });
        await test.act();
        const dialog = find(test.root, "dialog");
        assertEquals(dialog.showModalCalls, 1);
        assertEquals(dialog.open, true);
        assertEquals(
            test.document.activeElement,
            find(test.root, 'button[aria-label="关闭请求详情"]'),
        );
        assertStringIncludes(dialog.textContent, "请求 · Request");
        assertStringIncludes(dialog.textContent, "响应 · Response");
        assertStringIncludes(dialog.textContent, "错误 · Error");
        assertStringIncludes(dialog.textContent, "用量 · Usage");
        assertStringIncludes(dialog.textContent, "hello");
        await test.act(() => button(test.root, "加载后续事件帧").click());
        await test.act();
        assertEquals(test.requests[1]!.url.searchParams.get("afterSeq"), "0");
        assertStringIncludes(dialog.textContent, "2 条已加载");
        assertStringIncludes(dialog.textContent, "已加载当前全部事件帧");
        await test.act(() =>
            dialog.dispatchEvent(new Event("cancel", { cancelable: true }))
        );
        assertEquals(test.root.querySelector("dialog"), null);
        assertEquals(dialog.closeCalls, 1);
        assertEquals(test.document.activeElement, trigger);
    } finally {
        await test.cleanup();
    }
});

Deno.test("journal drawer can close during loading, aborts the read and does not reopen on late response", async () => {
    const pending = pendingResponse();
    const test = await setup(() => pending.promise);
    try {
        await test.act(() =>
            clickLink(find(test.root, 'a[aria-label="查看请求 request-1"]'))
        );
        assertStringIncludes(test.root.textContent, "正在读取请求详情");
        const close = find(test.root, 'button[aria-label="关闭请求详情"]');
        assertEquals(close.disabled, false);
        await test.act(() => close.click());
        assert(test.requests[0]!.init?.signal?.aborted);
        pending.resolve(
            Response.json({
                request: { ...row, request: {} },
                frames: [],
                nextAfterSeq: null,
            }),
        );
        await test.act();
        assertEquals(test.root.querySelector("dialog"), null);
    } finally {
        await test.cleanup();
    }
});

Deno.test("journal list error retains SSR records and offers retry, status filters use the stable DTO values", async () => {
    let failing = true;
    const test = await setup(() =>
        failing
            ? Response.json({
                error: { message: "暂时不可用", code: "unavailable" },
            }, { status: 503 })
            : Response.json({ requests: [], nextCursor: null })
    );
    try {
        await test.act(() => button(test.root, "刷新").click());
        await test.act();
        assertStringIncludes(test.root.textContent, "暂时不可用");
        assertStringIncludes(test.root.textContent, "request-1");
        failing = false;
        await test.act(() => button(test.root, "重试").click());
        await test.act();
        assertStringIncludes(test.root.textContent, "暂无请求记录");
        await test.act(() => {
            const select = find(test.root, 'select[aria-label="请求状态"]');
            select.value = "error";
            select.dispatchEvent(new Event("input"));
        });
        await test.act();
        assertEquals(
            test.requests.at(-1)!.url.searchParams.get("status"),
            "error",
        );
        assertStringIncludes(test.root.textContent, "没有匹配的请求");
    } finally {
        await test.cleanup();
    }
});

Deno.test("journal SSR-selected details hydrate without a second read and expose a clear error retry", async () => {
    const test = await setup(
        () =>
            Response.json({
                request: { ...row, request: {} },
                frames: [],
                nextAfterSeq: null,
            }),
        { ...initial, selectedId: row.requestId, detailError: "详情暂不可用" },
    );
    try {
        assertEquals(test.requests.length, 0);
        assertStringIncludes(test.root.textContent, "详情暂不可用");
        await test.act(() => button(test.root, "重试详情").click());
        await test.act();
        assertEquals(test.requests.length, 1);
        assertStringIncludes(test.root.textContent, "请求 · Request");
        assertEquals(button(test.root, "下载完整 JSON").disabled, false);
    } finally {
        await test.cleanup();
    }
});
