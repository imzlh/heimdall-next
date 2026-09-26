/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import { assert, assertEquals } from "@std/assert";
import { render, useState } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import type {
    ProxyPoolInput,
    ProxyPoolView,
} from "@heimdall/admin-contracts/proxies.ts";
import { configureAdminTransport } from "@heimdall/core/web/client/api/admin.ts";
import { ProxyPoolPanel } from "@heimdall/core/web/client/proxy-pool.tsx";
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

function find(root: TestElement, selector: string): TestElement {
    const element = root.querySelector(selector);
    assert(element, `Missing ${selector}: ${root.textContent}`);
    return element;
}

function button(root: TestElement, label: string): TestElement {
    const element = root.querySelectorAll("button").find((item) =>
        item.textContent.trim() === label ||
        item.getAttribute("aria-label") === label
    );
    assert(element, `Missing button ${label}: ${root.textContent}`);
    return element;
}

function projectedPool(
    input: ProxyPoolInput,
    previous: ProxyPoolView,
): ProxyPoolView {
    return {
        defaultProxyId: input.defaultProxyId,
        entries: input.entries.map((entry) => ({
            id: entry.id,
            name: entry.name,
            url: entry.url,
            enabled: entry.enabled,
            authConfigured: entry.basicAuth === undefined
                ? previous.entries.find((item) => item.id === entry.id)
                    ?.authConfigured ?? false
                : entry.basicAuth !== null,
        })),
    };
}

