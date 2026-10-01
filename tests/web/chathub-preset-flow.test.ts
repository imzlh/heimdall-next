import { assert, assertEquals, assertThrows } from "@std/assert";
import "hono/jsx/dom/jsx-runtime";
import {
    PRESET_UI_ACTION_EVENT,
    PRESET_UI_FEEDBACK_EVENT,
    type PresetJsonObject,
    type PresetUiContext,
} from "@heimdall/admin-contracts/preset-ui.ts";
import { mount } from "../../plugins/chathub-preset/ui.tsx";
import { mountPresetEditor } from "../../src/web/client/forms/preset-bridge.ts";
import { installTestDom, type TestElement } from "./helpers/jsx-dom.ts";
import type { SourceDraftProbeResult } from "@heimdall/admin-contracts/source-probe.ts";

const context: PresetUiContext = {
    draft: {
        id: "26b564ee-6c4b-4ccf-a60b-e15befb73641",
        name: "工作账号",
        priority: 3,
    },
    presetId: "heimdall.preset.chathub",
    sourcePluginId: "heimdall.source.chathub",
};
const state = "current-session";
const authUrl =
    `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=${state}`;
const callback =
    `https://login.microsoftonline.com/common/oauth2/nativeclient?code=private-code&state=${state}`;
const tokens = {
    ok: true,
    oid: "account-id",
    tid: "tenant-id",
    accessToken: "private-access-token",
    refreshToken: "private-refresh-token",
    email: "operator@example.test",
    expiresAt: "2026-09-25T18:00:00Z",
};

function button(root: TestElement, label: string): TestElement {
    const found = root.querySelectorAll("button").find((item) =>
        item.textContent.includes(label)
    );
    assert(found, `Missing button ${label}: ${root.textContent}`);
    return found;
}
function input(root: TestElement, name: string, value: string) {
    const field = root.querySelector(`input[name="${name}"]`);
    assert(field, `Missing input ${name}`);
    field.value = value;
    field.dispatchEvent(new Event("input"));
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => resolve = done);
    return { promise, resolve };
}

async function fixture(options: {
    fetch?: typeof fetch;
    save?: (config: PresetJsonObject) => Promise<void>;
    probe?: (config: PresetJsonObject) => Promise<SourceDraftProbeResult>;
} = {}) {
    const dom = installTestDom();
    const originalFetch = globalThis.fetch;
    const calls: RequestInit[] = [];
    const saves: PresetJsonObject[] = [];
    const previews: PresetJsonObject[] = [];
    globalThis.fetch = (url, init) => {
        assertEquals(url, "/admin/ui/request");
        calls.push(init!);
        return options.fetch ? options.fetch(url, init) : Promise.resolve(
            Response.json(
                calls.length === 1 ? { ok: true, authUrl, state } : tokens,
            ),
        );
    };
    const ready = deferred<void>();
    const dispose = mountPresetEditor(
        dom.root as unknown as HTMLElement,
        context,
        () => Promise.resolve({ mount }),
        {
            onSubmit: async (config) => {
                saves.push(config);
                await options.save?.(config);
            },
            onPreview: (config) => {
                previews.push(config);
                return Promise.resolve({ accessToken: "must-not-echo" });
            },
            onProbe: options.probe,
        },
        () => ready.resolve(),
        () => {
            throw new Error("Unexpected mount failure");
        },
    );
    await ready.promise;
    await dom.act();
    async function settle(callback: () => void = () => {}) {
        await dom.act(callback);
        for (let pass = 0; pass < 5; pass++) await dom.act();
    }
    return {
        ...dom,
        calls,
        saves,
        previews,
        settle,
        dispose,
        async authorize() {
            await settle(() => button(dom.root, "准备 Microsoft").click());
            await settle(() => input(dom.root, "callback", callback));
            await settle(() => button(dom.root, "完成授权").click());
            assert(dom.root.textContent.includes(tokens.email));
        },
        async close() {
            await dispose();
            await settle();
            globalThis.fetch = originalFetch;
            dom.restore();
        },
    };
}

