/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import {
    assert,
    assertEquals,
    assertNotStrictEquals,
    assertStrictEquals,
} from "@std/assert";
import { render, useEffect, useRef, useState } from "hono/jsx/dom";
// Include the DOM runtime in Deno's graph when this suite uses the SSR config.
import "hono/jsx/dom/jsx-runtime";
import {
    AddSourceFlow,
    type AddSourceFlowProps,
    type PresetFlowControls,
} from "../../src/web/client/add-source.tsx";
import type {
    SourceSetupSaveInput,
} from "../../src/web/client/source-config-form.tsx";
import type { SourceSetupDraft } from "../../src/web/client/source-setup-draft.ts";
import { sourceConfigSchema } from "../../src/web/shared/source-schemas.ts";
import { mountPresetEditor } from "../../src/web/client/forms/preset-bridge.ts";
import { mount } from "../../plugins/newapi-preset/ui.tsx";
import { PRESET_UI_FEEDBACK_EVENT } from "@heimdall/admin-contracts/preset-ui.ts";
import { installTestDom, TestElement } from "./helpers/jsx-dom.ts";
import { SourceCreateDialog } from "../../src/web/client/source-create-dialog.tsx";
import { configureAdminTransport } from "../../src/web/client/api/admin.ts";

const sourcePluginId = "heimdall.source.openai-compatible";
const presetId = "heimdall.preset.newapi";
const sources = [{
    id: sourcePluginId,
    name: "OpenAI 兼容",
    schema: sourceConfigSchema(sourcePluginId),
}];
const presets = [{ id: presetId, name: "NewAPI", sourcePluginId }];

function find(root: TestElement, selector: string): TestElement {
    const element = root.querySelector(selector);
    assert(element, `Missing ${selector}: ${root.textContent}`);
    return element;
}

function button(root: TestElement, text: string): TestElement {
    const element = root.querySelectorAll("button").find((candidate) =>
        candidate.textContent.includes(text)
    );
    assert(element, `Missing button ${text}: ${root.textContent}`);
    return element;
}

function input(element: TestElement, value: string): void {
    element.value = value;
    element.dispatchEvent(new Event("input"));
}

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

/** Load the actual plugin through its public JSON bridge, without network import. */
function PluginFixture({ draft, controls, lifecycle, onProbe }: {
    draft: SourceSetupDraft;
    controls: PresetFlowControls;
    lifecycle: { mounts: number; cleanups: number };
    onProbe?: AddSourceFlowProps["onProbe"];
}) {
    const root = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        lifecycle.mounts++;
        const dispose = mountPresetEditor(
            root.current!,
            {
                draft: {
                    id: draft.id,
                    name: draft.name,
                    priority: draft.priority,
                },
                presetId: draft.presetId!,
                sourcePluginId,
                ...(draft.modelMap ? { modelMap: draft.modelMap } : {}),
            },
            () => Promise.resolve({ mount }),
            {
                onSubmit: controls.onSave,
                onModelMapChange: controls.onModelMapChange,
                onPreview: () => Promise.resolve(),
                ...(onProbe
                    ? {
                        onProbe: (config, signal, modelMap) =>
                            onProbe({
                                draft: modelMap === undefined
                                    ? draft
                                    : { ...draft, modelMap },
                                sourcePluginId,
                                config,
                            }, signal),
                    }
                    : {}),
            },
            () => {},
            () => {
                throw new Error("Preset failed to mount");
            },
        );
        return () => {
            lifecycle.cleanups++;
            void dispose();
        };
    }, []);
    return <div ref={root} data-preset-fixture="" />;
}

async function setup(
    options: {
        onSave?: AddSourceFlowProps["onSave"];
        onProbe?: AddSourceFlowProps["onProbe"];
        reducedMotion?: boolean;
        plugins?: AddSourceFlowProps["plugins"];
    } = {},
) {
    const dom = installTestDom({ reducedMotion: options.reducedMotion });
    const saved: SourceSetupSaveInput[] = [];
    const completed: SourceSetupDraft[] = [];
    const lifecycle = { mounts: 0, cleanups: 0 };
    let closes = 0;
    let unmount = () => {};
    function App() {
        const [active, setActive] = useState(true);
        const [open, setOpen] = useState(false);
        unmount = () => setActive(false);
        if (!active) return null;
        return (
            <>
                <button type="button" onClick={() => setOpen(true)}>
                    添加渠道
                </button>
                {open && (
                    <AddSourceFlow
                        sources={sources}
                        presets={presets}
                        plugins={options.plugins}
                        onProbe={options.onProbe}
                        onSave={async (value) => {
                            saved.push(value);
                            await options.onSave?.(value);
                        }}
                        onSaved={(draft) => completed.push(draft)}
                        onClose={() => {
                            closes++;
                            setOpen(false);
                        }}
                        renderPreset={(draft, controls) => (
                            <PluginFixture
                                draft={draft}
                                controls={controls}
                                lifecycle={lifecycle}
                                onProbe={options.onProbe}
                            />
                        )}
                    />
                )}
            </>
        );
    }
    await dom.act(() => render(<App />, dom.root as unknown as HTMLElement));
    const trigger = button(dom.root, "添加渠道");
    trigger.focus();
    await dom.act(() => trigger.click());
    const dialog = find(dom.root, "dialog");
    async function details() {
        const inputs = dialog.querySelectorAll("input");
        await dom.act(() => input(inputs[0]!, "主力模型"));
        await dom.act(() => input(inputs[1]!, "17"));
        await dom.act(() => button(dialog, "下一步").click());
    }
    return {
        ...dom,
        dialog,
        trigger,
        saved,
        completed,
        lifecycle,
        get closes() {
            return closes;
        },
        details,
        async dispose() {
            await dom.act(unmount);
            dom.restore();
        },
    };
}

