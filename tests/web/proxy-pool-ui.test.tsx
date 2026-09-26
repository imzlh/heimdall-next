/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { render, useState } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import type { ProxyPoolView } from "@heimdall/admin-contracts/proxies.ts";
import { parsePresetUiContext } from "@heimdall/admin-contracts/preset-ui.ts";
import {
    configureAdminTransport,
    loadProxyPool,
    saveProxyPool,
} from "@heimdall/core/web/client/api/admin.ts";
import {
    mergeProxyPoolDraft,
    proxyPoolDraft,
    proxyPoolInput,
} from "@heimdall/core/web/client/proxy-pool-draft.ts";
import { ProxyPoolPanel } from "@heimdall/core/web/client/proxy-pool.tsx";
import {
    readProxyPoolView,
    sourceProxyLabel,
} from "@heimdall/core/web/shared/proxy-presentation.ts";
import { installTestDom, type TestElement } from "./helpers/jsx-dom.ts";

const pool: ProxyPoolView = {
    defaultProxyId: "office",
    entries: [{
        id: "office",
        name: "办公室",
        url: "http://127.0.0.1:7890/",
        enabled: true,
        authConfigured: true,
    }],
};

Deno.test("proxy view projection excludes credentials and rejects addresses containing secrets", () => {
    const unsafe = {
        ...pool,
        entries: [{
            ...pool.entries[0],
            basicAuth: { username: "secret-name", password: "secret-password" },
            metadata: { token: "token" },
        }],
    };
    assertEquals(readProxyPoolView(unsafe), pool);
    for (
        const url of [
            "http://user:password@example.test/",
            "http://example.test/?token=secret",
            "http://example.test/secret",
            "http://example.test/#secret",
        ]
    ) {
        assertThrows(() =>
            readProxyPoolView({
                ...pool,
                entries: [{ ...pool.entries[0], url }],
            })
        );
    }
    assertEquals(
        sourceProxyLabel({ mode: "inherit" }, pool),
        "继承全局 · 办公室",
    );
    assertEquals(
        sourceProxyLabel({ mode: "proxy", proxyId: "removed" }, pool),
        "指定代理 · removed（已移除）",
    );
});

Deno.test("proxy pool drafts preserve credentials by omission and require explicit replacement or clearing", () => {
    const draft = proxyPoolDraft(pool);
    assertEquals(proxyPoolInput(draft), {
        defaultProxyId: "office",
        entries: [{
            id: "office",
            name: "办公室",
            url: "http://127.0.0.1:7890/",
            enabled: true,
        }],
    });
    const entry = draft.entries[0]!;
    assertEquals(
        proxyPoolInput({ ...draft, entries: [{ ...entry, authMode: "clear" }] })
            .entries[0]!.basicAuth,
        null,
    );
    assertEquals(
        proxyPoolInput({
            ...draft,
            entries: [{
                ...entry,
                authMode: "replace",
                username: "new-user",
                password: "",
            }],
        }).entries[0]!.basicAuth,
        { username: "new-user", password: "" },
    );
    assertThrows(
        () =>
            proxyPoolInput({
                ...draft,
                entries: [{ ...entry, enabled: false }],
            }),
        TypeError,
        "全局默认",
    );
    assertThrows(
        () =>
            proxyPoolInput({
                ...draft,
                entries: [{ ...entry, authMode: "replace" }],
            }),
        TypeError,
        "用户名",
    );
});

Deno.test("proxy conflict merge retains edits and deletions while adopting untouched remote fields and new entries", () => {
    const removed = { ...pool.entries[0]!, id: "remove" };
    const base = { ...pool, entries: [...pool.entries, removed] };
    const draft = proxyPoolDraft(base);
    const latest = {
        ...pool,
        entries: [
            {
                ...pool.entries[0]!,
                name: "远端名称",
                url: "http://localhost:8080/",
                authConfigured: false,
            },
            removed,
            { ...removed, id: "new" },
        ],
    };
    const merged = mergeProxyPoolDraft(base, {
        defaultProxyId: null,
        entries: [{
            ...draft.entries[0]!,
            name: "本地名称",
            authMode: "replace",
            username: "u",
            password: "p",
        }],
    }, latest);
    assertEquals(merged.defaultProxyId, null);
    assertEquals(merged.entries.map((entry) => entry.id), ["office", "new"]);
    assertEquals(merged.entries[0], {
        ...draft.entries[0],
        name: "本地名称",
        url: "http://localhost:8080/",
        authConfigured: false,
        authMode: "replace",
        username: "u",
        password: "p",
    });
    const afterRemoteDeletion = mergeProxyPoolDraft(
        pool,
        proxyPoolDraft(pool),
        { defaultProxyId: null, entries: [] },
    );
    assertEquals(afterRemoteDeletion.entries, []);
});

