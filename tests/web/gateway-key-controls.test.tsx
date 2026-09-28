/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import {
    assert,
    assertEquals,
    assertMatch,
    assertNotEquals,
    assertStringIncludes,
    assertThrows,
} from "@std/assert";
import { render, useState } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import {
    configureAdminTransport,
    loadRuntimeSettings,
    type RuntimeSettingsEnvelope,
    saveRuntimeSettings,
} from "@heimdall/core/web/client/api/admin.ts";
import { RuntimeSettingsPanel } from "@heimdall/core/web/client/settings.tsx";
import {
    GATEWAY_KEY_REVEAL_MS,
    gatewayKeyPatch,
    generateGatewayKey,
} from "@heimdall/core/web/client/gateway-key-draft.ts";
import { installTestDom, type TestElement } from "./helpers/jsx-dom.ts";

const initial: RuntimeSettingsEnvelope = {
    settings: {
        proxyKeyConfigured: true,
        limitPerMinute: 120,
        probeIntervalMs: 300_000,
        titleModel: "",
    },
    etag: '"settings-1"',
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

async function setup(options: {
    respond?: (init: RequestInit) => Response | Promise<Response>;
    copy?: (value: string) => Promise<void>;
} = {}) {
    const dom = installTestDom();
    const navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = new Map<number, () => void>();
    let timerId = 0;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
        const [handler, delay, ...parameters] = args;
        if (delay !== GATEWAY_KEY_REVEAL_MS) return originalSetTimeout(...args);
        const id = --timerId;
        timers.set(id, () => {
            if (typeof handler === "function") handler(...parameters);
        });
        return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id?: number) => {
        if (id !== undefined && timers.delete(id)) return;
        originalClearTimeout(id);
    }) as typeof clearTimeout;
    const copied: string[] = [];
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            clipboard: {
                writeText: options.copy ?? ((value: string) => {
                    copied.push(value);
                    return Promise.resolve();
                }),
            },
        },
    });
    const requests: RequestInit[] = [];
    let settings = initial.settings;
    let unmount = () => {};
    configureAdminTransport((input, init = {}) => {
        assertEquals(input, "/api/admin/settings");
        requests.push(init);
        if (options.respond) return Promise.resolve(options.respond(init));
        if (init.method === "PUT") {
            const patch = JSON.parse(String(init.body));
            settings = {
                ...settings,
                limitPerMinute: patch.limitPerMinute ?? settings.limitPerMinute,
                probeIntervalMs: patch.probeIntervalMs ??
                    settings.probeIntervalMs,
                titleModel: patch.titleModel ?? settings.titleModel,
                proxyKeyConfigured: patch.proxyKey === undefined
                    ? settings.proxyKeyConfigured
                    : Boolean(patch.proxyKey),
            };
        }
        return Promise.resolve(Response.json({ settings }, {
            headers: { etag: `"settings-${requests.length + 1}"` },
        }));
    });
    function App() {
        const [active, setActive] = useState(true);
        unmount = () => setActive(false);
        return active ? <RuntimeSettingsPanel initial={initial} /> : null;
    }
    await dom.act(() => render(<App />, dom.root as unknown as HTMLElement));
    return {
        ...dom,
        requests,
        copied,
        timers,
        key: () => find(dom.root, '[name="gateway-key-draft"]'),
        async edit(value: string) {
            await dom.act(() => {
                const key = find(dom.root, '[name="gateway-key-draft"]');
                key.value = value;
                key.dispatchEvent(new Event("input"));
            });
        },
        async click(label: string) {
            await dom.act(() => button(dom.root, label).click());
        },
        async expire() {
            await dom.act(() => {
                const pending = [...timers.values()];
                timers.clear();
                for (const fire of pending) fire();
            });
        },
        async dispose() {
            try {
                await dom.act(unmount);
                assertEquals(timers.size, 0);
            } finally {
                globalThis.setTimeout = originalSetTimeout;
                globalThis.clearTimeout = originalClearTimeout;
                if (navigator) {
                    Object.defineProperty(globalThis, "navigator", navigator);
                } else Reflect.deleteProperty(globalThis, "navigator");
                configureAdminTransport();
                dom.restore();
            }
        },
    };
}

Deno.test("gateway key generation uses 32 cryptographic bytes and never falls back to predictable randomness", () => {
    let byteCount = 0;
    const key = generateGatewayKey({
        getRandomValues<T extends ArrayBufferView | null>(array: T): T {
            assert(array instanceof Uint8Array);
            byteCount = array.byteLength;
            array.fill(255);
            return array;
        },
    });
    assertEquals(byteCount, 32);
    assertEquals(key, "hd_" + "ff".repeat(32));
    assertNotEquals(generateGatewayKey(), generateGatewayKey());
    assertThrows(() => generateGatewayKey({} as Crypto));
    assertEquals(gatewayKeyPatch(" \n ", false), {});
    assertEquals(gatewayKeyPatch(" replacement ", false), {
        proxyKey: "replacement",
    });
    assertEquals(gatewayKeyPatch("", true), { proxyKey: "" });
});