Deno.test("source creation keeps health policy in host metadata for preset and custom saves and validates before proceeding", async () => {
    for (const choice of ["NewAPI", "自定义配置"]) {
        const test = await setup();
        try {
            await test.act(() =>
                find(test.dialog, 'button[data-dropdown="source-health-mode"]')
                    .click()
            );
            await test.act(() =>
                find(test.dialog, 'button[role="option"][data-value="custom"]')
                    .click()
            );
            await test.act(() =>
                input(
                    find(test.dialog, 'input[name="source-health-cooldown"]'),
                    "-1",
                )
            );
            await test.details();
            assert(test.dialog.textContent.includes("普通失败冷却必须"));
            assertEquals(test.saved.length, 0);
            await test.act(() =>
                input(
                    find(test.dialog, 'input[name="source-health-cooldown"]'),
                    "0.001",
                )
            );
            await test.act(() =>
                input(
                    find(
                        test.dialog,
                        'input[name="source-health-auth-cooldown"]',
                    ),
                    "0",
                )
            );
            await test.act(() => button(test.dialog, "下一步").click());
            await test.act(() => button(test.dialog, choice).click());
            await test.act(() => button(test.dialog, "上一步").click());
            await test.act(() => button(test.dialog, "上一步").click());
            assertEquals(
                find(test.dialog, 'input[name="source-health-cooldown"]').value,
                "0.001",
            );
            await test.act(() => button(test.dialog, "下一步").click());
            await test.act(() => button(test.dialog, choice).click());
            await test.act(() =>
                input(
                    find(test.dialog, 'input[name="baseUrl"]'),
                    "https://provider.example/v1",
                )
            );
            await test.act(() => button(test.dialog, "保存渠道").click());
            assertEquals(test.saved[0]?.draft.healthPolicy, {
                cooldownMs: 1,
                authCooldownMs: 0,
            });
            assertEquals(test.saved[0]?.config.healthPolicy, undefined);
            assertEquals(test.navigation, []);
            assertEquals(test.dialog.showModalCalls, 1);
        } finally {
            await test.dispose();
        }
    }
});

Deno.test("source creation keeps one dialog while switching preset JSX and custom fields", async () => {
    const test = await setup();
    try {
        assert(test.dialog.open);
        assertEquals(test.dialog.showModalCalls, 1);
        await test.details();
        await test.act(() => button(test.dialog, "NewAPI").click());
        assertStrictEquals(find(test.root, "dialog"), test.dialog);
        assert(
            test.dialog.contains(find(test.dialog, "[data-preset-fixture]")),
        );
        assert(find(test.dialog, 'input[name="baseUrl"]'));
        assertEquals(test.lifecycle, { mounts: 1, cleanups: 0 });
        await test.act(() =>
            input(find(test.dialog, 'input[name="apiKey"]'), "discard-me")
        );
        await test.act(() => button(test.dialog, "上一步").click());
        assertEquals(test.lifecycle, { mounts: 1, cleanups: 1 });
        assertEquals(test.dialog.querySelector("[data-preset-fixture]"), null);
        assertEquals(
            button(test.dialog, "NewAPI").getAttribute("aria-pressed"),
            "true",
        );
        assert(test.dialog.textContent.includes("主力模型"));
        assert(test.dialog.textContent.includes("17"));
        await test.act(() => button(test.dialog, "上一步").click());
        const fields = test.dialog.querySelectorAll("input");
        assertEquals(fields.map((field) => field.value), ["主力模型", "17"]);
        await test.act(() => button(test.dialog, "下一步").click());
        assertEquals(
            button(test.dialog, "NewAPI").getAttribute("aria-pressed"),
            "true",
        );
        await test.act(() => button(test.dialog, "自定义配置").click());
        assertStrictEquals(find(test.root, "dialog"), test.dialog);
        assertEquals(find(test.dialog, 'input[name="apiKey"]').value, "");
        assert(find(test.dialog, 'button[data-dropdown="source-type"]'));
        assertEquals(test.dialog.showModalCalls, 1);
        assertEquals(test.navigation, []);
        assertEquals(test.storageWrites, []);
    } finally {
        await test.dispose();
    }
});