async function setup(
    initial: ProxyPoolView,
    respond?: (request: RequestInit, index: number) => Response,
) {
    const dom = installTestDom();
    const requests: RequestInit[] = [];
    const changes: ProxyPoolView[] = [];
    let current = initial;
    let unmount = () => {};
    configureAdminTransport((input, init = {}) => {
        assertEquals(input, "/api/admin/proxies");
        requests.push(init);
        if (respond) return Promise.resolve(respond(init, requests.length - 1));
        if (init.method === "PUT") {
            current = projectedPool(JSON.parse(String(init.body)), current);
        }
        return Promise.resolve(Response.json({ pool: current }, {
            headers: { etag: `"pool-${requests.length + 1}"` },
        }));
    });
    function App() {
        const [active, setActive] = useState(true);
        unmount = () => setActive(false);
        return active
            ? (
                <ProxyPoolPanel
                    initial={{ pool: initial, etag: '"pool-1"' }}
                    onChanged={(value) => changes.push(value)}
                />
            )
            : null;
    }
    await dom.act(() => render(<App />, dom.root as unknown as HTMLElement));
    return {
        ...dom,
        requests,
        changes,
        async edit(name: string, value: string) {
            await dom.act(() => {
                const field = find(dom.root, `[name="${name}"]`);
                field.value = value;
                // hono/jsx/dom maps select onChange to input as well.
                field.dispatchEvent(new Event("input"));
            });
        },
        async click(label: string) {
            await dom.act(() => button(dom.root, label).click());
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

Deno.test("proxy controls add and edit entries, send replacement credentials only by PUT and clear saved credential drafts", async () => {
    const test = await setup({ defaultProxyId: null, entries: [] });
    try {
        await test.click("添加代理");
        const entry = find(test.root, "[data-proxy-id]");
        const id = entry.getAttribute("data-proxy-id")!;
        assert(id);
        await test.edit(`proxy-name-${id}`, "  新出口  ");
        await test.edit(`proxy-url-${id}`, "http://localhost:8080");
        await test.edit(`proxy-auth-${id}`, "replace");
        await test.edit(`proxy-user-${id}`, "private-new-user");
        await test.edit(`proxy-password-${id}`, "private-new-password");
        assertEquals(
            find(test.root, `[name="proxy-password-${id}"]`).getAttribute(
                "type",
            ),
            "password",
        );
        assertEquals(test.requests, []);
        assertEquals(test.changes, []);
        assertEquals(test.storageWrites, []);
        assertEquals(test.navigation, []);
        await test.edit("proxy-default", id);
        await test.click("保存代理池");
        assertEquals(test.requests.length, 1);
        assertEquals(test.requests[0]!.method, "PUT");
        assertEquals(
            new Headers(test.requests[0]!.headers).get("if-match"),
            '"pool-1"',
        );
        assertEquals(JSON.parse(String(test.requests[0]!.body)), {
            defaultProxyId: id,
            entries: [{
                id,
                name: "新出口",
                url: "http://localhost:8080/",
                enabled: true,
                basicAuth: {
                    username: "private-new-user",
                    password: "private-new-password",
                },
            }],
        });
        assertEquals(
            find(test.root, `[name="proxy-auth-${id}"]`).value,
            "keep",
        );
        assertEquals(
            test.root.querySelector(`[name="proxy-user-${id}"]`),
            null,
        );
        assertEquals(
            test.root.querySelector(`[name="proxy-password-${id}"]`),
            null,
        );
        assert(button(test.root, "保存代理池").disabled);
        assert(!JSON.stringify(test.changes).includes("private-new"));
        await test.edit(`proxy-auth-${id}`, "replace");
        assertEquals(find(test.root, `[name="proxy-user-${id}"]`).value, "");
        assertEquals(
            find(test.root, `[name="proxy-password-${id}"]`).value,
            "",
        );
        await test.edit(`proxy-auth-${id}`, "keep");
        await test.edit(`proxy-name-${id}`, "更名后的出口");
        await test.edit(`proxy-url-${id}`, "https://proxy.example:8443");
        await test.click("保存代理池");
        assertEquals(test.requests.length, 2);
        assertEquals(test.requests[1]!.method, "PUT");
        assertEquals(JSON.parse(String(test.requests[1]!.body)), {
            defaultProxyId: id,
            entries: [{
                id,
                name: "更名后的出口",
                url: "https://proxy.example:8443/",
                enabled: true,
            }],
        });
        assert(!JSON.stringify(test.requests[1]).includes("private-new"));
        assertEquals(test.storageWrites, []);
        assertEquals(test.navigation, []);
    } finally {
        await test.dispose();
    }
});

Deno.test("proxy controls turn a disabled or removed default into direct access and require removal confirmation", async () => {
    const test = await setup(pool);
    try {
        await test.click("已启用");
        assertEquals(find(test.root, '[name="proxy-default"]').value, "");
        assertEquals(
            button(test.root, "已停用").getAttribute("aria-pressed"),
            "false",
        );
        assert(find(test.root, 'option[value="office"]').disabled);
        assertEquals(test.requests, []);
        await test.click("保存代理池");
        assertEquals(JSON.parse(String(test.requests[0]!.body)), {
            defaultProxyId: null,
            entries: [{
                id: "office",
                name: "办公室",
                url: "http://127.0.0.1:7890/",
                enabled: false,
            }],
        });
        await test.click("已停用");
        assertEquals(find(test.root, '[name="proxy-default"]').value, "");
        await test.edit("proxy-default", "office");
        await test.click("保存代理池");
        assertEquals(
            JSON.parse(String(test.requests[1]!.body)).defaultProxyId,
            "office",
        );
        await test.click("编辑 办公室");
        await test.click("移除代理");
        assert(find(test.root, '[data-proxy-id="office"]'));
        assertEquals(test.requests.length, 2);
        await test.click("保留代理");
        assert(find(test.root, '[data-proxy-id="office"]'));
        assertEquals(find(test.root, '[name="proxy-default"]').value, "office");
        assert(button(test.root, "保存代理池").disabled);
        await test.click("移除代理");
        await test.click("确认移除");
        assertEquals(test.root.querySelector('[data-proxy-id="office"]'), null);
        assertEquals(find(test.root, '[name="proxy-default"]').value, "");
        assertEquals(test.requests.length, 2);
        assert(!button(test.root, "保存代理池").disabled);
        await test.click("保存代理池");
        assertEquals(test.requests.length, 3);
        assertEquals(JSON.parse(String(test.requests[2]!.body)), {
            defaultProxyId: null,
            entries: [],
        });
        assertEquals(test.changes.at(-1), {
            defaultProxyId: null,
            entries: [],
        });
    } finally {
        await test.dispose();
    }
});

Deno.test("proxy controls preserve explicitly replaced credentials across CAS reload and clear them after the fresh-version save", async () => {
    const latest: ProxyPoolView = {
        defaultProxyId: null,
        entries: [{
            ...pool.entries[0]!,
            name: "远端名称",
            url: "http://remote-proxy.example:8080/",
            authConfigured: false,
        }],
    };
    const test = await setup(pool, (request, index) => {
        if (index === 0) {
            return Response.json({ error: { message: "conflict" } }, {
                status: 412,
            });
        }
        return Response.json({
            pool: index === 1
                ? latest
                : projectedPool(JSON.parse(String(request.body)), latest),
        }, {
            headers: { etag: index === 1 ? '"pool-latest"' : '"pool-saved"' },
        });
    });
    try {
        await test.click("编辑 办公室");
        await test.edit("proxy-name-office", "本地名称");
        await test.edit("proxy-auth-office", "replace");
        await test.edit("proxy-user-office", "private-cas-user");
        await test.edit("proxy-password-office", "private-cas-password");
        await test.click("保存代理池");
        assertEquals(test.requests.length, 1);
        assert(button(test.root, "保存代理池").disabled);
        assert(find(test.root, "fieldset").disabled);
        assertEquals(
            find(test.root, '[name="proxy-user-office"]').value,
            "private-cas-user",
        );
        assertEquals(
            find(test.root, '[name="proxy-password-office"]').value,
            "private-cas-password",
        );
        await test.click("读取最新版本，保留草稿");
        assertEquals(test.requests.length, 2);
        assertEquals(test.requests[1]!.method ?? "GET", "GET");
        assertEquals(test.requests[1]!.body, undefined);
        assert(!JSON.stringify(test.requests[1]).includes("private-cas"));
        assertEquals(
            find(test.root, '[name="proxy-name-office"]').value,
            "本地名称",
        );
        assertEquals(
            find(test.root, '[name="proxy-url-office"]').value,
            latest.entries[0]!.url,
        );
        assertEquals(
            find(test.root, '[name="proxy-auth-office"]').value,
            "replace",
        );
        assertEquals(
            find(test.root, '[name="proxy-user-office"]').value,
            "private-cas-user",
        );
        assertEquals(
            find(test.root, '[name="proxy-password-office"]').value,
            "private-cas-password",
        );
        assertEquals(find(test.root, '[name="proxy-default"]').value, "");
        assert(!find(test.root, "fieldset").disabled);
        await test.click("保存代理池");
        assertEquals(test.requests.length, 3);
        assertEquals(
            new Headers(test.requests[2]!.headers).get("if-match"),
            '"pool-latest"',
        );
        assertEquals(JSON.parse(String(test.requests[2]!.body)), {
            defaultProxyId: null,
            entries: [{
                id: "office",
                name: "本地名称",
                url: latest.entries[0]!.url,
                enabled: true,
                basicAuth: {
                    username: "private-cas-user",
                    password: "private-cas-password",
                },
            }],
        });
        assertEquals(
            find(test.root, '[name="proxy-auth-office"]').value,
            "keep",
        );
        assertEquals(
            test.root.querySelector('[name="proxy-user-office"]'),
            null,
        );
        assertEquals(
            test.root.querySelector('[name="proxy-password-office"]'),
            null,
        );
        assert(!JSON.stringify(test.changes).includes("private-cas"));
        assertEquals(test.storageWrites, []);
        assertEquals(test.navigation, []);
    } finally {
        await test.dispose();
    }
});
