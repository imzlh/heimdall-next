import {
    assert,
    assertEquals,
    assertFalse,
    assertStringIncludes,
    assertThrows,
} from "@std/assert";
import {
    isUiAction,
    isUiJsonObject,
    parseManifestUi,
    parseUiContributions,
    pluginNavItems,
    resolveUiRender,
    safeUiAssetPath,
    safeUiHref,
    selectUiContributions,
    UI_LIMITS,
    uiActionAllowed,
} from "@heimdall/admin-contracts/ui.ts";
import type {
    UiContext,
    UiContribution,
} from "@heimdall/admin-contracts/ui.ts";
import {
    PluginSlot,
    PluginSlots,
} from "@heimdall/core/web/components/slots.tsx";
import {
    uiFrameHeight,
    validateUiFrameMessage,
} from "@heimdall/core/web/client/extensions/bridge.ts";
import { mountUiModule } from "@heimdall/core/web/client/extensions/lifecycle.ts";
import type {
    TrustedUiModule,
    UiCleanup,
} from "@heimdall/core/web/client/extensions/lifecycle.ts";

const context: UiContext = { locale: "zh", theme: "system", data: {} };
function contribution(patch: Partial<UiContribution> = {}): UiContribution {
    return {
        pluginId: "chathub",
        id: "quota",
        slot: "dashboard.widget",
        title: "剩余额度",
        schema: {
            blocks: [{
                kind: "metric",
                label: "今日可用",
                value: 42,
                unit: "次",
                tone: "success",
            }],
        },
        ...patch,
    };
}

Deno.test("UI manifest registration binds namespaces and rejects invalid shapes", () => {
    assertEquals(parseManifestUi({ id: "chathub" }), []);
    assertEquals(
        parseManifestUi({
            id: "chathub",
            trust: "trusted",
            ui: [contribution()],
        }),
        [contribution()],
    );
    assertThrows(
        () => parseManifestUi({ id: "other", ui: [contribution()] }),
        TypeError,
    );
    assertThrows(
        () => parseUiContributions([contribution(), contribution()]),
        TypeError,
    );
    assertThrows(
        () =>
            parseUiContributions(
                Array.from({ length: UI_LIMITS.contributions + 1 }, () =>
                    contribution()),
            ),
        TypeError,
    );
    assertThrows(
        () => parseUiContributions([contribution({ slot: "source.status" })]),
        TypeError,
    );
    assertThrows(
        () => parseUiContributions([contribution({ title: "a".repeat(81) })]),
        TypeError,
    );
    assertThrows(
        () =>
            parseUiContributions([{
                ...contribution(),
                schema: {
                    blocks: [{
                        kind: "html",
                        html: "<script>alert(1)</script>",
                    }],
                },
            }]),
        TypeError,
    );
    assertThrows(
        () => parseUiContributions([{ ...contribution(), callback: () => {} }]),
        TypeError,
    );
});

Deno.test("UI JSON boundary rejects oversized, cyclic, prototype and non-finite payloads", () => {
    assert(isUiJsonObject({ values: [1, true, null, "状态"] }));
    assertFalse(isUiJsonObject({ value: Number.NaN }));
    assertFalse(isUiJsonObject({ value: new Date() }));
    assertFalse(isUiJsonObject(JSON.parse('{"__proto__":{"admin":true}}')));
    assertFalse(isUiJsonObject({ text: "界".repeat(UI_LIMITS.jsonBytes / 2) }));
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    assertFalse(isUiJsonObject(cycle));
    let repeated: unknown = "leaf";
    for (let depth = 0; depth < 5; depth++) {
        repeated = Array(128).fill(repeated);
    }
    assertFalse(isUiJsonObject({ repeated }));
    assertFalse(
        isUiAction({ id: "refresh", payload: {}, endpoint: "/admin/danger" }),
    );
});

Deno.test("UI manifest parser copies validated data before caller mutation", () => {
    const raw = JSON.parse(JSON.stringify([contribution()]));
    const parsed = parseUiContributions(raw);
    raw[0].schema.blocks[0].value = 0;
    assertEquals(parsed[0]?.schema.blocks[0], contribution().schema.blocks[0]);
});