Deno.test("basic model mappings validate before advancing and survive preset and custom navigation", async () => {
    for (const choice of ["自定义配置", "NewAPI"]) {
        const test = await setup();
        try {
            await test.act(() => button(test.dialog, "添加模型映射").click());
            await test.details();
            assert(test.dialog.textContent.includes("请填写每行"));
            const alias = find(test.dialog, 'input[name="model-alias-0"]');
            assertEquals(alias.getAttribute("aria-invalid"), "true");
            await test.act(() => input(alias, " fast "));
            await test.act(() =>
                input(
                    find(test.dialog, 'input[name="model-upstream-0"]'),
                    " provider-fast ",
                )
            );
            await test.act(() => button(test.dialog, "下一步").click());
            await test.act(() => button(test.dialog, choice).click());
            await test.act(() => button(test.dialog, "上一步").click());
            await test.act(() => button(test.dialog, "上一步").click());
            assertEquals(
                find(test.dialog, 'input[name="model-alias-0"]').value,
                " fast ",
            );
            await test.act(() => button(test.dialog, "下一步").click());
            await test.act(() => button(test.dialog, choice).click());
            await test.act(() =>
                input(
                    find(test.dialog, 'input[name="baseUrl"]'),
                    "https://provider.example/v1",
                )
            );
            await test.act(() => button(test.dialog, "保存渠道").click());
            assertEquals(test.saved[0]?.draft.modelMap, {
                fast: "provider-fast",
            });
            assertEquals(test.saved[0]?.draft.priority, 17);
            assertEquals(test.saved[0]?.config.modelMap, undefined);
            assertEquals(test.navigation, []);
            assertEquals(test.dialog.showModalCalls, 1);
        } finally {
            await test.dispose();
        }
    }
});

Deno.test("middleware bindings survive preset JSX and custom configuration in the same creation dialog", async () => {
    for (const choice of ["NewAPI", "自定义配置"]) {
        const test = await setup({
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
                    enabled: false,
                },
            ],
        });
        const select = async (name: string, value: string) => {
            await test.act(() =>
                find(test.dialog, `button[data-dropdown="${name}"]`).click()
            );
            await test.act(() =>
                find(
                    test.dialog,
                    `button[role="option"][data-value="${value}"]`,
                ).click()
            );
        };
        try {
            await select("source-middleware-mode", "custom");
            await select("source-middleware-add", "middleware.first");
            await select("source-middleware-add", "middleware.second");
            await test.act(() =>
                find(test.dialog, 'button[aria-label="上移 后处理"]').click()
            );
            await select("source-middleware-mode", "inherit");
            await select("source-middleware-mode", "custom");
            await test.details();
            await test.act(() => button(test.dialog, choice).click());
            assertStrictEquals(find(test.root, "dialog"), test.dialog);
            await test.act(() => button(test.dialog, "上一步").click());
            await test.act(() => button(test.dialog, "上一步").click());
            assertEquals(
                test.dialog.querySelectorAll("[data-middleware-id]").map((
                    row,
                ) => row.getAttribute("data-middleware-id")),
                ["middleware.second", "middleware.first"],
            );
            await test.act(() => button(test.dialog, "下一步").click());
            await test.act(() => button(test.dialog, choice).click());
            await test.act(() =>
                input(
                    find(test.dialog, 'input[name="baseUrl"]'),
                    "https://provider.example/v1",
                )
            );
            await test.act(() => button(test.dialog, "保存渠道").click());
            assertEquals(test.saved[0]?.draft.middleware, [
                "middleware.second",
                "middleware.first",
            ]);
            assertEquals(test.saved[0]?.config.middleware, undefined);
            assertEquals(test.navigation, []);
            assertEquals(test.dialog.showModalCalls, 1);
        } finally {
            await test.dispose();
        }
    }
});