Deno.test("ChatHub preset stays in place and waits for explicit login action", async () => {
    const test = await fixture();
    try {
        assertEquals(test.calls.length, 0);
        assertEquals(button(test.root, "保存渠道").disabled, true);
        await test.settle(() => {
            button(test.root, "准备 Microsoft").click();
            button(test.root, "准备 Microsoft").click();
        });
        assertEquals(test.calls.length, 1);
        const link = test.root.querySelector("a");
        assert(link);
        assertEquals(link.getAttribute("href"), authUrl);
        assertEquals(link.getAttribute("target"), "_blank");
        assertEquals(test.navigation, []);
        assertEquals(test.storageWrites, []);
        await test.settle(() =>
            input(
                test.root,
                "callback",
                callback.replace(state, "previous-session"),
            )
        );
        await test.settle(() => button(test.root, "完成授权").click());
        assert(test.root.textContent.includes("属于其他授权"));
        assertEquals(test.calls.length, 1);
        assertEquals(
            test.root.querySelector('input[name="callback"]')?.getAttribute(
                "aria-invalid",
            ),
            "true",
        );
    } finally {
        await test.close();
    }
});

Deno.test("ChatHub preset saves the draft identity, hides credentials and preserves default models", async () => {
    const pendingSave = deferred<void>();
    const test = await fixture({ save: () => pendingSave.promise });
    try {
        await test.authorize();
        assertEquals(test.root.querySelector('input[name="callback"]'), null);
        assert(!test.root.textContent.includes("private-"));
        await test.settle(() => button(test.root, "校验配置").click());
        assertEquals(test.previews.length, 1);
        assert(test.root.textContent.includes("校验通过"));
        assert(!test.root.textContent.includes("must-not-echo"));
        await test.settle(() => {
            button(test.root, "保存渠道").click();
            button(test.root, "保存渠道").click();
        });
        assertEquals(test.saves.length, 1);
        assertEquals(test.saves[0], {
            id: context.draft.id,
            oid: tokens.oid,
            tid: tokens.tid,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            accountEmail: tokens.email,
            expiresAt: tokens.expiresAt,
        });
        assertEquals(
            test.root.querySelector("form")?.getAttribute("aria-busy"),
            "true",
        );
        pendingSave.resolve();
        await test.settle();
        assert(test.root.textContent.includes("渠道已创建"));
        assertEquals(test.navigation, []);
        assertEquals(test.storageWrites, []);
    } finally {
        pendingSave.resolve();
        await test.close();
    }
});

Deno.test("ChatHub preset retains an authorized account after a failed save and clears it on reauthorization", async () => {
    let failures = 1;
    const test = await fixture({
        save: () =>
            failures--
                ? Promise.reject(new Error("private-server-error"))
                : Promise.resolve(),
    });
    try {
        await test.authorize();
        await test.settle(() => input(test.root, "models", "model-a, model-b"));
        await test.settle(() => button(test.root, "保存渠道").click());
        assertEquals(test.saves.length, 1);
        assertEquals(test.saves[0]!.models, ["model-a", "model-b"]);
        assert(test.root.textContent.includes(tokens.email));
        assert(!test.root.textContent.includes("private-server-error"));
        assertEquals(button(test.root, "保存渠道").disabled, false);
        await test.settle(() => button(test.root, "更换账号").click());
        assertEquals(button(test.root, "保存渠道").disabled, true);
        assert(!test.root.textContent.includes(tokens.email));
        assertEquals(test.storageWrites, []);
    } finally {
        await test.close();
    }
});

Deno.test("ChatHub preset aborts on unmount and ignores a late authorization response", async () => {
    const pending = deferred<Response>();
    const test = await fixture({ fetch: () => pending.promise });
    try {
        await test.settle(() => button(test.root, "准备 Microsoft").click());
        assertEquals(test.calls.length, 1);
        await test.dispose();
        assertEquals(test.calls[0]!.signal?.aborted, true);
        pending.resolve(Response.json({ ok: true, authUrl, state }));
        await test.settle();
        assertEquals(test.root.textContent, "");
        assertEquals(test.navigation, []);
        assertEquals(test.storageWrites, []);
    } finally {
        pending.resolve(Response.json({ ok: false }));
        await test.close();
    }
});