Deno.test("UI executable modes require exact host allowlist regardless of manifest trust", () => {
    const trusted = contribution({
        render: {
            kind: "trusted",
            modulePath: "/admin/assets/plugins/chathub/quota.js",
        },
    });
    assertEquals(resolveUiRender(trusted), { kind: "schema" });
    assertEquals(
        resolveUiRender(trusted, {
            trustedModules: {
                "other:quota": trusted.render!.kind === "trusted"
                    ? trusted.render!.modulePath
                    : "",
            },
        }),
        { kind: "schema" },
    );
    assertEquals(
        resolveUiRender(trusted, {
            trustedModules: {
                "chathub:quota": "/admin/assets/plugins/chathub/quota.js",
            },
        }),
        trusted.render,
    );
    assertEquals(
        resolveUiRender(trusted, {
            trustedModules: {
                "chathub:quota": "/admin/assets/plugins/chathub/other.js",
            },
        }),
        { kind: "schema" },
    );
    const sandbox = contribution({
        render: {
            kind: "sandbox",
            documentPath: "/admin/assets/plugins/chathub/quota.html",
        },
    });
    assertEquals(resolveUiRender(sandbox), { kind: "schema" });
    assertEquals(
        resolveUiRender(sandbox, {
            sandboxDocuments: {
                "chathub:quota": "/admin/assets/plugins/chathub/quota.html",
            },
        }),
        sandbox.render,
    );
});

Deno.test("UI asset paths and schema links reject external origins, APIs and traversal", () => {
    assert(safeUiAssetPath("/admin/assets/plugins/chathub/quota.js", "js"));
    for (
        const path of [
            "https://evil.invalid/plugin.js",
            "//evil.invalid/plugin.js",
            "/admin/assets/plugins/../secret.js",
            "/admin/assets/plugins/%2e%2e/secret.js",
            "/admin/assets/plugins/a//b.js",
            "/admin/assets/plugins/a.js?next=evil",
            "/admin/assets/plugins/a.html",
        ]
    ) {
        assertFalse(safeUiAssetPath(path, "js"), path);
    }
    assert(safeUiHref("/admin?view=channels"));
    assert(safeUiHref("/admin?view=plugin&tab=chathub%3Aquota"));
    assert(safeUiHref("#quota"));
    for (
        const href of [
            "javascript:alert(1)",
            "https://evil.invalid",
            "//evil.invalid",
            "/admin/sources/delete",
            "/admin?view=settings&next=https://evil.invalid",
            "/admin?view=settings&view=plugin",
            "/admin\\evil",
            "/admin?view=unknown",
        ]
    ) {
        assertFalse(safeUiHref(href), href);
    }
});

Deno.test("UI action dispatch requires host authorization for contribution and action", () => {
    const action = { id: "quota.refresh", payload: { sourceId: "primary" } };
    assertFalse(uiActionAllowed(contribution(), action));
    const policy = { allowedActions: { "chathub:quota": ["quota.refresh"] } };
    assert(uiActionAllowed(contribution(), action, policy));
    assertFalse(
        uiActionAllowed(
            contribution(),
            { ...action, id: "source.delete" },
            policy,
        ),
    );
    assertFalse(
        uiActionAllowed(contribution({ pluginId: "other" }), action, policy),
    );
    assertFalse(
        uiActionAllowed(contribution(), {
            ...action,
            payload: { callback: () => {} },
        }, policy),
    );
});

Deno.test("UI slots order deterministically and filter exact source plugin identity", () => {
    const values = [
        contribution({ id: "z", order: 2 }),
        contribution({ id: "a", order: 1 }),
        contribution({ id: "b", order: 1 }),
        contribution({
            id: "status",
            slot: "source.status",
            sourcePluginId: "chathub",
        }),
    ];
    assertEquals(
        selectUiContributions(values, "dashboard.widget").map((item) =>
            item.id
        ),
        ["a", "b", "z"],
    );
    assertEquals(selectUiContributions(values, "source.status", context), []);
    assertEquals(
        selectUiContributions(values, "source.status", {
            ...context,
            sourcePluginId: "other",
        }),
        [],
    );
    assertEquals(
        selectUiContributions(values, "source.status", {
            ...context,
            sourcePluginId: "chathub",
            sourceId: "production",
        }).map((item) => item.id),
        ["status"],
    );
    assertEquals(pluginNavItems([contribution({ slot: "nav.tab" })]), [{
        id: "chathub:quota",
        label: "剩余额度",
        href: "/admin?view=plugin&tab=chathub%3Aquota",
    }]);
});