Deno.test("source creation catalog wires host middleware into the create request without executing it during probing", async () => {
    const dom = installTestDom();
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    configureAdminTransport((path, init) => {
        requests.push({
            path: String(path),
            body: JSON.parse(String(init?.body)),
        });
        return Promise.resolve(
            Response.json(
                String(path).endsWith("source-draft-probe")
                    ? {
                        probe: {
                            ok: true,
                            message: "连接成功",
                            checkedAt: "2026-10-01T00:00:00.000Z",
                            models: [],
                        },
                    }
                    : { created: true },
            ),
        );
    });
    try {
        await dom.act(() =>
            render(
                <SourceCreateDialog
                    dashboard={{
                        health: { status: "ok" },
                        models: [],
                        authRequired: false,
                        errors: {
                            health: "",
                            models: "",
                            status: "",
                            presets: "",
                            source: "",
                        },
                        status: {
                            sources: [],
                            managed: [],
                            presets: [],
                            plugins: [
                                {
                                    id: sourcePluginId,
                                    kind: "source",
                                    enabled: true,
                                },
                                {
                                    id: "middleware.first",
                                    name: "前处理",
                                    kind: "middleware",
                                    enabled: true,
                                },
                            ],
                        },
                    }}
                    schemas={{ [sourcePluginId]: sources[0]!.schema }}
                    presetPages={{}}
                    onClose={() => {}}
                    onSaved={() => {}}
                />,
                dom.root as unknown as HTMLElement,
            )
        );
        const dialog = find(dom.root, "dialog");
        const select = async (name: string, value: string) => {
            await dom.act(() =>
                find(dialog, `button[data-dropdown="${name}"]`).click()
            );
            await dom.act(() =>
                find(dialog, `button[role="option"][data-value="${value}"]`)
                    .click()
            );
        };
        await select("source-middleware-mode", "custom");
        await select("source-middleware-add", "middleware.first");
        await select("source-health-mode", "custom");
        await dom.act(() =>
            input(find(dialog, 'input[name="source-health-cooldown"]'), "1.25")
        );
        await dom.act(() => input(find(dialog, "input"), "主力渠道"));
        await dom.act(() => button(dialog, "下一步").click());
        await dom.act(() => button(dialog, "自定义配置").click());
        await dom.act(() =>
            input(
                find(dialog, 'input[name="baseUrl"]'),
                "https://provider.example/v1",
            )
        );
        await dom.act(() => button(dialog, "测试连接并获取模型").click());
        await dom.act(() => button(dialog, "保存渠道").click());
        assertEquals(requests.map((request) => request.path), [
            "/api/admin/source-draft-probe",
            "/api/admin/sources",
        ]);
        assertEquals(requests[0]?.body.middleware, undefined);
        assertEquals(requests[1]?.body.middleware, ["middleware.first"]);
        assertEquals(requests[0]?.body.healthPolicy, { cooldownMs: 1250 });
        assertEquals(requests[1]?.body.healthPolicy, { cooldownMs: 1250 });
        assertEquals(
            (requests[1]?.body.config as Record<string, unknown>).healthPolicy,
            undefined,
        );
        assertEquals(
            (requests[1]?.body.config as Record<string, unknown>).middleware,
            undefined,
        );
        assertEquals(dom.navigation, []);
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        configureAdminTransport();
        dom.restore();
    }
});

Deno.test("custom configuration validates in place, preserves failed input and prevents duplicate saves", async () => {
    const pending = deferred();
    const test = await setup({ onSave: () => pending.promise });
    try {
        await test.details();
        await test.act(() => button(test.dialog, "自定义配置").click());
        await test.act(() => button(test.dialog, "保存渠道").click());
        const url = find(test.dialog, 'input[name="baseUrl"]');
        assertEquals(url.getAttribute("aria-invalid"), "true");
        assertStrictEquals(test.document.activeElement, url);
        assertEquals(test.saved, []);
        await test.act(() => input(url, "https://api.example.test/v1"));
        await test.act(() =>
            input(find(test.dialog, 'input[name="apiKey"]'), "custom-secret")
        );
        await test.act(() => button(test.dialog, "保存渠道").click());
        assertEquals(test.dialog.getAttribute("aria-busy"), "true");
        assert(button(test.dialog, "关闭").disabled);
        assert(button(test.dialog, "上一步").disabled);
        await test.act(() => {
            find(test.dialog, "form").dispatchEvent(
                new CustomEvent("submit", { cancelable: true, detail: {} }),
            );
            test.dialog.dispatchEvent(
                new Event("cancel", { cancelable: true }),
            );
        });
        assertEquals(test.saved.length, 1);
        assertEquals(test.closes, 0);
        pending.reject(new Error("暂时无法保存"));
        await test.act();
        assertEquals(test.dialog.getAttribute("aria-busy"), "false");
        assertEquals(
            find(test.dialog, 'input[name="apiKey"]').value,
            "custom-secret",
        );
        assert(test.dialog.textContent.includes("暂时无法保存"));
        assertEquals(test.completed, []);
        assertEquals(test.navigation, []);
        assertEquals(test.storageWrites, []);
    } finally {
        await test.dispose();
    }
});

Deno.test("custom configuration creates a new source and closes the dialog after saving", async () => {
    const test = await setup();
    try {
        await test.act(() => {
            const trigger = find(
                test.dialog,
                'button[data-dropdown="source-proxy"]',
            );
            trigger.click();
        });
        await test.act(() =>
            find(
                test.dialog,
                'button[role="option"][data-value="direct"]',
            ).click()
        );
        await test.details();
        await test.act(() => button(test.dialog, "自定义配置").click());
        await test.act(() =>
            input(
                find(test.dialog, 'input[name="baseUrl"]'),
                "https://upstream.example.test/v1",
            )
        );
        await test.act(() =>
            input(
                find(test.dialog, 'input[name="apiKey"]'),
                "new-source-secret",
            )
        );
        await test.act(() => button(test.dialog, "保存渠道").click());
        assertEquals(test.saved.length, 1);
        const value = test.saved[0]!;
        assertEquals(value.sourcePluginId, sourcePluginId);
        assertEquals(value.draft.name, "主力模型");
        assertEquals(value.draft.priority, 17);
        assertEquals(value.draft.mode, "custom");
        assertEquals(value.draft.presetId, undefined);
        assertEquals(value.draft.proxy, { mode: "direct" });
        assertEquals(value.config.proxy, undefined);
        assertEquals(value.config.baseUrl, "https://upstream.example.test/v1");
        assertEquals(value.config.apiKey, "new-source-secret");
        assertEquals(test.completed, [value.draft]);
        assertEquals(test.closes, 1);
        assertEquals(test.root.querySelector("dialog"), null);
        assertEquals(test.navigation, []);
        assertEquals(test.storageWrites, []);
    } finally {
        await test.dispose();
    }
});

