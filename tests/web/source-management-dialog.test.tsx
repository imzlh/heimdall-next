/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { render, useState } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import type {
    ProxyPoolView,
    SourceProxySelection,
} from "@heimdall/admin-contracts/proxies.ts";
import {
    configureAdminTransport,
    type ListedSource,
} from "@heimdall/core/web/client/api/admin.ts";
import { SourceManagementDialog } from "@heimdall/core/web/client/source-management.tsx";
import type { ListedPlugin } from "@heimdall/admin-contracts/console.ts";
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

const proxyPool: ProxyPoolView = {
    defaultProxyId: "office",
    entries: [{
        id: "office",
        name: "办公室出口",
        url: "http://127.0.0.1:7890/",
        enabled: true,
        authConfigured: true,
    }, {
        id: "backup",
        name: "备用出口",
        url: "socks5://127.0.0.1:1080",
        enabled: false,
        authConfigured: false,
    }],
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
    options: {
        source?: ListedSource;
        proxyPool?: ProxyPoolView | null;
        plugins?: readonly ListedPlugin[];
    } = {},
) {
    const dom = installTestDom();
    Object.defineProperties(dom.document, {
        addEventListener: { value: () => {} },
        removeEventListener: { value: () => {} },
    });
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
                        source={options.source ?? source}
                        proxyPool={options.proxyPool}
                        plugins={options.plugins}
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
        async selectProxy(value: string) {
            const trigger = find(
                dialog,
                'button[data-dropdown="source-proxy"]',
            );
            const menuOpen = dialog.querySelectorAll('button[role="option"]')
                .length > 0;
            if (!menuOpen) {
                await dom.act(() => trigger.click());
            }
            await dom.act(() =>
                find(
                    dialog,
                    `button[role="option"][data-value="${value}"]`,
                ).click()
            );
        },
        async openProxyMenu() {
            await dom.act(() =>
                find(dialog, 'button[data-dropdown="source-proxy"]').click()
            );
        },
        proxyOptions() {
            return dialog.querySelectorAll('button[role="option"]').map((
                option,
            ) => ({
                value: option.getAttribute("data-value")!,
                label: option.textContent!,
                disabled: option.getAttribute("disabled") !== null,
            }));
        },
        proxyValue() {
            return find(dialog, 'button[data-dropdown="source-proxy"]')
                .getAttribute("data-value")!;
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

async function healthMode(
    test: Awaited<ReturnType<typeof setup>>,
    mode: string,
) {
    await test.act(() =>
        find(test.dialog, 'button[data-dropdown="source-health-mode"]').click()
    );
    await test.act(() =>
        find(test.dialog, `button[role="option"][data-value="${mode}"]`).click()
    );
}

Deno.test("source health policy converts seconds to milliseconds and blocks malformed edits", async () => {
    const test = await setup(undefined, {
        source: {
            ...source,
            effectiveHealthPolicy: { cooldownMs: 1234, authCooldownMs: 56000 },
        },
    });
    try {
        assert(test.dialog.textContent.includes("1.234 秒"));
        assert(test.dialog.textContent.includes("56 秒"));
        assert(test.dialog.textContent.includes("当前倒计时会保留"));
        await healthMode(test, "custom");
        await test.act(() =>
            input(
                find(test.dialog, 'input[name="source-health-cooldown"]'),
                "86400.001",
            )
        );
        await test.act(() => button(test.dialog, "保存修改").click());
        assertEquals(test.requests.length, 0);
        assert(test.dialog.textContent.includes("0 至 86400 秒"));
        assertEquals(
            find(test.dialog, 'input[name="source-health-cooldown"]')
                .getAttribute("aria-invalid"),
            "true",
        );
        await test.act(() =>
            input(
                find(test.dialog, 'input[name="source-health-cooldown"]'),
                "1.001",
            )
        );
        await test.act(() =>
            input(
                find(test.dialog, 'input[name="source-health-auth-cooldown"]'),
                "0",
            )
        );
        await test.act(() => button(test.dialog, "保存修改").click());
        assertEquals(JSON.parse(String(test.requests[0]?.init?.body)), {
            healthPolicy: { cooldownMs: 1001, authCooldownMs: 0 },
        });
        assertEquals(
            new Headers(test.requests[0]?.init?.headers).get("if-match"),
            source.versionstamp,
        );
        assertEquals(test.closes, 1);
    } finally {
        await test.dispose();
    }
});

Deno.test("source health policy inheritance explicitly clears a saved override", async () => {
    const test = await setup(undefined, {
        source: { ...source, healthPolicy: { cooldownMs: 2000 } },
    });
    try {
        await healthMode(test, "inherit");
        assertEquals(
            test.dialog.querySelector('input[name="source-health-cooldown"]'),
            null,
        );
        await test.act(() => button(test.dialog, "保存修改").click());
        assertEquals(JSON.parse(String(test.requests[0]?.init?.body)), {
            healthPolicy: null,
        });
    } finally {
        await test.dispose();
    }
});

Deno.test("source health policy conflict reload preserves local edits and refreshes untouched policy", async () => {
    for (const edited of [false, true]) {
        const baseline = { ...source, healthPolicy: { cooldownMs: 2000 } };
        const latest = {
            ...baseline,
            healthPolicy: { cooldownMs: 8000, authCooldownMs: 9000 },
            versionstamp: '"health-revision-2"',
        };
        const test = await setup(
            (_request, index) =>
                index === 0
                    ? Response.json({ error: { message: "冲突" } }, {
                        status: 409,
                    })
                    : index === 1
                    ? Response.json({ sources: [latest] })
                    : Response.json({ updated: true }),
            { source: baseline },
        );
        try {
            await test.edit("name", "本地名称");
            if (edited) {
                await test.act(() =>
                    input(
                        find(
                            test.dialog,
                            'input[name="source-health-cooldown"]',
                        ),
                        "3.001",
                    )
                );
            }
            await test.act(() => button(test.dialog, "保存修改").click());
            assert(
                find(test.dialog, 'button[data-dropdown="source-health-mode"]')
                    .disabled,
            );
            await test.act(() => button(test.dialog, "读取最新信息").click());
            assertEquals(
                find(test.dialog, 'input[name="source-health-cooldown"]').value,
                edited ? "3.001" : "8",
            );
            await test.act(() => button(test.dialog, "保存修改").click());
            assertEquals(JSON.parse(String(test.requests[2]?.init?.body)), {
                name: "本地名称",
                ...(edited ? { healthPolicy: { cooldownMs: 3001 } } : {}),
            });
            assertEquals(
                new Headers(test.requests[2]?.init?.headers).get("if-match"),
                latest.versionstamp,
            );
        } finally {
            await test.dispose();
        }
    }
});

Deno.test("quarantined health policy always submits a repair including null without clearing other configuration errors", async () => {
    for (const custom of [false, true]) {
        const test = await setup(undefined, {
            source: {
                ...source,
                configurationError: "健康策略已损坏",
                configurationErrorField: "healthPolicy",
            },
        });
        try {
            assert(
                test.dialog.textContent.includes(
                    "确认下方健康策略后保存即可修复",
                ),
            );
            if (custom) {
                await healthMode(test, "custom");
                await test.act(() =>
                    input(
                        find(
                            test.dialog,
                            'input[name="source-health-auth-cooldown"]',
                        ),
                        "0",
                    )
                );
            }
            await test.act(() => button(test.dialog, "保存修改").click());
            assertEquals(JSON.parse(String(test.requests[0]?.init?.body)), {
                healthPolicy: custom ? { authCooldownMs: 0 } : null,
            });
            assertEquals(test.changes[0]?.source.configurationError, undefined);
        } finally {
            await test.dispose();
        }
    }
    const test = await setup(undefined, {
        source: {
            ...source,
            configurationError: "连接参数损坏",
            configurationErrorField: "config",
        },
    });
    try {
        await healthMode(test, "custom");
        await test.act(() =>
            input(
                find(test.dialog, 'input[name="source-health-cooldown"]'),
                "0",
            )
        );
        await test.act(() => button(test.dialog, "保存修改").click());
        assertEquals(test.changes[0]?.source.configurationErrorField, "config");
        assertEquals(
            test.changes[0]?.source.configurationError,
            "连接参数损坏",
        );
    } finally {
        await test.dispose();
    }
});

Deno.test("source middleware selection preserves inactive bindings, filters plugin kinds and saves order", async () => {
    const test = await setup(undefined, {
        source: {
            ...source,
            middleware: [
                "middleware.first",
                "middleware.paused",
                "middleware.missing",
            ],
        },
        plugins: [
            {
                id: "middleware.first",
                name: "前处理",
                kind: "middleware",
                enabled: true,
            },
            {
                id: "middleware.second",
                name: "后处理",
                kind: "middleware",
                enabled: true,
            },
            {
                id: "middleware.paused",
                name: "暂停插件",
                kind: "middleware",
                enabled: false,
            },
            { id: "tool.other", name: "其他工具", kind: "tool", enabled: true },
        ],
    });
    try {
        assert(test.dialog.textContent.includes("已停用 · 保留绑定"));
        assert(test.dialog.textContent.includes("插件不可用 · 保留绑定"));
        assert(find(test.dialog, 'button[aria-label="上移 前处理"]').disabled);
        await test.act(() =>
            find(test.dialog, 'button[aria-label="上移 暂停插件"]').click()
        );
        await test.act(() =>
            find(test.dialog, 'button[data-dropdown="source-middleware-add"]')
                .click()
        );
        assertEquals(
            test.dialog.querySelector('button[data-value="tool.other"]'),
            null,
        );
        await test.act(() =>
            find(test.dialog, 'button[data-value="middleware.second"]').click()
        );
        assertEquals(
            test.dialog.querySelectorAll("[data-middleware-id]").map((row) =>
                row.getAttribute("data-middleware-id")
            ),
            [
                "middleware.paused",
                "middleware.first",
                "middleware.missing",
                "middleware.second",
            ],
        );
        await test.act(() => button(test.dialog, "保存修改").click());
        assertEquals(JSON.parse(String(test.requests[0]?.init?.body)), {
            middleware: [
                "middleware.paused",
                "middleware.first",
                "middleware.missing",
                "middleware.second",
            ],
        });
        assertEquals(test.closes, 1);
    } finally {
        await test.dispose();
    }
});

Deno.test("source middleware inheritance and empty override remain distinct", async () => {
    for (const mode of ["inherit", "custom"]) {
        const test = await setup(undefined, {
            source: { ...source, middleware: ["middleware.first"] },
        });
        try {
            if (mode === "inherit") {
                await test.act(() =>
                    find(
                        test.dialog,
                        'button[data-dropdown="source-middleware-mode"]',
                    ).click()
                );
                await test.act(() =>
                    find(
                        test.dialog,
                        'button[role="option"][data-value="inherit"]',
                    ).click()
                );
            } else {
                await test.act(() =>
                    find(
                        test.dialog,
                        'button[aria-label="移除 middleware.first"]',
                    ).click()
                );
            }
            await test.act(() => button(test.dialog, "保存修改").click());
            assertEquals(JSON.parse(String(test.requests[0]?.init?.body)), {
                middleware: mode === "inherit" ? null : [],
            });
        } finally {
            await test.dispose();
        }
    }
});

Deno.test("source middleware conflict reload preserves local ordering and adopts unedited remote bindings", async () => {
    for (const reorder of [false, true]) {
        const baseline = {
            ...source,
            middleware: ["middleware.first", "middleware.second"],
        };
        const latest = {
            ...baseline,
            middleware: ["middleware.remote"],
            versionstamp: '"revision-2"',
        };
        const test = await setup(
            (_request, index) =>
                index === 0
                    ? Response.json({ error: { message: "冲突" } }, {
                        status: 409,
                    })
                    : index === 1
                    ? Response.json({ sources: [latest] })
                    : Response.json({ updated: true }),
            { source: baseline },
        );
        try {
            await test.edit("name", "本地名称");
            if (reorder) {
                await test.act(() =>
                    find(
                        test.dialog,
                        'button[aria-label="上移 middleware.second"]',
                    ).click()
                );
            }
            await test.act(() => button(test.dialog, "保存修改").click());
            assert(
                find(
                    test.dialog,
                    'button[data-dropdown="source-middleware-mode"]',
                ).disabled,
            );
            await test.act(() => button(test.dialog, "读取最新信息").click());
            const expected = reorder
                ? ["middleware.second", "middleware.first"]
                : ["middleware.remote"];
            assertEquals(
                test.dialog.querySelectorAll("[data-middleware-id]").map((
                    row,
                ) => row.getAttribute("data-middleware-id")),
                expected,
            );
            await test.act(() => button(test.dialog, "保存修改").click());
            assertEquals(JSON.parse(String(test.requests[2]?.init?.body)), {
                name: "本地名称",
                ...(reorder ? { middleware: expected } : {}),
            });
            assertEquals(
                new Headers(test.requests[2]?.init?.headers).get("if-match"),
                latest.versionstamp,
            );
        } finally {
            await test.dispose();
        }
    }
});

Deno.test("source management repairs quarantined middleware even when the projected empty list is unchanged", async () => {
    for (const inherit of [false, true]) {
        const corrupted: ListedSource = {
            ...source,
            enabled: false,
            middleware: [],
            configurationError: "中间件配置已损坏，此渠道已暂停，请重新配置。",
            ...(inherit
                ? { configurationErrorField: "middleware" as const }
                : {}),
        };
        const test = await setup(undefined, { source: corrupted });
        try {
            assertEquals(
                find(test.dialog, '[role="alert"]').textContent,
                corrupted.configurationError,
            );
            assert(!button(test.dialog, "保存修改").disabled);
            if (inherit) {
                await test.act(() =>
                    find(
                        test.dialog,
                        'button[data-dropdown="source-middleware-mode"]',
                    ).click()
                );
                await test.act(() =>
                    find(
                        test.dialog,
                        'button[role="option"][data-value="inherit"]',
                    ).click()
                );
            }
            await test.act(() => button(test.dialog, "保存修改").click());
            assertEquals(test.requests.length, 1);
            assertEquals(test.requests[0]?.init?.method, "PATCH");
            assertEquals(JSON.parse(String(test.requests[0]?.init?.body)), {
                middleware: inherit ? null : [],
            });
            assertEquals(
                new Headers(test.requests[0]?.init?.headers).get("if-match"),
                corrupted.versionstamp,
            );
            assertEquals(
                test.changes[0]?.source.middleware,
                inherit ? null : [],
            );
            assertEquals(test.changes[0]?.source.configurationError, undefined);
            assertEquals(
                test.changes[0]?.source.configurationErrorField,
                undefined,
            );
            assertEquals(test.closes, 1);
        } finally {
            await test.dispose();
        }
    }
});

Deno.test("source management repairs corrupted model mapping with the empty projection or replacement rows", async () => {
    for (const replace of [false, true]) {
        const corrupted: ListedSource = {
            ...source,
            enabled: false,
            middleware: [],
            modelMap: {},
            configurationError: "模型映射已损坏，请重新设置后保存。",
            configurationErrorField: "modelMap",
        };
        const test = await setup(undefined, { source: corrupted });
        try {
            assert(test.dialog.textContent.includes("确认下方模型映射后保存"));
            if (replace) {
                await test.act(() =>
                    button(test.dialog, "添加模型映射").click()
                );
                await test.act(() =>
                    input(
                        find(test.dialog, 'input[name="model-alias-0"]'),
                        "fast",
                    )
                );
                await test.act(() =>
                    input(
                        find(test.dialog, 'input[name="model-upstream-0"]'),
                        "provider-fast",
                    )
                );
            }
            await test.act(() => button(test.dialog, "保存修改").click());
            assertEquals(test.requests.length, 1);
            assertEquals(test.requests[0]?.init?.method, "PATCH");
            const modelMap: NonNullable<ListedSource["modelMap"]> = replace
                ? { fast: "provider-fast" }
                : {};
            assertEquals(JSON.parse(String(test.requests[0]?.init?.body)), {
                modelMap,
            });
            assertEquals(
                new Headers(test.requests[0]?.init?.headers).get("if-match"),
                corrupted.versionstamp,
            );
            assertEquals(test.changes[0]?.source.modelMap, modelMap);
            assertEquals(test.changes[0]?.source.configurationError, undefined);
            assertEquals(
                test.changes[0]?.source.configurationErrorField,
                undefined,
            );
            assertEquals(test.closes, 1);
        } finally {
            await test.dispose();
        }
    }
});

Deno.test("model mapping repair keeps the source quarantined and preserves rows across revision conflicts", async () => {
    const corrupted: ListedSource = {
        ...source,
        enabled: false,
        modelMap: {},
        configurationError: "模型映射已损坏，请重新设置后保存。",
        configurationErrorField: "modelMap",
    };
    const latest = { ...corrupted, versionstamp: '"revision-2"' };
    const test = await setup(
        (_request, index) =>
            index === 0
                ? Response.json({
                    error: {
                        code: "version_conflict",
                        message: "渠道版本已变化",
                    },
                }, { status: 409 })
                : index === 1
                ? Response.json({ sources: [latest] })
                : Response.json({ updated: true }),
        { source: corrupted },
    );
    try {
        await test.act(() => button(test.dialog, "添加模型映射").click());
        await test.act(() =>
            input(find(test.dialog, 'input[name="model-alias-0"]'), "fast")
        );
        await test.act(() =>
            input(
                find(test.dialog, 'input[name="model-upstream-0"]'),
                "local-model",
            )
        );
        await test.act(() => button(test.dialog, "保存修改").click());
        assertEquals(test.requests.length, 1);
        assertEquals(test.changes, []);
        assertEquals(test.closes, 0);
        assert(test.dialog.textContent.includes(corrupted.configurationError!));
        assert(button(test.dialog, "保存修改").disabled);
        assertEquals(
            find(test.dialog, 'input[name="model-upstream-0"]').value,
            "local-model",
        );
        await test.act(() => button(test.dialog, "读取最新信息").click());
        assert(test.dialog.textContent.includes(corrupted.configurationError!));
        assertEquals(
            find(test.dialog, 'input[name="model-upstream-0"]').value,
            "local-model",
        );
        await test.act(() => button(test.dialog, "保存修改").click());
        assertEquals(JSON.parse(String(test.requests[2]?.init?.body)), {
            modelMap: { fast: "local-model" },
        });
        assertEquals(
            new Headers(test.requests[2]?.init?.headers).get("if-match"),
            latest.versionstamp,
        );
        assertEquals(test.changes[0]?.source.configurationError, undefined);
        assertEquals(
            test.changes[0]?.source.configurationErrorField,
            undefined,
        );
        assertEquals(test.closes, 1);
    } finally {
        await test.dispose();
    }
});

Deno.test("provider configuration errors guide the config editor and are not cleared by metadata saves", async () => {
    const corrupted: ListedSource = {
        ...source,
        enabled: false,
        middleware: [],
        modelMap: {},
        configurationError: "连接参数无效，请重新配置。",
        configurationErrorField: "config",
    };
    for (const changeMiddleware of [false, true]) {
        const test = await setup(undefined, { source: corrupted });
        try {
            assert(test.dialog.textContent.includes("渠道卡的「配置」入口"));
            await test.edit("name", "新名称");
            if (changeMiddleware) {
                await test.act(() =>
                    find(
                        test.dialog,
                        'button[data-dropdown="source-middleware-mode"]',
                    )
                        .click()
                );
                await test.act(() =>
                    find(
                        test.dialog,
                        'button[role="option"][data-value="inherit"]',
                    )
                        .click()
                );
            }
            await test.act(() => button(test.dialog, "保存修改").click());
            assertEquals(JSON.parse(String(test.requests[0]?.init?.body)), {
                name: "新名称",
                ...(changeMiddleware ? { middleware: null } : {}),
            });
            assertEquals(
                test.changes[0]?.source.configurationError,
                corrupted.configurationError,
            );
            assertEquals(
                test.changes[0]?.source.configurationErrorField,
                "config",
            );
        } finally {
            await test.dispose();
        }
    }
});

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

Deno.test("source management edits, validates and clears model routing metadata independently of provider config", async () => {
    const test = await setup(undefined, {
        source: { ...source, modelMap: { fast: "upstream-fast" } },
    });
    try {
        await test.act(() => button(test.dialog, "添加模型映射").click());
        await test.act(() =>
            input(find(test.dialog, 'input[name="model-alias-1"]'), " fast ")
        );
        await test.act(() =>
            input(
                find(test.dialog, 'input[name="model-upstream-1"]'),
                "upstream-other",
            )
        );
        await test.act(() => button(test.dialog, "保存修改").click());
        assertEquals(test.requests, []);
        assert(test.dialog.textContent.includes("重复"));
        assertEquals(
            find(test.dialog, 'input[name="model-alias-1"]').getAttribute(
                "aria-invalid",
            ),
            "true",
        );
        await test.act(() =>
            input(find(test.dialog, 'input[name="model-alias-1"]'), "slow")
        );
        await test.act(() => button(test.dialog, "保存修改").click());
        assertEquals(JSON.parse(String(test.requests[0]?.init?.body)), {
            modelMap: { fast: "upstream-fast", slow: "upstream-other" },
        });
        assertEquals(test.changes[0]?.source.modelMap, {
            fast: "upstream-fast",
            slow: "upstream-other",
        });
    } finally {
        await test.dispose();
    }
    const cleared = await setup(undefined, {
        source: { ...source, modelMap: { fast: "upstream-fast" } },
    });
    try {
        await cleared.act(() =>
            find(cleared.dialog, 'button[aria-label="删除第 1 行映射"]').click()
        );
        await cleared.act(() => button(cleared.dialog, "保存修改").click());
        assertEquals(JSON.parse(String(cleared.requests[0]?.init?.body)), {
            modelMap: {},
        });
    } finally {
        await cleared.dispose();
    }
});

Deno.test("source mapping revision conflicts preserve changed aliases and adopt untouched remote mappings", async () => {
    for (const localChanged of [false, true]) {
        const original = { ...source, modelMap: { fast: "original-model" } };
        const latest = {
            ...original,
            modelMap: { fast: "remote-model" },
            priority: 8,
            versionstamp: '"revision-2"',
        };
        const test = await setup(
            (_request, index) =>
                index === 0
                    ? Response.json({
                        error: { code: "version_conflict", message: "已变更" },
                    }, { status: 409 })
                    : index === 1
                    ? Response.json({ sources: [latest] })
                    : Response.json({ updated: true }),
            { source: original },
        );
        try {
            await test.edit("name", "本地渠道");
            if (localChanged) {
                await test.act(() =>
                    input(
                        find(test.dialog, 'input[name="model-upstream-0"]'),
                        "local-model",
                    )
                );
            }
            await test.act(() => button(test.dialog, "保存修改").click());
            await test.act(() => button(test.dialog, "读取最新信息").click());
            assertEquals(
                find(test.dialog, 'input[name="model-upstream-0"]').value,
                localChanged ? "local-model" : "remote-model",
            );
            await test.act(() => button(test.dialog, "保存修改").click());
            assertEquals(JSON.parse(String(test.requests[2]?.init?.body)), {
                name: "本地渠道",
                ...(localChanged ? { modelMap: { fast: "local-model" } } : {}),
            });
            assertEquals(
                new Headers(test.requests[2]?.init?.headers).get("if-match"),
                latest.versionstamp,
            );
        } finally {
            await test.dispose();
        }
    }
});

Deno.test("source management offers inheritance, direct access and named proxies and saves the chosen mode", async () => {
    const choices: {
        initial: SourceProxySelection;
        selected: SourceProxySelection;
        value: string;
    }[] = [{
        initial: { mode: "direct" },
        selected: { mode: "inherit" },
        value: "inherit",
    }, {
        initial: { mode: "inherit" },
        selected: { mode: "direct" },
        value: "direct",
    }, {
        initial: { mode: "inherit" },
        selected: { mode: "proxy", proxyId: "office" },
        value: "proxy:office",
    }];
    for (const choice of choices) {
        const original = { ...source, proxy: choice.initial };
        const test = await setup(undefined, { source: original, proxyPool });
        try {
            assertEquals(test.proxyValue(), choice.initial.mode);
            await test.openProxyMenu();
            const options = test.proxyOptions();
            assertEquals(
                options.find((option) => option.value === "inherit")?.label,
                "继承全局 · 办公室出口",
            );
            assertEquals(
                options.find((option) => option.value === "direct")?.label,
                "直连",
            );
            assertEquals(
                options.find((option) => option.value === "proxy:office")
                    ?.label,
                "办公室出口",
            );
            assertEquals(
                options.find((option) => option.value === "proxy:office")
                    ?.disabled,
                false,
            );
            assertEquals(
                options.find((option) => option.value === "proxy:backup")
                    ?.disabled,
                true,
            );
            assert(
                test.dialog.textContent.includes(
                    "代理选择由插件读取，是否使用取决于插件实现。",
                ),
            );
            await test.selectProxy(choice.value);
            assertEquals(test.proxyValue(), choice.value);
            await test.act(() => button(test.dialog, "保存修改").click());
            assertEquals(test.requests.length, 1);
            const request = test.requests[0]!;
            assertEquals(request.init?.method, "PATCH");
            assertEquals(JSON.parse(String(request.init?.body)), {
                proxy: choice.selected,
            });
            assertEquals(
                new Headers(request.init?.headers).get("if-match"),
                source.versionstamp,
            );
            assertEquals(test.changes, [{
                kind: "saved",
                source: { ...original, proxy: choice.selected },
            }]);
            assertEquals(test.lifecycle, ["saved", "closed"]);
            assertEquals(test.navigation, []);
            assertEquals(test.storageWrites, []);
        } finally {
            await test.dispose();
        }
    }
});

Deno.test("source name edits preserve an existing disabled or removed proxy without resubmitting it", async () => {
    for (
        const unavailable of [
            { id: "backup", label: "备用出口（已停用）" },
            { id: "removed", label: "removed（已移除）" },
        ]
    ) {
        const original: ListedSource = {
            ...source,
            proxy: { mode: "proxy", proxyId: unavailable.id },
        };
        const test = await setup(undefined, { source: original, proxyPool });
        try {
            assertEquals(
                test.proxyValue(),
                `proxy:${unavailable.id}`,
            );
            await test.openProxyMenu();
            const option = test.proxyOptions().find((candidate) =>
                candidate.value === `proxy:${unavailable.id}`
            );
            assert(option?.disabled);
            assertEquals(option.label, unavailable.label);
            await test.edit("name", "仅更新渠道名称");
            await test.act(() => button(test.dialog, "保存修改").click());
            assertEquals(test.requests.length, 1);
            assertEquals(JSON.parse(String(test.requests[0]!.init?.body)), {
                name: "仅更新渠道名称",
            });
            assertEquals(test.changes, [{
                kind: "saved",
                source: { ...original, name: "仅更新渠道名称" },
            }]);
            assertEquals(test.closes, 1);
        } finally {
            await test.dispose();
        }
    }
});

Deno.test("source proxy conflict reload keeps a changed local choice and adopts an untouched remote choice", async () => {
    for (const localProxyChanged of [true, false]) {
        const original: ListedSource = {
            ...source,
            proxy: { mode: "inherit" },
        };
        const latest: ListedSource = {
            ...original,
            name: "服务器新名称",
            priority: 29,
            proxy: { mode: "direct" },
            versionstamp: '"revision-proxy-2"',
        };
        const localProxy: SourceProxySelection = {
            mode: "proxy",
            proxyId: "office",
        };
        const test = await setup((_request, index) => {
            if (index === 0) {
                return Response.json({
                    error: {
                        code: "version_conflict",
                        message: "渠道已被修改",
                    },
                }, { status: 409 });
            }
            if (index === 1) return Response.json({ sources: [latest] });
            return Response.json({ updated: true });
        }, { source: original, proxyPool });
        try {
            await test.edit("name", "本地新名称");
            if (localProxyChanged) await test.selectProxy("proxy:office");
            const expectedChanges = {
                name: "本地新名称",
                ...(localProxyChanged ? { proxy: localProxy } : {}),
            };
            await test.act(() => button(test.dialog, "保存修改").click());
            assertEquals(test.requests.length, 1);
            assertEquals(
                JSON.parse(String(test.requests[0]!.init?.body)),
                expectedChanges,
            );
            assert(
                find(
                    test.dialog,
                    'button[data-dropdown="source-proxy"]',
                ).getAttribute("disabled") !== null,
            );
            assert(button(test.dialog, "保存修改").disabled);
            assertEquals(test.closes, 0);
            await test.act(() => button(test.dialog, "读取最新信息").click());
            assertEquals(test.requests.length, 2);
            assertEquals(test.requests[1]!.input, "/api/admin/sources");
            assertEquals(
                test.proxyValue(),
                localProxyChanged ? "proxy:office" : "direct",
            );
            assertEquals(
                find(test.dialog, 'button[data-dropdown="source-proxy"]')
                    .getAttribute("disabled"),
                null,
            );
            assertEquals(
                find(test.dialog, 'input[name="source-name"]').value,
                "本地新名称",
            );
            assertEquals(
                find(test.dialog, 'input[name="source-priority"]').value,
                "29",
            );
            await test.act(() => button(test.dialog, "保存修改").click());
            assertEquals(test.requests.length, 3);
            const retry = test.requests[2]!;
            assertEquals(JSON.parse(String(retry.init?.body)), expectedChanges);
            assertEquals(
                new Headers(retry.init?.headers).get("if-match"),
                latest.versionstamp,
            );
            assertEquals(test.changes, [{
                kind: "saved",
                source: { ...latest, ...expectedChanges },
            }]);
            assertEquals(test.closes, 1);
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