Deno.test("UI SSR renders useful escaped fallback and disabled actions for every trust level", () => {
    const item = contribution({
        title: "额度 <script>",
        description: "当前状态",
        render: {
            kind: "sandbox",
            documentPath: "/admin/assets/plugins/chathub/quota.html",
        },
        schema: {
            blocks: [{ kind: "metric", label: "热上下文", value: 12 }, {
                kind: "text",
                text: "<img src=x onerror=alert(1)>",
            }, {
                kind: "action",
                label: "刷新",
                action: { id: "refresh", payload: {} },
            }],
        },
    });
    const html = (<PluginSlot
        contribution={item}
        context={context}
        policy={{
            sandboxDocuments: {
                "chathub:quota": "/admin/assets/plugins/chathub/quota.html",
            },
        }}
    />).toString();
    assertStringIncludes(html, "额度 &lt;script&gt;");
    assertStringIncludes(html, "热上下文");
    assertStringIncludes(html, "<dd><strong>12</strong></dd>");
    assertStringIncludes(html, "&lt;img src=x onerror=alert(1)&gt;");
    assertStringIncludes(html, 'data-ui-mode="sandbox"');
    assertStringIncludes(html, "disabled");
    assertStringIncludes(html, "启用 JavaScript 后可执行插件操作。");
    assertFalse(html.includes("<iframe"));
    assertFalse(html.includes("<script"));
    assertEquals(
        (<PluginSlots
            slot="settings.section"
            contributions={[]}
            context={context}
        />).toString(),
        "",
    );
});

Deno.test("UI iframe messages require opaque origin, source identity, nonce and exact protocol", () => {
    const source = {} as Window;
    const ready = {
        protocol: "heimdall.ui",
        version: 1,
        instance: "unique-token",
        kind: "ready",
    } as const;
    const event = { source, origin: "null", data: ready };
    assertEquals(validateUiFrameMessage(event, source, "unique-token"), ready);
    assertEquals(
        validateUiFrameMessage(
            { ...event, source: {} as Window },
            source,
            "unique-token",
        ),
        null,
    );
    assertEquals(validateUiFrameMessage(event, null, "unique-token"), null);
    assertEquals(
        validateUiFrameMessage(
            { ...event, origin: "https://heimdall.invalid" },
            source,
            "unique-token",
        ),
        null,
    );
    assertEquals(validateUiFrameMessage(event, source, "stale-token"), null);
    assertEquals(
        validateUiFrameMessage(
            { ...event, data: { ...ready, version: 2 } },
            source,
            "unique-token",
        ),
        null,
    );
    assertEquals(
        validateUiFrameMessage(
            { ...event, data: { ...ready, unexpected: true } },
            source,
            "unique-token",
        ),
        null,
    );
    const action = {
        ...ready,
        kind: "action",
        action: { id: "refresh", payload: {} },
    } as const;
    assertEquals(
        validateUiFrameMessage(
            { ...event, data: action },
            source,
            "unique-token",
        ),
        action,
    );
    assertEquals(
        validateUiFrameMessage(
            {
                ...event,
                data: {
                    ...action,
                    action: { id: "refresh", payload: { value: Infinity } },
                },
            },
            source,
            "unique-token",
        ),
        null,
    );
});

Deno.test("UI iframe height requests cannot escape the host allocation", () => {
    assertEquals(uiFrameHeight(0), 96);
    assertEquals(uiFrameHeight(9000), 480);
    assertEquals(uiFrameHeight(240.4), 240);
    assertEquals(uiFrameHeight(Number.NaN), 96);
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

Deno.test("UI trusted async mount cleans up after unmount even when mount resolves late", async () => {
    const mounted = deferred<void>();
    const pending = deferred<void | UiCleanup>();
    const released = deferred<void>();
    let ready = 0;
    let cleanupCount = 0;
    const dispose = mountUiModule(
        () =>
            Promise.resolve({
                mount() {
                    mounted.resolve();
                    return pending.promise;
                },
            }),
        {} as HTMLElement,
        context,
        () => {
            ready++;
        },
        () => {
            throw new Error("unexpected mount error");
        },
    );
    await mounted.promise;
    await dispose();
    pending.resolve(() => {
        cleanupCount++;
        released.resolve();
    });
    await released.promise;
    await dispose();
    assertEquals(ready, 0);
    assertEquals(cleanupCount, 1);
});

Deno.test("UI trusted module is never mounted if its download completes after disposal", async () => {
    const pending = deferred<TrustedUiModule>();
    let mounted = 0;
    let ready = 0;
    const dispose = mountUiModule(
        () => pending.promise,
        {} as HTMLElement,
        context,
        () => {
            ready++;
        },
        () => {},
    );
    await dispose();
    pending.resolve({
        mount() {
            mounted++;
        },
    });
    await pending.promise;
    assertEquals(mounted, 0);
    assertEquals(ready, 0);
});

Deno.test("UI trusted mount errors preserve fallback instead of signalling readiness", async () => {
    const reported = deferred<void>();
    let ready = false;
    const dispose = mountUiModule(
        () =>
            Promise.resolve({
                mount() {
                    throw new Error("plugin failed");
                },
            }),
        {} as HTMLElement,
        context,
        () => {
            ready = true;
        },
        () => reported.resolve(),
    );
    await reported.promise;
    assertFalse(ready);
    await dispose();
});