Deno.test("preset JSX validates, masks secrets and creates a source without navigation", async () => {
    const pending = deferred();
    const test = await setup({ onSave: () => pending.promise });
    try {
        await test.details();
        await test.act(() => button(test.dialog, "NewAPI").click());
        await test.act(() => button(test.dialog, "保存渠道").click());
        const url = find(test.dialog, 'input[name="baseUrl"]');
        assertEquals(url.getAttribute("aria-invalid"), "true");
        assertStrictEquals(test.document.activeElement, url);
        assertEquals(test.saved, []);
        await test.act(() => input(url, "https://newapi.example.test/v1/"));
        const secret = find(test.dialog, 'input[name="apiKey"]');
        await test.act(() => input(secret, "preset-secret"));
        assertEquals(secret.getAttribute("type"), "password");
        const visibility = find(
            test.dialog,
            'button[aria-label="显示访问令牌"]',
        );
        await test.act(() => visibility.click());
        assertEquals(secret.getAttribute("type"), "text");
        assertEquals(visibility.getAttribute("aria-pressed"), "true");
        await test.act(() => visibility.click());
        assertEquals(secret.getAttribute("type"), "password");
        assertEquals(visibility.getAttribute("aria-pressed"), "false");
        await test.act(() => button(test.dialog, "保存渠道").click());
        await test.act(() =>
            find(test.dialog, "form").dispatchEvent(
                new CustomEvent("submit", { cancelable: true, detail: {} }),
            )
        );
        assertEquals(test.saved.length, 1);
        const value = test.saved[0]!;
        assertEquals(value.draft.name, "主力模型");
        assertEquals(value.draft.priority, 17);
        assertEquals(value.draft.mode, "preset");
        assertEquals(value.draft.presetId, presetId);
        assertEquals(value.sourcePluginId, sourcePluginId);
        assertEquals(value.config, {
            id: value.draft.id,
            baseUrl: "https://newapi.example.test/v1",
            apiKey: "preset-secret",
        });
        assertEquals(test.dialog.getAttribute("aria-busy"), "true");
        pending.resolve();
        await test.act();
        assertEquals(test.root.querySelector("dialog"), null);
        assertEquals(test.completed, [value.draft]);
        assertEquals(test.closes, 1);
        assertEquals(test.lifecycle, { mounts: 1, cleanups: 1 });
        assertStrictEquals(test.document.activeElement, test.trigger);
        assertEquals(test.navigation, []);
        assertEquals(test.storageWrites, []);
    } finally {
        pending.resolve();
        await test.dispose();
    }
});

Deno.test("cancel and reopen drops custom credentials and creates a fresh dialog", async () => {
    const test = await setup();
    try {
        await test.details();
        await test.act(() => button(test.dialog, "自定义配置").click());
        await test.act(() =>
            input(find(test.dialog, 'input[name="apiKey"]'), "private-key")
        );
        await test.act(() =>
            test.dialog.dispatchEvent(new Event("cancel", { cancelable: true }))
        );
        assertEquals(test.root.querySelector("dialog"), null);
        assertEquals(test.saved, []);
        await test.act(() => test.trigger.click());
        const reopened = find(test.root, "dialog");
        assertNotStrictEquals(reopened, test.dialog);
        assertEquals(reopened.querySelectorAll("input")[0]!.value, "");
        await test.act(() =>
            input(reopened.querySelectorAll("input")[0]!, "再次创建")
        );
        await test.act(() => button(reopened, "下一步").click());
        await test.act(() => button(reopened, "自定义配置").click());
        assertEquals(find(reopened, 'input[name="apiKey"]').value, "");
        assertEquals(test.navigation, []);
        assertEquals(test.storageWrites, []);
    } finally {
        await test.dispose();
    }
});

Deno.test("dialog closes when the animation completion event is unavailable", async () => {
    const test = await setup({ reducedMotion: false });
    try {
        await test.act(() => button(test.dialog, "关闭").click());
        assertEquals(test.closes, 0);
        await new Promise((resolve) => setTimeout(resolve, 280));
        await test.act();
        assertEquals(test.closes, 1);
        assertEquals(test.root.querySelector("dialog"), null);
        assertStrictEquals(test.document.activeElement, test.trigger);
    } finally {
        await test.dispose();
    }
});