Deno.test("ChatHub preset replaces a consumed login session after an exchange failure", async () => {
    let requests = 0;
    const test = await fixture({
        fetch: () =>
            Promise.resolve(
                ++requests === 2
                    ? Response.json({ error: "private-provider-detail" }, {
                        status: 400,
                    })
                    : Response.json({ ok: true, authUrl, state }),
            ),
    });
    try {
        await test.settle(() => button(test.root, "准备 Microsoft").click());
        await test.settle(() => input(test.root, "callback", callback));
        await test.settle(() => button(test.root, "完成授权").click());
        assert(test.root.textContent.includes("重新准备授权"));
        assert(!test.root.textContent.includes("private-provider-detail"));
        assertEquals(test.root.querySelector('input[name="callback"]'), null);
        await test.settle(() => button(test.root, "准备 Microsoft").click());
        assertEquals(test.calls.length, 3);
        assertEquals(
            test.root.querySelector('input[name="callback"]')?.value,
            "",
        );
    } finally {
        await test.close();
    }
});

Deno.test("ChatHub preset rejects a different source and releases immediate feedback subscriptions", () => {
    const dom = installTestDom();
    try {
        const target = dom.root as unknown as HTMLElement;
        assertThrows(
            () =>
                mount(target, {
                    ...context,
                    sourcePluginId: "heimdall.source.other",
                }),
            TypeError,
        );
        let events = 0;
        target.addEventListener(PRESET_UI_ACTION_EVENT, () => events++);
        const dispose = mount(target, context);
        dispose();
        dispose();
        target.dispatchEvent(
            new CustomEvent(PRESET_UI_FEEDBACK_EVENT, {
                detail: { kind: "save", status: "success" },
            }),
        );
        assertEquals(events, 0);
        assertEquals(dom.root.textContent, "");
    } finally {
        dom.restore();
    }
});

Deno.test("ChatHub tests its authorized draft and includes selected discovered models when saving", async () => {
    const probes: PresetJsonObject[] = [];
    const test = await fixture({
        probe: (config) => {
            probes.push(config);
            return Promise.resolve({
                ok: true,
                message: "连接正常",
                checkedAt: new Date().toISOString(),
                models: ["chat-model"],
            });
        },
    });
    try {
        assert(button(test.root, "测试连接").disabled);
        await test.authorize();
        await test.settle(() => button(test.root, "测试连接").click());
        assertEquals(probes[0]?.accessToken, tokens.accessToken);
        assertEquals(test.saves, []);
        assert(!test.root.textContent.includes("private-access-token"));
        await test.settle(() => button(test.root, "校验配置").click());
        assert(test.root.textContent.includes("连接正常"));
        await test.settle(() => button(test.root, "chat-model").click());
        await test.settle(() => button(test.root, "保存渠道").click());
        assertEquals(test.saves[0]?.models, ["chat-model"]);
        assertEquals(test.navigation, []);
        assertEquals(test.storageWrites, []);
    } finally {
        await test.close();
    }
});

Deno.test("ChatHub keeps failed probe status through validation and allows an explicit skip save", async () => {
    const test = await fixture({
        probe: () => Promise.reject(new Error("private-provider-detail")),
    });
    try {
        await test.authorize();
        await test.settle(() => button(test.root, "测试连接").click());
        await test.settle(() => button(test.root, "校验配置").click());
        assert(test.root.textContent.includes("连接测试未通过"));
        assert(!test.root.textContent.includes("private-provider-detail"));
        assert(!button(test.root, "重新测试连接").disabled);
        assertEquals(test.saves, []);
        await test.settle(() => button(test.root, "跳过测试并保存").click());
        assertEquals(test.saves.length, 1);
        assertEquals(test.saves[0]?.accessToken, tokens.accessToken);
        assertEquals(test.navigation, []);
        assertEquals(test.storageWrites, []);
    } finally {
        await test.close();
    }
});

Deno.test("ChatHub clears the previous account probe when reauthorization starts", async () => {
    const test = await fixture({
        probe: () =>
            Promise.resolve({
                ok: true,
                message: "连接正常",
                checkedAt: new Date().toISOString(),
                models: ["previous-account-model"],
            }),
    });
    try {
        await test.authorize();
        await test.settle(() => button(test.root, "测试连接").click());
        assert(test.root.textContent.includes("previous-account-model"));
        await test.settle(() => button(test.root, "更换账号").click());
        assert(!test.root.textContent.includes("previous-account-model"));
        assert(!test.root.textContent.includes("连接正常"));
        assert(button(test.root, "保存渠道").disabled);
    } finally {
        await test.close();
    }
});
