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
function PluginFixture({ draft, controls, lifecycle }: {
    draft: SourceSetupDraft;
    controls: PresetFlowControls;
    lifecycle: { mounts: number; cleanups: number };
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
            },
            () => Promise.resolve({ mount }),
            {
                onSubmit: controls.onSave,
                onPreview: () => Promise.resolve(),
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
        reducedMotion?: boolean;
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
        assert(find(test.dialog, "select"));
        assertEquals(test.dialog.showModalCalls, 1);
        assertEquals(test.navigation, []);
        assertEquals(test.storageWrites, []);
    } finally {
        await test.dispose();
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
        await test.act(() => button(test.dialog, "显示").click());
        assertEquals(secret.getAttribute("type"), "text");
        await test.act(() => button(test.dialog, "隐藏").click());
        assertEquals(secret.getAttribute("type"), "password");
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
