import { assert, assertEquals, assertFalse } from "@std/assert";
import type { PluginDto } from "@heimdall/admin-contracts";
import type {
    UiContribution,
    UiJsonObject,
} from "@heimdall/admin-contracts/ui.ts";
import {
    createServerApp,
    type ServerApp,
    type ServerAppOptions,
} from "@heimdall/core/http/app.ts";
import type { UiActionInput } from "@heimdall/core/web/server/ui-actions.ts";

const origin = "https://console.example.test";
const plugin: PluginDto = {
    id: "sample",
    name: "状态扩展",
    kind: "ui",
    version: "1",
    trust: "trusted",
    enabled: true,
};
const contribution: UiContribution = {
    pluginId: "sample",
    id: "quota",
    slot: "dashboard.widget",
    title: "剩余额度",
    schema: {
        blocks: [{
            kind: "action",
            label: "刷新",
            action: { id: "refresh", payload: {} },
        }],
    },
};
const sourceContribution: UiContribution = {
    ...contribution,
    id: "source-quota",
    slot: "source.status",
    sourcePluginId: "provider",
};

function createApp(options: ServerAppOptions = {}): ServerApp {
    return createServerApp({
        adminCatalog: { plugins: [plugin] },
        adminUiContributions: [contribution, sourceContribution],
        adminUiPolicy: {
            allowedActions: {
                "sample:quota": ["refresh"],
                "sample:source-quota": ["refresh"],
            },
        },
        adminUiActions: { refresh: () => ({ refreshed: true }) },
        adminUiSourcePlugins: {
            "channel-a": "provider",
            "channel-b": "another-provider",
        },
        ...options,
    });
}

function invoke(
    app: ServerApp,
    input: unknown = {
        contributionId: "sample:quota",
        action: { id: "refresh", payload: {} },
    },
    headers?: HeadersInit,
) {
    const requestHeaders = new Headers(headers);
    if (!requestHeaders.has("origin")) requestHeaders.set("origin", origin);
    if (!requestHeaders.has("content-type")) {
        requestHeaders.set("content-type", "application/json");
    }
    return app.request(`${origin}/admin/ui/action`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(input),
    });
}

Deno.test("plugin UI action invokes only the host registry and reconstructs JSON context", async () => {
    let received: UiActionInput | undefined;
    let backendMutations = 0;
    const app = createApp({
        adminUiActions: {
            refresh(input) {
                received = input;
                return { remaining: 42 };
            },
        },
        adminManagement: {
            saveSettings() {
                backendMutations++;
                return { data: {} };
            },
        },
    });
    const response = await invoke(app, {
        contributionId: "sample:quota",
        action: { id: "refresh", payload: { range: "today" } },
        theme: "dark",
    });
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { data: { remaining: 42 } });
    assertEquals(response.headers.get("cache-control"), "no-store");
    assert(received !== undefined);
    assertEquals(received.contribution, contribution);
    assertEquals(received.action, {
        id: "refresh",
        payload: { range: "today" },
    });
    assertEquals(received.context, { locale: "zh", theme: "dark", data: {} });
    assert(received.requestId.length > 0);
    assertEquals(
        JSON.parse(JSON.stringify(received.context)),
        received.context,
    );
    assertEquals(backendMutations, 0);
});

Deno.test("plugin UI actions require declaration, host policy, and registered implementation", async () => {
    let called = 0;
    const registry = {
        refresh: () => {
            called++;
            return {};
        },
    };
    const denied = [
        createApp({ adminUiContributions: [], adminUiActions: registry }),
        createApp({ adminUiPolicy: {}, adminUiActions: registry }),
        createApp({
            adminUiPolicy: { allowedActions: { "other:quota": ["refresh"] } },
            adminUiActions: registry,
        }),
    ];
    for (const app of denied) {
        const response = await invoke(app);
        assertEquals(response.status, 403);
        assertEquals((await response.json()).error.code, "action_not_allowed");
    }
    const unavailable = await invoke(createApp({ adminUiActions: {} }));
    assertEquals(unavailable.status, 503);
    assertEquals((await unavailable.json()).error.code, "action_unavailable");
    const undeclared = await invoke(createApp({ adminUiActions: registry }), {
        contributionId: "sample:quota",
        action: { id: "deleteEverything", payload: {} },
    });
    assertEquals(undeclared.status, 403);
    assertEquals(called, 0);
});

Deno.test("plugin UI policy cannot invoke inherited action registry properties", async () => {
    let called = 0;
    const inherited = Object.create({
        refresh() {
            called++;
            return {};
        },
    });
    const response = await invoke(createApp({ adminUiActions: inherited }));
    assertEquals(response.status, 503);
    assertEquals(called, 0);
});

Deno.test("plugin UI actions check current plugin activation on every request", async () => {
    let enabled = true;
    let installed = true;
    let called = 0;
    const app = createApp({
        adminCatalog: {
            plugins: () => installed ? [{ ...plugin, enabled }] : [],
        },
        adminUiActions: {
            refresh() {
                called++;
                return {};
            },
        },
    });
    assertEquals((await invoke(app)).status, 200);
    enabled = false;
    assertEquals((await invoke(app)).status, 403);
    enabled = true;
    installed = false;
    assertEquals((await invoke(app)).status, 403);
    assertEquals(called, 1);
});