Deno.test("actual preset mount releases its feedback listener even when disposed before effects", async () => {
    for (const immediate of [false, true]) {
        const dom = installTestDom();
        const subscriptions: string[] = [];
        const add = dom.root.addEventListener.bind(dom.root);
        const remove = dom.root.removeEventListener.bind(dom.root);
        dom.root.addEventListener = (...args) => {
            if (args[0] === PRESET_UI_FEEDBACK_EVENT) subscriptions.push("add");
            add(...args);
        };
        dom.root.removeEventListener = (...args) => {
            if (args[0] === PRESET_UI_FEEDBACK_EVENT) {
                subscriptions.push("remove");
            }
            remove(...args);
        };
        let cleanup = () => {};
        try {
            const create = () => {
                cleanup = mount(dom.root as unknown as HTMLElement, {
                    draft: {
                        id: "temporary-source",
                        name: "临时配置",
                        priority: 0,
                    },
                    sourcePluginId,
                    presetId,
                });
                if (immediate) cleanup();
            };
            await dom.act(create);
            if (!immediate) {
                assertEquals(subscriptions, ["add"]);
                await dom.act(cleanup);
            }
            assertEquals(dom.root.querySelector("form"), null);
            assertEquals(subscriptions, ["add", "remove"]);
            await dom.act(cleanup);
            assertEquals(subscriptions, ["add", "remove"]);
        } finally {
            await dom.act(cleanup);
            dom.restore();
        }
    }
});

Deno.test("dialog waits for its own closing animation before unmounting preset JSX", async () => {
    const test = await setup({ reducedMotion: false });
    try {
        await test.details();
        await test.act(() => button(test.dialog, "NewAPI").click());
        await test.act(() => button(test.dialog, "关闭").click());
        assert(test.dialog.open);
        assert(test.dialog.getAttribute("class")?.includes("is-closing"));
        assertEquals(test.closes, 0);
        assertEquals(test.lifecycle.cleanups, 0);
        const unrelated = new Event("animationend");
        Object.defineProperty(unrelated, "animationName", {
            value: "source-step-in",
        });
        await test.act(() => test.dialog.dispatchEvent(unrelated));
        assertEquals(test.closes, 0);
        const ended = new Event("animationend");
        Object.defineProperty(ended, "animationName", {
            value: "source-dialog-out",
        });
        await test.act(() => test.dialog.dispatchEvent(ended));
        assertEquals(test.root.querySelector("dialog"), null);
        assertEquals(test.closes, 1);
        assertEquals(test.lifecycle.cleanups, 1);
    } finally {
        await test.dispose();
    }
});

Deno.test("custom draft tests current input, retries in place and saves selected models", async () => {
    const received: SourceSetupSaveInput[] = [];
    const test = await setup({
        onProbe: (value) => {
            received.push(value);
            return Promise.resolve({
                ok: received.length > 1,
                message: received.length > 1 ? "连接正常" : "连接失败，请重试",
                checkedAt: new Date().toISOString(),
                models: received.length > 1
                    ? ["model-a", "model-b"]
                    : undefined,
            });
        },
    });
    try {
        await test.details();
        await test.act(() => button(test.dialog, "自定义配置").click());
        await test.act(() => button(test.dialog, "测试连接").click());
        assertEquals(received.length, 0);
        await test.act(() =>
            input(
                find(test.dialog, 'input[name="baseUrl"]'),
                "https://provider.example/v1",
            )
        );
        await test.act(() =>
            input(find(test.dialog, 'input[name="apiKey"]'), "draft-secret")
        );
        await test.act(() => button(test.dialog, "测试连接").click());
        assert(test.dialog.textContent.includes("连接失败"));
        assertEquals(test.saved, []);
        assertEquals(received[0]?.config.apiKey, "draft-secret");
        await test.act(() => button(test.dialog, "重新测试连接").click());
        assertEquals(received.length, 2);
        await test.act(() => button(test.dialog, "model-a").click());
        assertEquals(
            button(test.dialog, "model-a").getAttribute("aria-pressed"),
            "true",
        );
        assertEquals(
            test.dialog.querySelector('textarea[name="modelMap"]'),
            null,
        );
        assertStrictEquals(find(test.root, "dialog"), test.dialog);
        await test.act(() => button(test.dialog, "保存渠道").click());
        assertEquals(test.saved[0]?.draft.modelMap, { "model-a": "model-a" });
        assertEquals(test.saved[0]?.config.modelMap, undefined);
        assertEquals(test.navigation, []);
        assertEquals(test.storageWrites, []);
    } finally {
        await test.dispose();
    }
});

