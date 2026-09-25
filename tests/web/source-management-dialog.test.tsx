/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { render, useState } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import {
    configureAdminTransport,
    type ListedSource,
} from "@heimdall/core/web/client/api/admin.ts";
import { SourceManagementDialog } from "@heimdall/core/web/client/source-management.tsx";
import { installTestDom, type TestElement } from "./helpers/jsx-dom.ts";

const source: ListedSource = {
    id: "channel / main?region=cn",
    name: "原始渠道",
    priority: 3,
    sourcePluginId: "heimdall.source.openai-compatible",
    enabled: true,
    instanceEnabled: true,
    pluginEnabled: true,
    versionstamp: '"revision-1"',
};

interface RecordedRequest {
    input: RequestInfo | URL;
    init?: RequestInit;
}

function find(root: TestElement, selector: string): TestElement {
    const element = root.querySelector(selector);
    assert(element, `Missing ${selector}: ${root.textContent}`);
    return element;
}

function button(root: TestElement, text: string): TestElement {
    const element = root.querySelectorAll("button").find((candidate) =>
        candidate.textContent.trim() === text
    );
    assert(element, `Missing button ${text}: ${root.textContent}`);
    return element;
}

function input(element: TestElement, value: string): void {
    element.value = value;
    element.dispatchEvent(new Event("input"));
}

function deferredResponse() {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((yes) => resolve = yes);
    return { promise, resolve };
}

async function setup(
    respond: (
        request: RecordedRequest,
        index: number,
    ) => Response | Promise<Response> = () => Response.json({ updated: true }),
) {
    const dom = installTestDom();
    const requests: RecordedRequest[] = [];
    const changes: { kind: "saved" | "deleted"; source: ListedSource }[] = [];
    const lifecycle: string[] = [];
    let closes = 0;
    let unmount = () => {};
    configureAdminTransport((input, init) => {
        const request = { input, init };
        requests.push(request);
        return Promise.resolve(respond(request, requests.length - 1));
    });
    function App() {
        const [active, setActive] = useState(true);
        const [open, setOpen] = useState(false);
        unmount = () => setActive(false);
        if (!active) return null;
        return (
            <>
                <button type="button" onClick={() => setOpen(true)}>
                    管理渠道
                </button>
                {open && (
                    <SourceManagementDialog
                        source={source}
                        onChanged={(kind, source) => {
                            changes.push({ kind, source });
                            lifecycle.push(kind);
                        }}
                        onClose={() => {
                            closes++;
                            lifecycle.push("closed");
                            setOpen(false);
                        }}
                    />
                )}
            </>
        );
    }
    await dom.act(() => render(<App />, dom.root as unknown as HTMLElement));
    const trigger = button(dom.root, "管理渠道");
    trigger.focus();
    await dom.act(() => trigger.click());
    const dialog = find(dom.root, "dialog");
    return {
        ...dom,
        dialog,
        trigger,
        requests,
        changes,
        lifecycle,
        get closes() {
            return closes;
        },
        async edit(field: "name" | "priority", value: string) {
            await dom.act(() =>
                input(find(dialog, `input[name="source-${field}"]`), value)
            );
        },
        async dispose() {
            try {
                await dom.act(unmount);
            } finally {
                configureAdminTransport();
                dom.restore();
            }
        },
    };
}

Deno.test("source management saves only dirty fields then closes and restores focus", async () => {
    for (const field of ["name", "priority"] as const) {
        const test = await setup();
        try {
            assert(test.dialog.open);
            assertEquals(test.dialog.showModalCalls, 1);
            assertStrictEquals(
                test.document.activeElement,
                find(test.dialog, 'input[name="source-name"]'),
            );
            await test.edit(field, field === "name" ? "  新渠道名称  " : "0");
            await test.act(() => button(test.dialog, "保存修改").click());
            const changes = field === "name"
                ? { name: "新渠道名称" }
                : { priority: 0 };
            assertEquals(test.requests.length, 1);
            const request = test.requests[0]!;
            assertEquals(
                request.input,
                `/api/admin/sources?id=${encodeURIComponent(source.id!)}`,
            );
            assertEquals(request.init?.method, "PATCH");
            assertEquals(JSON.parse(String(request.init?.body)), changes);
            assertEquals(
                new Headers(request.init?.headers).get("if-match"),
                source.versionstamp,
            );
            assertEquals(test.changes, [{
                kind: "saved",
                source: { ...source, ...changes },
            }]);
            assertEquals(test.lifecycle, ["saved", "closed"]);
            assertEquals(test.closes, 1);
            assertEquals(test.root.querySelector("dialog"), null);
            assertStrictEquals(test.document.activeElement, test.trigger);
            assertEquals(test.navigation, []);
            assertEquals(test.storageWrites, []);
        } finally {
            await test.dispose();
        }
    }
});