Deno.test("gateway settings generate, copy and save a new key without persisting a browser draft or returning a readable saved key", async () => {
    const test = await setup();
    try {
        assertEquals(test.key().value, "");
        assertEquals(button(test.root, "显示新密钥 60 秒").disabled, true);
        await test.click("生成安全密钥");
        const key = test.key().value;
        assertMatch(key, /^hd_[0-9a-f]{64}$/);
        assertEquals(test.key().getAttribute("type"), "text");
        assertEquals(test.timers.size, 1);
        assertEquals(test.requests.length, 0);
        await test.click("复制新密钥");
        assertEquals(test.copied, [key]);
        assertStringIncludes(test.root.textContent, "新密钥已复制");
        await test.click("保存设置");
        assertEquals(test.requests.length, 1);
        assertEquals(test.requests[0]!.method, "PUT");
        assertEquals(
            new Headers(test.requests[0]!.headers).get("if-match"),
            initial.etag,
        );
        assertEquals(JSON.parse(String(test.requests[0]!.body)), {
            limitPerMinute: 120,
            probeIntervalMs: 300_000,
            proxyKey: key,
        });
        assertEquals(test.key().value, "");
        assertEquals(test.key().getAttribute("type"), "password");
        assertEquals(test.timers.size, 0);
        assertEquals(test.root.textContent.includes(key), false);
        assertEquals(test.root.textContent.includes("新密钥已复制"), false);
        assertEquals(test.storageWrites, []);
        assertEquals(test.navigation, []);
    } finally {
        await test.dispose();
    }
});

Deno.test("gateway key visibility expires, masks on page hide, and never discards the unsaved credential", async () => {
    const test = await setup();
    try {
        await test.click("生成安全密钥");
        const key = test.key().value;
        await test.expire();
        assertEquals(test.key().getAttribute("type"), "password");
        assertEquals(test.key().value, key);
        await test.click("显示新密钥 60 秒");
        await test.act(() => globalThis.dispatchEvent(new Event("pagehide")));
        assertEquals(test.key().getAttribute("type"), "password");
        assertEquals(test.timers.size, 0);
        await test.click("显示新密钥 60 秒");
        Object.defineProperty(test.document, "visibilityState", {
            value: "hidden",
        });
        await test.act(() =>
            globalThis.dispatchEvent(new Event("visibilitychange"))
        );
        assertEquals(test.key().getAttribute("type"), "password");
        assertEquals(test.key().value, key);
    } finally {
        await test.dispose();
    }
});

Deno.test("gateway key clearing needs confirmation and a save, supports undo, and an empty draft preserves the stored credential", async () => {
    const test = await setup();
    try {
        await test.click("清除已有密钥");
        assertStringIncludes(test.root.textContent, "确认清除后仍需保存设置");
        assertEquals(test.requests.length, 0);
        await test.click("保留密钥");
        await test.click("保存设置");
        assertEquals(
            JSON.parse(String(test.requests[0]!.body)).proxyKey,
            undefined,
        );
        await test.click("清除已有密钥");
        await test.click("确认清除");
        assertStringIncludes(test.root.textContent, "待清除");
        assertEquals(test.requests.length, 1);
        await test.click("保留已有密钥");
        await test.edit("   ");
        await test.click("保存设置");
        assertEquals(
            JSON.parse(String(test.requests[1]!.body)).proxyKey,
            undefined,
        );
        await test.click("清除已有密钥");
        await test.click("确认清除");
        await test.click("保存设置");
        assertEquals(JSON.parse(String(test.requests[2]!.body)).proxyKey, "");
        assertStringIncludes(test.root.textContent, "已清除网关访问密钥");
        assertStringIncludes(test.root.textContent, "未配置");
    } finally {
        await test.dispose();
    }
});

Deno.test("gateway draft copy failures stay local and late results cannot report success for a different key", async () => {
    let complete: (() => void) | undefined;
    let copyCalls = 0;
    const test = await setup({
        copy: () => {
            copyCalls++;
            if (copyCalls === 1) {
                return new Promise<void>((resolve) => complete = resolve);
            }
            return Promise.reject(new Error("denied"));
        },
    });
    try {
        await test.edit("first-key");
        await test.click("复制新密钥");
        await test.edit("second-key");
        await test.act(() => complete?.());
        assertEquals(test.root.textContent.includes("新密钥已复制"), false);
        await test.click("复制新密钥");
        assertStringIncludes(test.root.textContent, "复制失败");
        assertEquals(test.key().value, "second-key");
        assertEquals(test.requests.length, 0);
        assertEquals(test.storageWrites, []);
    } finally {
        await test.dispose();
    }
});

Deno.test("gateway settings preserve the secret draft on a revision conflict and never resubmit until reload", async () => {
    const test = await setup({
        respond: () =>
            Response.json({ error: { message: "stale revision" } }, {
                status: 412,
            }),
    });
    try {
        await test.edit("replacement-key");
        await test.click("保存设置");
        assertEquals(test.key().value, "replacement-key");
        assertStringIncludes(test.root.textContent, "运行设置已发生变化");
        assertEquals(button(test.root, "保存设置").disabled, true);
        await test.click("保存设置");
        assertEquals(test.requests.length, 1);
    } finally {
        await test.dispose();
    }
});

Deno.test("runtime settings client projects only the configured flag from both GET and PUT responses", async () => {
    configureAdminTransport(() =>
        Promise.resolve(Response.json({
            settings: {
                ...initial.settings,
                proxyKey: "must-not-reach-ui-state",
            },
        }, { headers: { etag: initial.etag } }))
    );
    try {
        assertEquals(await loadRuntimeSettings(), initial);
        assertEquals(
            await saveRuntimeSettings(
                { proxyKey: "replacement" },
                initial.etag,
            ),
            initial,
        );
    } finally {
        configureAdminTransport();
    }
});
