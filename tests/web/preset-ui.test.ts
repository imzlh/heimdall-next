import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
    parsePresetUiAction,
    parsePresetUiContext,
    parsePresetUiFeedback,
    PRESET_UI_ACTION_EVENT,
    PRESET_UI_FEEDBACK_EVENT,
    PRESET_UI_LIMITS,
    type PresetJsonObject,
    type PresetUiContext,
    type PresetUiFeedback,
} from "@heimdall/admin-contracts/preset-ui.ts";
import {
    mountPresetEditor,
    type PresetUiCleanup,
    type PresetUiModule,
} from "@heimdall/core/web/client/forms/preset-bridge.ts";
import { validatePluginManifest } from "@heimdall/plugin-host/manifest.ts";
import newapiManifest from "../../plugins/newapi-preset/manifest.json" with {
    type: "json",
};

const context: PresetUiContext = {
    draft: { name: "工作渠道", priority: 7, id: "new-source" },
    sourcePluginId: "heimdall.source.openai",
    presetId: "heimdall.preset.newapi",
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function element(): HTMLElement {
    // The bridge uses native EventTarget only; rendering belongs to the browser.
    return new EventTarget() as HTMLElement;
}

function send(target: HTMLElement, detail: unknown) {
    target.dispatchEvent(new CustomEvent(PRESET_UI_ACTION_EVENT, { detail }));
}

function terminalFeedback(target: HTMLElement): Promise<PresetUiFeedback> {
    return new Promise((resolve) => {
        const receive = (event: Event) => {
            const value = parsePresetUiFeedback((event as CustomEvent).detail);
            if (value.status === "pending") return;
            target.removeEventListener(PRESET_UI_FEEDBACK_EVENT, receive);
            resolve(value);
        };
        target.addEventListener(PRESET_UI_FEEDBACK_EVENT, receive);
    });
}

Deno.test("preset UI context is detached identity data and rejects host credentials", () => {
    const parsed = parsePresetUiContext(context);
    assertEquals(parsed, context);
    assert(parsed !== context && parsed.draft !== context.draft);
    for (
        const value of [
            { ...context, adminToken: "secret" },
            { ...context, config: { apiKey: "saved-secret" } },
            { ...context, draft: { ...context.draft, priority: 0.5 } },
            { ...context, draft: { ...context.draft, name: "" } },
            { ...context, sourcePluginId: "../plugin" },
            { ...context, presetId: "plugin-" },
        ]
    ) assertThrows(() => parsePresetUiContext(value), TypeError);
});

Deno.test("preset UI action copies JSON without invoking getters or toJSON", () => {
    const config = {
        baseUrl: "https://newapi.test/v1",
        modelMap: { local: "upstream" },
    };
    const action = parsePresetUiAction({ kind: "save", config });
    config.modelMap.local = "changed";
    assertEquals(action.config.modelMap, { local: "upstream" });
    let calls = 0;
    const executable = {
        get apiKey() {
            calls++;
            return "secret";
        },
    };
    for (
        const invalid of [
            { kind: "fetch", config: {} },
            { kind: "save", config: [], url: "/admin/settings" },
            { kind: "save", config: executable },
            {
                kind: "save",
                config: {
                    toJSON() {
                        calls++;
                        return {};
                    },
                },
            },
            { kind: "save", config: { callback: () => {} } },
            { kind: "save", config: { bad: Infinity } },
            { kind: "save", config: JSON.parse('{"__proto__":{}}') },
            {
                kind: "save",
                config: { huge: "界".repeat(PRESET_UI_LIMITS.actionBytes / 2) },
            },
        ]
    ) assertThrows(() => parsePresetUiAction(invalid), TypeError);
    assertEquals(calls, 0);
});

Deno.test("preset feedback contains bounded statuses and field errors without config echo", () => {
    assertEquals(
        parsePresetUiFeedback({
            kind: "preview",
            status: "error",
            errors: { baseUrl: "地址无效" },
        }),
        {
            kind: "preview",
            status: "error",
            errors: { baseUrl: "地址无效" },
        },
    );
    for (
        const invalid of [
            { kind: "save", status: "saved" },
            { kind: "save", status: "success", config: { apiKey: "secret" } },
            {
                kind: "save",
                status: "error",
                errors: { baseUrl: { message: "no" } },
            },
        ]
    ) assertThrows(() => parsePresetUiFeedback(invalid), TypeError);
});

Deno.test("preset bridge dispatches one host save and prevents duplicate submissions", async () => {
    const target = element();
    const ready = deferred<void>();
    const submitted = deferred<void>();
    const pending = deferred<void>();
    const feedback: PresetUiFeedback[] = [];
    target.addEventListener(PRESET_UI_FEEDBACK_EVENT, (event) => {
        feedback.push(parsePresetUiFeedback((event as CustomEvent).detail));
    });
    const received: PresetJsonObject[] = [];
    const dispose = mountPresetEditor(
        target,
        context,
        () => Promise.resolve({ mount() {} }),
        {
            onSubmit: async (config) => {
                received.push(config);
                submitted.resolve();
                await pending.promise;
            },
        },
        () => ready.resolve(),
        () => {
            throw new Error("unexpected load failure");
        },
    );
    await ready.promise;
    const action = {
        kind: "save",
        config: { baseUrl: "https://newapi.test/v1" },
    };
    const finished = terminalFeedback(target);
    send(target, action);
    send(target, action);
    await submitted.promise;
    action.config.baseUrl = "mutated";
    assertEquals(received, [{ baseUrl: "https://newapi.test/v1" }]);
    pending.resolve();
    assertEquals((await finished).status, "success");
    send(target, action);
    assertEquals(received.length, 1);
    assertEquals(feedback.map((entry) => entry.status), ["pending", "success"]);
    await dispose();
});

Deno.test("preset bridge rejects malformed events and reports host failures without leaking errors", async () => {
    const target = element();
    const ready = deferred<void>();
    let calls = 0;
    const dispose = mountPresetEditor(
        target,
        context,
        () => Promise.resolve({ mount() {} }),
        {
            onSubmit: () => {
                calls++;
                return Promise.reject(new Error("secret-server-credential"));
            },
        },
        () => ready.resolve(),
        () => {},
    );
    await ready.promise;
    let finished = terminalFeedback(target);
    send(target, { kind: "delete", config: {} });
    assertEquals((await finished).status, "error");
    assertEquals(calls, 0);
    finished = terminalFeedback(target);
    send(target, { kind: "save", config: {} });
    const failure = await finished;
    assertEquals(failure.status, "error");
    assert(!JSON.stringify(failure).includes("secret-server-credential"));
    assertEquals(calls, 1);
    await dispose();
});

Deno.test("preset bridge preview does not persist and host results are not echoed", async () => {
    const target = element();
    const ready = deferred<void>();
    let saves = 0;
    let previews = 0;
    const dispose = mountPresetEditor(
        target,
        context,
        () => Promise.resolve({ mount() {} }),
        {
            onSubmit: () => {
                saves++;
                return Promise.resolve();
            },
            onPreview: () => {
                previews++;
                return Promise.resolve({ apiKey: "never-echo" });
            },
        },
        () => ready.resolve(),
        () => {},
    );
    await ready.promise;
    const finished = terminalFeedback(target);
    send(target, { kind: "preview", config: {} });
    assertEquals(await finished, { kind: "preview", status: "success" });
    assertEquals({ saves, previews }, { saves: 0, previews: 1 });
    await dispose();
});

Deno.test("preset bridge releases a late asynchronous mount exactly once", async () => {
    const target = element();
    const mounted = deferred<void>();
    const pending = deferred<PresetUiCleanup>();
    const released = deferred<void>();
    let cleanups = 0;
    let ready = 0;
    const dispose = mountPresetEditor(
        target,
        context,
        () =>
            Promise.resolve({
                mount() {
                    mounted.resolve();
                    return pending.promise;
                },
            }),
        { onSubmit: () => Promise.resolve() },
        () => {
            ready++;
        },
        () => {},
    );
    await mounted.promise;
    await dispose();
    pending.resolve(() => {
        cleanups++;
        released.resolve();
    });
    await released.promise;
    await dispose();
    assertEquals({ cleanups, ready }, { cleanups: 1, ready: 0 });
});

Deno.test("preset bridge cancels pending loads and ignores events after disposal", async () => {
    const target = element();
    const pending = deferred<PresetUiModule>();
    let mounts = 0;
    let actions = 0;
    const dispose = mountPresetEditor(
        target,
        context,
        () => pending.promise,
        {
            onSubmit: () => {
                actions++;
                return Promise.resolve();
            },
        },
        () => {},
        () => {},
    );
    await dispose();
    pending.resolve({
        mount() {
            mounts++;
        },
    });
    await pending.promise;
    await Promise.resolve();
    send(target, { kind: "save", config: {} });
    assertEquals({ mounts, actions }, { mounts: 0, actions: 0 });
});

Deno.test("preset bridge reports mount failures and disables further actions", async () => {
    const target = element();
    const reported = deferred<void>();
    let actions = 0;
    let ready = 0;
    const dispose = mountPresetEditor(
        target,
        context,
        () =>
            Promise.resolve({
                mount() {
                    throw new Error("broken plugin");
                },
            }),
        {
            onSubmit: () => {
                actions++;
                return Promise.resolve();
            },
        },
        () => {
            ready++;
        },
        () => reported.resolve(),
    );
    await reported.promise;
    send(target, { kind: "save", config: {} });
    assertEquals({ ready, actions }, { ready: 0, actions: 0 });
    await dispose();
});

Deno.test("preset bridge suppresses feedback when an in-flight save outlives its page", async () => {
    const target = element();
    const ready = deferred<void>();
    const saved = deferred<void>();
    let feedbackCount = 0;
    target.addEventListener(PRESET_UI_FEEDBACK_EVENT, () => {
        feedbackCount++;
    });
    const dispose = mountPresetEditor(
        target,
        context,
        () => Promise.resolve({ mount() {} }),
        {
            onSubmit: () => saved.promise,
        },
        () => ready.resolve(),
        () => {},
    );
    await ready.promise;
    send(target, { kind: "save", config: {} });
    assertEquals(feedbackCount, 1);
    await dispose();
    saved.resolve();
    await saved.promise;
    assertEquals(feedbackCount, 1);
});

Deno.test("preset page manifest metadata is detached, frozen and restricted to preset modules", async () => {
    const manifest = validatePluginManifest(newapiManifest);
    assertEquals(manifest.presetPage, {
        modulePath: "/admin/assets/plugins/newapi-setup.js",
    });
    assert(manifest.presetPage !== newapiManifest.presetPage);
    assert(Object.isFrozen(manifest.presetPage));
    assertEquals(manifest.trust, "trusted");
    for (
        const value of [
            { ...newapiManifest, kind: "source" },
            {
                ...newapiManifest,
                presetPage: { modulePath: "https://remote.test/ui.js" },
            },
            {
                ...newapiManifest,
                presetPage: {
                    modulePath: "/admin/assets/plugins/../secret.js",
                },
            },
            {
                ...newapiManifest,
                presetPage: { modulePath: "/admin/assets/plugins/%2e/ui.js" },
            },
            {
                ...newapiManifest,
                presetPage: { modulePath: "/admin/assets/plugins/ui.html" },
            },
            {
                ...newapiManifest,
                presetPage: {
                    modulePath: "/admin/assets/plugins/ui.js",
                    trusted: true,
                },
            },
        ]
    ) {
        await assertRejects(() =>
            Promise.resolve().then(() => validatePluginManifest(value))
        );
    }
});

Deno.test("preset probe results are bounded JSON and cancellation releases a pending plugin action", async () => {
    const result = {
        ok: true,
        message: "连接正常",
        checkedAt: new Date().toISOString(),
        models: ["a", "b"],
    };
    assertEquals(
        parsePresetUiAction({ kind: "probe", config: { apiKey: "secret" } })
            .kind,
        "probe",
    );
    assertEquals(
        parsePresetUiFeedback({
            kind: "probe",
            status: "success",
            probe: result,
        }).probe,
        result,
    );
    for (
        const probe of [{ ...result, config: { apiKey: "secret" } }, {
            ...result,
            checkedAt: "invalid",
        }, { ...result, models: Array(257).fill("a") }]
    ) {
        assertThrows(
            () =>
                parsePresetUiFeedback({
                    kind: "probe",
                    status: "success",
                    probe,
                }),
            TypeError,
        );
    }
    const target = element();
    const ready = deferred<void>();
    const pending = deferred<typeof result>();
    let signal: AbortSignal | undefined;
    let feedbackCount = 0;
    target.addEventListener(PRESET_UI_FEEDBACK_EVENT, () => feedbackCount++);
    const dispose = mountPresetEditor(
        target,
        context,
        () => Promise.resolve({ mount() {} }),
        {
            onSubmit: () => Promise.resolve(),
            onProbe: (_config, operationSignal) => {
                signal = operationSignal;
                return pending.promise;
            },
        },
        () => ready.resolve(),
        () => {},
    );
    await ready.promise;
    send(target, { kind: "probe", config: {} });
    assertEquals(feedbackCount, 1);
    await dispose();
    assertEquals(signal?.aborted, true);
    pending.resolve(result);
    await pending.promise;
    assertEquals(feedbackCount, 1);
});