Deno.test("source management validates name and priority in place without losing edits", async () => {
    const test = await setup();
    try {
        const name = find(test.dialog, 'input[name="source-name"]');
        const priority = find(test.dialog, 'input[name="source-priority"]');
        await test.edit("priority", "7");
        for (const invalidName of ["   ", "名".repeat(121)]) {
            await test.edit("name", invalidName);
            await test.act(() => button(test.dialog, "保存修改").click());
            assertEquals(test.requests, []);
            assertEquals(name.getAttribute("aria-invalid"), "true");
            assertStrictEquals(test.document.activeElement, name);
            assertEquals(name.value, invalidName);
            assertEquals(priority.value, "7");
            assert(
                find(test.dialog, '[role="alert"]').textContent.includes(
                    "渠道名称",
                ),
            );
        }
        await test.edit("name", "保留的名称");
        assertEquals(name.getAttribute("aria-invalid"), "false");
        for (const invalidPriority of ["", "1.5", "9007199254740992"]) {
            await test.edit("priority", invalidPriority);
            await test.act(() => button(test.dialog, "保存修改").click());
            assertEquals(test.requests, []);
            assertEquals(priority.getAttribute("aria-invalid"), "true");
            assertStrictEquals(test.document.activeElement, priority);
            assertEquals(name.value, "保留的名称");
            assertEquals(priority.value, invalidPriority);
            assert(
                find(test.dialog, '[role="alert"]').textContent.includes(
                    "整数",
                ),
            );
        }
        await test.edit("priority", "-2");
        assertEquals(priority.getAttribute("aria-invalid"), "false");
        assertEquals(test.dialog.querySelector('[role="alert"]'), null);
        await test.act(() => button(test.dialog, "保存修改").click());
        assertEquals(test.requests.length, 1);
        assertEquals(JSON.parse(String(test.requests[0]!.init?.body)), {
            name: "保留的名称",
            priority: -2,
        });
        assertEquals(test.closes, 1);
    } finally {
        await test.dispose();
    }
});

Deno.test("source management blocks duplicate pending saves and cancel while preserving failed input", async () => {
    const pending = deferredResponse();
    const test = await setup((_request, index) =>
        index === 0 ? pending.promise : Response.json({ updated: true })
    );
    try {
        await test.edit("name", "等待保存的修改");
        const save = button(test.dialog, "保存修改");
        await test.act(() => {
            save.click();
            save.click();
            find(test.dialog, "form").dispatchEvent(
                new CustomEvent("submit", { cancelable: true, detail: {} }),
            );
        });
        assertEquals(test.requests.length, 1);
        assertEquals(test.dialog.getAttribute("aria-busy"), "true");
        assert(button(test.dialog, "保存中…").disabled);
        assert(button(test.dialog, "取消").disabled);
        assert(button(test.dialog, "关闭").disabled);
        const cancel = new Event("cancel", { cancelable: true });
        await test.act(() => test.dialog.dispatchEvent(cancel));
        assert(cancel.defaultPrevented);
        assertEquals(test.closes, 0);
        assertEquals(test.changes, []);
        assert(test.dialog.open);
        pending.resolve(Response.json({ error: { message: "暂时无法保存" } }, {
            status: 503,
            headers: { "x-heimdall-request-id": "save-retry" },
        }));
        await test.act();
        assertEquals(test.dialog.getAttribute("aria-busy"), "false");
        assertEquals(
            find(test.dialog, 'input[name="source-name"]').value,
            "等待保存的修改",
        );
        assert(
            find(test.dialog, '[role="alert"]').textContent.includes(
                "save-retry",
            ),
        );
        assert(!button(test.dialog, "保存修改").disabled);
        assertEquals(test.closes, 0);
        await test.act(() => button(test.dialog, "保存修改").click());
        assertEquals(test.requests.length, 2);
        assertEquals(test.closes, 1);
    } finally {
        pending.resolve(Response.json({ updated: true }));
        await test.dispose();
    }
});