Deno.test("editing and returning from draft configuration cancels probes and ignores late models", async () => {
    type ProbeResult = {
        ok: boolean;
        message: string;
        checkedAt: string;
        models: string[];
    };
    const calls: {
        signal: AbortSignal;
        resolve: (result: ProbeResult) => void;
    }[] = [];
    const test = await setup({
        onProbe: (_value, signal) =>
            new Promise((resolve) => calls.push({ signal, resolve })),
    });
    try {
        await test.details();
        await test.act(() => button(test.dialog, "自定义配置").click());
        const url = find(test.dialog, 'input[name="baseUrl"]');
        await test.act(() => input(url, "https://old.example/v1"));
        await test.act(() => button(test.dialog, "测试连接").click());
        assert(button(test.dialog, "保存渠道").disabled);
        await test.act(() => input(url, "https://new.example/v1"));
        assertEquals(calls[0]?.signal.aborted, true);
        await test.act(() => button(test.dialog, "测试连接").click());
        calls[1]!.resolve({
            ok: true,
            message: "新连接",
            checkedAt: new Date().toISOString(),
            models: ["new-model"],
        });
        await test.act();
        calls[0]!.resolve({
            ok: true,
            message: "过期连接",
            checkedAt: new Date().toISOString(),
            models: ["old-model"],
        });
        await test.act();
        assert(test.dialog.textContent.includes("new-model"));
        assert(!test.dialog.textContent.includes("old-model"));
        await test.act(() => button(test.dialog, "测试连接").click());
        await test.act(() => button(test.dialog, "上一步").click());
        assertEquals(calls[2]?.signal.aborted, true);
        calls[2]!.resolve({
            ok: true,
            message: "已退出",
            checkedAt: new Date().toISOString(),
            models: ["detached-model"],
        });
        await test.act();
        assert(!test.dialog.textContent.includes("detached-model"));
        assertEquals(test.saved, []);
        assertEquals(test.navigation, []);
    } finally {
        await test.dispose();
    }
});

Deno.test("NewAPI preset JSX tests and selects models through host JSON actions in the same dialog", async () => {
    const received: SourceSetupSaveInput[] = [];
    const test = await setup({
        onProbe: (value) => {
            received.push(value);
            return Promise.resolve({
                ok: true,
                message: "连接正常",
                checkedAt: new Date().toISOString(),
                models: ["preset-model"],
            });
        },
    });
    try {
        await test.details();
        await test.act(() => button(test.dialog, "NewAPI").click());
        await test.act(() =>
            input(
                find(test.dialog, 'input[name="baseUrl"]'),
                "https://preset.example/v1",
            )
        );
        await test.act(() =>
            input(find(test.dialog, 'input[name="apiKey"]'), "preset-secret")
        );
        await test.act(() => button(test.dialog, "测试连接").click());
        assertEquals(received[0]?.draft.presetId, presetId);
        assertEquals(received[0]?.config.apiKey, "preset-secret");
        assertEquals(test.saved, []);
        await test.act(() => button(test.dialog, "preset-model").click());
        assertEquals(
            button(test.dialog, "preset-model").getAttribute("aria-pressed"),
            "true",
        );
        await test.act(() => button(test.dialog, "校验配置").click());
        assert(test.dialog.textContent.includes("连接正常"));
        assertEquals(
            button(test.dialog, "preset-model").getAttribute("aria-pressed"),
            "true",
        );
        assertStrictEquals(find(test.root, "dialog"), test.dialog);
        await test.act(() => button(test.dialog, "保存渠道").click());
        assertEquals(test.saved[0]?.draft.modelMap, {
            "preset-model": "preset-model",
        });
        assertEquals(test.saved[0]?.config.modelMap, undefined);
        assertEquals(test.closes, 1);
        assertEquals(test.navigation, []);
        assertEquals(test.storageWrites, []);
    } finally {
        await test.dispose();
    }
});

Deno.test("preset model discovery immediately updates basic mapping rows without remounting or persisting credentials", async () => {
    const test = await setup({
        onProbe: () =>
            Promise.resolve({
                ok: true,
                message: "连接正常",
                checkedAt: new Date().toISOString(),
                models: ["preset-model"],
            }),
    });
    try {
        await test.details();
        await test.act(() => button(test.dialog, "NewAPI").click());
        await test.act(() =>
            input(
                find(test.dialog, 'input[name="baseUrl"]'),
                "https://preset.example/v1",
            )
        );
        await test.act(() =>
            input(find(test.dialog, 'input[name="apiKey"]'), "memory-only-key")
        );
        await test.act(() => button(test.dialog, "测试连接").click());
        await test.act(() => button(test.dialog, "preset-model").click());
        assertEquals(test.lifecycle.mounts, 1);
        assertEquals(
            find(test.dialog, 'input[name="apiKey"]').value,
            "memory-only-key",
        );
        await test.act(() => button(test.dialog, "上一步").click());
        await test.act(() => button(test.dialog, "上一步").click());
        assertEquals(
            find(test.dialog, 'input[name="model-alias-0"]').value,
            "preset-model",
        );
        await test.act(() =>
            input(find(test.dialog, 'input[name="model-alias-0"]'), "fast")
        );
        await test.act(() => button(test.dialog, "下一步").click());
        await test.act(() => button(test.dialog, "NewAPI").click());
        assertEquals(find(test.dialog, 'input[name="apiKey"]').value, "");
        await test.act(() =>
            input(
                find(test.dialog, 'input[name="baseUrl"]'),
                "https://preset.example/v1",
            )
        );
        await test.act(() => button(test.dialog, "保存渠道").click());
        assertEquals(test.saved[0]?.draft.modelMap, { fast: "preset-model" });
        assertEquals(test.saved[0]?.config.modelMap, undefined);
        assertEquals(test.storageWrites, []);
    } finally {
        await test.dispose();
    }
});