Deno.test("source status actions bind their source identity to host source plugin mapping", async () => {
    let received: UiActionInput | undefined;
    let activeSources = {
        "channel-a": "provider",
        "channel-b": "another-provider",
    };
    const app = createApp({
        adminUiSourcePlugins: () => Promise.resolve(activeSources),
        adminUiActions: {
            refresh(input) {
                received = input;
                return {};
            },
        },
    });
    const action = {
        contributionId: "sample:source-quota",
        action: { id: "refresh", payload: {} },
    };
    const success = await invoke(app, { ...action, sourceId: "channel-a" });
    assertEquals(success.status, 200);
    assertEquals(received?.context, {
        locale: "zh",
        theme: "system",
        data: {},
        sourceId: "channel-a",
        sourcePluginId: "provider",
    });
    assertEquals((await invoke(app, action)).status, 400);
    assertEquals(
        (await invoke(app, { ...action, sourceId: "channel-b" })).status,
        403,
    );
    assertEquals(
        (await invoke(app, { ...action, sourceId: "missing" })).status,
        403,
    );
    assertEquals(
        (await invoke(app, { ...action, sourceId: "__proto__" })).status,
        403,
    );
    activeSources = { ...activeSources, "channel-a": "another-provider" };
    assertEquals(
        (await invoke(app, { ...action, sourceId: "channel-a" })).status,
        403,
    );
    assertEquals(
        (await invoke(app, {
            contributionId: "sample:quota",
            action: action.action,
            sourceId: "channel-a",
        })).status,
        400,
    );
});

Deno.test("plugin UI rejects forged client context and invalid theme values", async () => {
    let called = 0;
    const app = createApp({
        adminUiActions: {
            refresh() {
                called++;
                return {};
            },
        },
    });
    const base = {
        contributionId: "sample:quota",
        action: { id: "refresh", payload: {} },
    };
    for (
        const extra of [
            { context: { locale: "en", data: { admin: true } } },
            { data: { admin: true } },
            { locale: "en" },
            { sourcePluginId: "provider" },
            { policy: { allowedActions: { "sample:quota": ["refresh"] } } },
            { url: "/api/admin/settings" },
            { theme: "untrusted-theme" },
            { theme: ["dark"] },
            { theme: null },
        ]
    ) {
        const response = await invoke(app, { ...base, ...extra });
        assertEquals(response.status, 400, JSON.stringify(extra));
    }
    assertEquals(called, 0);
});

Deno.test("plugin UI action requires a web session and same-origin JSON", async () => {
    let called = 0;
    const app = createApp({
        adminAuthToken: "operator-secret",
        adminUiActions: {
            refresh() {
                called++;
                return {};
            },
        },
    });
    assertEquals((await invoke(app)).status, 401);
    const login = await app.request(`${origin}/admin/session`, {
        method: "POST",
        headers: { origin },
        body: new URLSearchParams({ token: "operator-secret" }),
    });
    assertEquals(login.status, 303);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    for (
        const headers of [
            { origin: "https://attacker.test" },
            { origin: "null" },
            { "sec-fetch-site": "cross-site" },
            { "sec-fetch-site": "same-site" },
        ] as Record<string, string>[]
    ) {
        assertEquals(
            (await invoke(app, undefined, { ...headers, cookie })).status,
            403,
        );
    }
    assertEquals(
        (await invoke(app, undefined, { cookie, "content-type": "text/plain" }))
            .status,
        415,
    );
    assertEquals(called, 0);
    assertEquals((await invoke(app, undefined, { cookie })).status, 200);
    assertEquals(called, 1);
});

Deno.test("plugin UI rejects malformed or oversized JSON actions before invoking host code", async () => {
    let called = 0;
    const app = createApp({
        adminUiActions: {
            refresh() {
                called++;
                return {};
            },
        },
    });
    const malformed = await app.request(`${origin}/admin/ui/action`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: "{",
    });
    assertEquals(malformed.status, 400);
    for (
        const input of [
            null,
            [],
            {},
            {
                contributionId: "sample:quota",
                action: { id: "refresh", payload: null },
            },
            {
                contributionId: "sample:quota",
                action: { id: "refresh", payload: [] },
            },
            {
                contributionId: "sample:quota",
                action: { id: "refresh", payload: {}, method: "DELETE" },
            },
            {
                contributionId: "sample:quota",
                action: { id: "/api/admin/settings", payload: {} },
            },
            JSON.parse(
                '{"contributionId":"sample:quota","action":{"id":"refresh","payload":{"__proto__":{}}}}',
            ),
        ]
    ) {
        const response = await invoke(app, input);
        assert(response.status === 400 || response.status === 403);
    }
    const oversized = await invoke(app, {
        contributionId: "sample:quota",
        action: { id: "refresh", payload: { text: "x".repeat(32768) } },
    });
    assertEquals(oversized.status, 413);
    assertEquals(called, 0);
});

Deno.test("plugin UI rejects non-JSON handler results and hides handler exceptions", async () => {
    for (
        const value of [
            { callback: () => "secret" },
            { date: new Date() },
            { value: Infinity },
            { body: "x".repeat(16385) },
        ]
    ) {
        const app = createApp({
            adminUiActions: { refresh: () => value as unknown as UiJsonObject },
        });
        const response = await invoke(app);
        assertEquals(response.status, 502);
        assertEquals((await response.json()).error.code, "invalid_result");
    }
    const failed = await invoke(createApp({
        adminUiActions: {
            refresh() {
                throw new Error("private-upstream-secret");
            },
        },
    }));
    assertEquals(failed.status, 502);
    assertFalse((await failed.text()).includes("private-upstream-secret"));
});