Deno.test("source conflict reload keeps local edits, adopts unchanged server fields and retries the latest revision", async () => {
    for (const field of ["name", "priority"] as const) {
        const latest = {
            ...source,
            name: "服务器新名称",
            priority: 29,
            versionstamp: '"revision-2"',
        };
        const test = await setup((_request, index) => {
            if (index === 0) {
                return Response.json({
                    error: { code: "version_conflict", message: "conflict" },
                }, {
                    status: 409,
                    headers: { "x-heimdall-request-id": "metadata-conflict" },
                });
            }
            if (index === 1) {
                return Response.json({
                    sources: [{ ...source, id: "unrelated" }, latest],
                });
            }
            return Response.json({ updated: true });
        });
        try {
            await test.edit(field, field === "name" ? "本地新名称" : "11");
            await test.act(() => button(test.dialog, "保存修改").click());
            assertEquals(test.requests.length, 1);
            assertEquals(test.closes, 0);
            assertEquals(test.changes, []);
            assert(
                find(test.dialog, '[role="alert"]').textContent.includes(
                    "metadata-conflict",
                ),
            );
            assert(button(test.dialog, "保存修改").disabled);
            assert(button(test.dialog, "删除渠道…").disabled);
            assertEquals(
                find(test.dialog, `input[name="source-${field}"]`).value,
                field === "name" ? "本地新名称" : "11",
            );
            await test.act(() => {
                button(test.dialog, "保存修改").click();
                find(test.dialog, "form").dispatchEvent(
                    new CustomEvent("submit", { cancelable: true, detail: {} }),
                );
            });
            assertEquals(test.requests.length, 1);
            await test.act(() => button(test.dialog, "读取最新信息").click());
            assertEquals(test.requests.length, 2);
            assertEquals(test.requests[1]!.input, "/api/admin/sources");
            assertEquals(test.requests[1]!.init?.method ?? "GET", "GET");
            assertEquals(
                find(test.dialog, 'input[name="source-name"]').value,
                field === "name" ? "本地新名称" : latest.name,
            );
            assertEquals(
                find(test.dialog, 'input[name="source-priority"]').value,
                field === "priority" ? "11" : "29",
            );
            assertEquals(test.dialog.querySelector('[role="alert"]'), null);
            assert(
                find(test.dialog, '[role="status"]').textContent.includes(
                    "保留你的修改",
                ),
            );
            assert(!button(test.dialog, "保存修改").disabled);
            await test.act(() => button(test.dialog, "保存修改").click());
            assertEquals(test.requests.length, 3);
            const retry = test.requests[2]!;
            const changes = field === "name"
                ? { name: "本地新名称" }
                : { priority: 11 };
            assertEquals(retry.init?.method, "PATCH");
            assertEquals(
                new Headers(retry.init?.headers).get("if-match"),
                latest.versionstamp,
            );
            assertEquals(JSON.parse(String(retry.init?.body)), changes);
            assertEquals(test.changes, [{
                kind: "saved",
                source: { ...latest, ...changes },
            }]);
            assertEquals(test.closes, 1);
        } finally {
            await test.dispose();
        }
    }
});