Deno.test("failed draft probes require an explicit skip save and keep configuration inside the dialog", async () => {
    for (const mode of ["自定义配置", "NewAPI"]) {
        for (const rejected of [false, true]) {
            const test = await setup({
                onProbe: () =>
                    rejected
                        ? Promise.reject(new Error("服务暂时不可用"))
                        : Promise.resolve({
                            ok: false,
                            message: "连接失败，请检查地址",
                            checkedAt: new Date().toISOString(),
                        }),
            });
            try {
                await test.details();
                await test.act(() => button(test.dialog, mode).click());
                await test.act(() =>
                    input(
                        find(test.dialog, 'input[name="baseUrl"]'),
                        "https://provider.example/v1",
                    )
                );
                await test.act(() =>
                    input(
                        find(test.dialog, 'input[name="apiKey"]'),
                        "draft-secret",
                    )
                );
                await test.act(() => button(test.dialog, "测试连接").click());
                if (mode === "NewAPI") {
                    await test.act(() =>
                        button(test.dialog, "校验配置").click()
                    );
                }
                assert(test.dialog.textContent.includes("连接测试未通过"));
                assert(!button(test.dialog, "重新测试连接").disabled);
                assertEquals(test.saved, []);
                assertStrictEquals(find(test.root, "dialog"), test.dialog);
                await test.act(() =>
                    button(test.dialog, "跳过测试并保存").click()
                );
                assertEquals(test.saved.length, 1);
                assertEquals(test.saved[0]?.config.apiKey, "draft-secret");
                assertEquals(
                    test.saved[0]?.config.baseUrl,
                    "https://provider.example/v1",
                );
                assertEquals(test.closes, 1);
                assertEquals(test.navigation, []);
                assertEquals(test.storageWrites, []);
            } finally {
                await test.dispose();
            }
        }
    }
});

Deno.test("a same-tick save cannot race a draft probe before the disabled state renders", async () => {
    let resolve!: (
        value: { ok: boolean; message: string; checkedAt: string },
    ) => void;
    const test = await setup({
        onProbe: () => new Promise((done) => resolve = done),
    });
    try {
        await test.details();
        await test.act(() => button(test.dialog, "自定义配置").click());
        await test.act(() =>
            input(
                find(test.dialog, 'input[name="baseUrl"]'),
                "https://provider.example/v1",
            )
        );
        await test.act(() => {
            button(test.dialog, "测试连接").click();
            button(test.dialog, "保存渠道").click();
        });
        assertEquals(test.saved, []);
        assert(button(test.dialog, "保存渠道").disabled);
        resolve({
            ok: true,
            message: "连接正常",
            checkedAt: new Date().toISOString(),
        });
        await test.act();
        await test.act(() => button(test.dialog, "保存渠道").click());
        assertEquals(test.saved.length, 1);
    } finally {
        resolve?.({
            ok: false,
            message: "结束测试",
            checkedAt: new Date().toISOString(),
        });
        await test.dispose();
    }
});

Deno.test("preset connection results survive save errors and are cleared when credentials change", async () => {
    const test = await setup({
        onProbe: () =>
            Promise.resolve({
                ok: true,
                message: "连接正常",
                checkedAt: new Date().toISOString(),
                models: ["discovered-model"],
            }),
        onSave: () => Promise.reject(new Error("save failed")),
    });
    try {
        await test.details();
        await test.act(() => button(test.dialog, "NewAPI").click());
        await test.act(() =>
            input(
                find(test.dialog, 'input[name="baseUrl"]'),
                "https://provider.example/v1",
            )
        );
        await test.act(() => button(test.dialog, "测试连接").click());
        await test.act(() => button(test.dialog, "保存渠道").click());
        assert(test.dialog.textContent.includes("保存失败"));
        assert(test.dialog.textContent.includes("连接正常"));
        assert(!button(test.dialog, "discovered-model").disabled);
        await test.act(() =>
            input(find(test.dialog, 'input[name="apiKey"]'), "new-secret")
        );
        assert(!test.dialog.textContent.includes("连接正常"));
        assert(!test.dialog.textContent.includes("discovered-model"));
        assert(test.dialog.textContent.includes("尚未测试连接"));
        assertEquals(test.closes, 0);
    } finally {
        await test.dispose();
    }
});