Deno.test("proxy API uses versioned pool bodies without leaking view-only or draft fields", async () => {
    const calls: RequestInit[] = [];
    configureAdminTransport((input, init) => {
        assertEquals(input, "/api/admin/proxies");
        calls.push(init!);
        return Promise.resolve(
            Response.json({ pool }, { headers: { etag: '"pool-2"' } }),
        );
    });
    try {
        assertEquals(await loadProxyPool(), { pool, etag: '"pool-2"' });
        await saveProxyPool(pool, '"pool-1"');
        assertEquals(calls.length, 2);
        assertEquals(calls[1]!.method, "PUT");
        assertEquals(
            new Headers(calls[1]!.headers).get("if-match"),
            '"pool-1"',
        );
        assertEquals(
            JSON.parse(String(calls[1]!.body)),
            proxyPoolInput(proxyPoolDraft(pool)),
        );
    } finally {
        configureAdminTransport();
    }
});

Deno.test("preset context exposes a serializable proxy choice but rejects credentials and endpoint overrides", () => {
    const context = {
        draft: { id: "new-source", name: "新渠道", priority: 0 },
        sourcePluginId: "heimdall.source.chathub",
        presetId: "heimdall.preset.chathub",
    };
    assertEquals(
        parsePresetUiContext({
            ...context,
            proxy: { mode: "proxy", proxyId: "office" },
        }).proxy,
        { mode: "proxy", proxyId: "office" },
    );
    for (
        const proxy of [{ mode: "direct", proxyId: "office" }, {
            mode: "proxy",
            proxyId: "office",
            basicAuth: { password: "secret" },
        }, { mode: "proxy", proxyId: "office", url: "http://proxy.test" }]
    ) {
        assertThrows(() => parsePresetUiContext({ ...context, proxy }));
    }
});

function find(root: TestElement, selector: string): TestElement {
    const element = root.querySelector(selector);
    assert(element, `Missing ${selector}: ${root.textContent}`);
    return element;
}
function button(root: TestElement, label: string): TestElement {
    const element = root.querySelectorAll("button").find((item) =>
        item.textContent.includes(label) ||
        item.getAttribute("aria-label") === label
    );
    assert(element, `Missing ${label}: ${root.textContent}`);
    return element;
}

Deno.test("proxy panel retains credentials and local edits across CAS conflict and saves against the fresh version", async () => {
    const dom = installTestDom();
    const calls: RequestInit[] = [];
    const latest = {
        ...pool,
        entries: [{ ...pool.entries[0]!, url: "http://localhost:8080/" }],
    };
    configureAdminTransport((_input, init) => {
        calls.push(init!);
        if (calls.length === 1) {
            return Promise.resolve(
                Response.json({ error: { message: "conflict" } }, {
                    status: 412,
                }),
            );
        }
        return Promise.resolve(
            Response.json({ pool: latest }, { headers: { etag: '"pool-2"' } }),
        );
    });
    let unmount = () => {};
    function App() {
        const [active, setActive] = useState(true);
        unmount = () => setActive(false);
        return active
            ? <ProxyPoolPanel initial={{ pool, etag: '"pool-1"' }} />
            : null;
    }
    try {
        await dom.act(() =>
            render(<App />, dom.root as unknown as HTMLElement)
        );
        await dom.act(() => button(dom.root, "编辑 办公室").click());
        await dom.act(() => {
            const field = find(dom.root, 'input[name="proxy-name-office"]');
            field.value = "本地修改";
            field.dispatchEvent(new Event("input"));
        });
        await dom.act(() => button(dom.root, "保存代理池").click());
        assertEquals(calls.length, 1);
        assertEquals(
            JSON.parse(String(calls[0]!.body)).entries[0].basicAuth,
            undefined,
        );
        assert(button(dom.root, "保存代理池").disabled);
        assert(
            find(dom.root, '[role="alert"]').textContent.includes("草稿仍在"),
        );
        await dom.act(() => button(dom.root, "读取最新版本").click());
        assertEquals(calls.length, 2);
        assertEquals(
            find(dom.root, 'input[name="proxy-name-office"]').value,
            "本地修改",
        );
        assertEquals(
            find(dom.root, 'input[name="proxy-url-office"]').value,
            "http://localhost:8080/",
        );
        await dom.act(() => button(dom.root, "保存代理池").click());
        assertEquals(calls.length, 3);
        assertEquals(
            new Headers(calls[2]!.headers).get("if-match"),
            '"pool-2"',
        );
        assertEquals(
            JSON.parse(String(calls[2]!.body)).entries[0].name,
            "本地修改",
        );
        assertEquals(dom.storageWrites, []);
    } finally {
        await dom.act(unmount);
        configureAdminTransport();
        dom.restore();
    }
});