Deno.test("source conflict remains locked after a failed reload until the latest revision is read", async () => {
    const latest = {
        ...source,
        priority: 12,
        versionstamp: '"revision-3"',
    };
    const test = await setup((_request, index) => {
        if (index === 0) {
            return Response.json({ error: { message: "渠道版本已更新" } }, {
                status: 409,
            });
        }
        if (index === 1) {
            return Response.json({ error: { message: "暂时无法读取渠道" } }, {
                status: 503,
                headers: { "x-heimdall-request-id": "reload-unavailable" },
            });
        }
        if (index === 2) return Response.json({ sources: [latest] });
        return Response.json({ updated: true });
    });
    try {
        await test.edit("name", "等待合并的本地名称");
        await test.act(() => button(test.dialog, "保存修改").click());
        assertEquals(test.requests.length, 1);
        assert(button(test.dialog, "保存修改").disabled);
        await test.act(() => button(test.dialog, "读取最新信息").click());
        assertEquals(test.requests.length, 2);
        assertEquals(test.requests[1]!.input, "/api/admin/sources");
        assertEquals(test.requests[1]!.init?.method ?? "GET", "GET");
        assertEquals(
            find(test.dialog, 'input[name="source-name"]').value,
            "等待合并的本地名称",
        );
        assert(
            find(test.dialog, '[role="alert"]').textContent.includes(
                "reload-unavailable",
            ),
        );
        assert(button(test.dialog, "保存修改").disabled);
        assert(button(test.dialog, "删除渠道…").disabled);
        assert(!button(test.dialog, "读取最新信息").disabled);
        await test.act(() => {
            button(test.dialog, "保存修改").click();
            find(test.dialog, "form").dispatchEvent(
                new CustomEvent("submit", { cancelable: true, detail: {} }),
            );
        });
        assertEquals(test.requests.length, 2);
        assertEquals(test.closes, 0);
        assertEquals(test.changes, []);
        await test.act(() => button(test.dialog, "读取最新信息").click());
        assertEquals(test.requests.length, 3);
        assertEquals(test.requests[2]!.input, "/api/admin/sources");
        assertEquals(test.requests[2]!.init?.method ?? "GET", "GET");
        assertEquals(
            find(test.dialog, 'input[name="source-name"]').value,
            "等待合并的本地名称",
        );
        assertEquals(
            find(test.dialog, 'input[name="source-priority"]').value,
            "12",
        );
        assert(!button(test.dialog, "保存修改").disabled);
        assert(!button(test.dialog, "删除渠道…").disabled);
        await test.act(() => button(test.dialog, "保存修改").click());
        assertEquals(test.requests.length, 4);
        const retry = test.requests[3]!;
        assertEquals(retry.init?.method, "PATCH");
        assertEquals(
            new Headers(retry.init?.headers).get("if-match"),
            latest.versionstamp,
        );
        assertEquals(JSON.parse(String(retry.init?.body)), {
            name: "等待合并的本地名称",
        });
        assertEquals(test.changes, [{
            kind: "saved",
            source: { ...latest, name: "等待合并的本地名称" },
        }]);
        assertEquals(test.closes, 1);
    } finally {
        await test.dispose();
    }
});

Deno.test("source deletion requires confirmation, preserves edits on return and uses the original revision", async () => {
    const pending = deferredResponse();
    const test = await setup(() => pending.promise);
    try {
        await test.edit("name", "尚未保存的名称");
        await test.edit("priority", "-4");
        await test.act(() => button(test.dialog, "删除渠道…").click());
        assertEquals(test.requests, []);
        assertEquals(test.changes, []);
        assertStrictEquals(
            test.document.activeElement,
            button(test.dialog, "返回编辑"),
        );
        await test.act(() => button(test.dialog, "返回编辑").click());
        assertEquals(
            find(test.dialog, 'input[name="source-name"]').value,
            "尚未保存的名称",
        );
        assertEquals(
            find(test.dialog, 'input[name="source-priority"]').value,
            "-4",
        );
        assertEquals(test.requests, []);
        await test.act(() => button(test.dialog, "删除渠道…").click());
        assertEquals(test.requests, []);
        await test.act(() => button(test.dialog, "确认删除").click());
        assertEquals(test.requests.length, 1);
        const request = test.requests[0]!;
        assertEquals(
            request.input,
            `/api/admin/sources?id=${encodeURIComponent(source.id!)}`,
        );
        assertEquals(request.init?.method, "DELETE");
        assertEquals(request.init?.body, undefined);
        assertEquals(
            new Headers(request.init?.headers).get("if-match"),
            source.versionstamp,
        );
        assert(button(test.dialog, "删除中…").disabled);
        assert(button(test.dialog, "返回编辑").disabled);
        await test.act(() => {
            button(test.dialog, "删除中…").click();
            test.dialog.dispatchEvent(
                new Event("cancel", { cancelable: true }),
            );
        });
        assertEquals(test.requests.length, 1);
        assertEquals(test.closes, 0);
        pending.resolve(Response.json({ deleted: true }));
        await test.act();
        assertEquals(test.changes, [{ kind: "deleted", source }]);
        assertEquals(test.lifecycle, ["deleted", "closed"]);
        assertEquals(test.closes, 1);
        assertEquals(test.root.querySelector("dialog"), null);
        assertStrictEquals(test.document.activeElement, test.trigger);
        assertEquals(test.navigation, []);
        assertEquals(test.storageWrites, []);
    } finally {
        pending.resolve(Response.json({ deleted: true }));
        await test.dispose();
    }
});
