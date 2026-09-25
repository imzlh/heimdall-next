import {
    assert,
    assertEquals,
    assertFalse,
    assertStringIncludes,
} from "@std/assert";
import type { PluginDto, PresetDto } from "@heimdall/admin-contracts";
import type { SourceConfigSchema } from "@heimdall/admin-contracts/forms.ts";
import type { UiContribution } from "@heimdall/admin-contracts/ui.ts";
import type { UiCatalog } from "@heimdall/admin-contracts/ui-catalog.ts";
import { createServerApp, type ServerApp } from "@heimdall/core/http/app.ts";
import { loadUiContributions } from "@heimdall/core/composition/ui-contributions.ts";
import { loadSourceSchemas } from "@heimdall/core/composition/source-schemas.ts";
import { loadPresetPages } from "@heimdall/core/composition/preset-pages.ts";

const origin = "https://console.example.test";
const plugin: PluginDto = {
    id: "sample",
    name: "示例插件",
    kind: "source",
    version: "1",
    trust: "trusted",
    enabled: true,
};
const contribution: UiContribution = {
    pluginId: "sample",
    id: "quota",
    slot: "dashboard.widget",
    title: "额度",
    schema: { blocks: [{ kind: "text", text: "状态正常" }] },
};
const schema: SourceConfigSchema = {
    version: 1,
    id: "sample",
    fields: [{
        type: "secret",
        name: "apiKey",
        label: "密钥",
        preserveOnBlank: true,
    }],
};

async function catalog(
    app: ServerApp,
    headers?: HeadersInit,
): Promise<UiCatalog> {
    const response = await app.request(`${origin}/admin/ui/catalog`, {
        headers,
    });
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals(response.headers.get("x-content-type-options"), "nosniff");
    return await response.json();
}

Deno.test("UI catalog re-resolves active cards, schemas, source ownership and SSR tabs", async () => {
    let enabled = false;
    let declarations: readonly UiContribution[] = [contribution, {
        ...contribution,
        id: "page",
        slot: "nav.tab",
    }];
    let schemas = { sample: schema };
    let sourcePluginIds = { "channel-a": "sample" };
    const app = createServerApp({
        adminCatalog: { plugins: () => [{ ...plugin, enabled }] },
        adminUiContributions: () => Promise.resolve(declarations),
        adminUiSchemas: () => schemas,
        adminUiSourcePlugins: () => sourcePluginIds,
    });
    assertEquals((await catalog(app)).contributions, []);
    assertEquals(
        (await app.request("/admin?view=plugin&tab=sample:page")).status,
        404,
    );
    enabled = true;
    assertEquals((await catalog(app)).contributions, declarations);
    assertEquals(
        (await app.request("/admin?view=plugin&tab=sample:page")).status,
        200,
    );
    declarations = [{
        ...contribution,
        id: "new-page",
        slot: "nav.tab",
        title: "新页面",
    }];
    schemas = { sample: { ...schema, title: "更新表单" } };
    sourcePluginIds = { "channel-a": "replacement" };
    const updated = await catalog(app);
    assertEquals(updated, {
        contributions: declarations,
        schemas,
        sourcePluginIds,
        presetPages: {},
    });
    const page = await (await app.request("/admin")).text();
    assertStringIncludes(page, "sample%3Anew-page");
    assertStringIncludes(page, "新页面");
    assertFalse(page.includes("sample%3Apage"));
    assertEquals(
        (await app.request("/admin?view=plugin&tab=sample:page")).status,
        404,
    );
    enabled = false;
    assertEquals((await catalog(app)).contributions, []);
    assertFalse(
        (await (await app.request("/admin")).text()).includes(
            "sample%3Anew-page",
        ),
    );
});

Deno.test("UI catalog revokes preset JSX when its preset, source or exact host grant changes", async () => {
    const presetPlugin: PluginDto = {
        ...plugin,
        id: "sample.preset",
        kind: "preset",
    };
    let plugins = [plugin, presetPlugin];
    let presets: PresetDto[] = [{
        id: presetPlugin.id,
        name: "示例预设",
        version: "1",
        sourcePluginId: plugin.id,
    }];
    const modulePath = "/admin/assets/plugins/sample/setup.js";
    let declared: Readonly<Record<string, string>> = {
        [presetPlugin.id]: modulePath,
    };
    const policy = {
        trustedModules: { [`${presetPlugin.id}:setup`]: modulePath },
    };
    const create = () =>
        createServerApp({
            adminCatalog: { plugins: () => plugins, presets: () => presets },
            adminPresetPages: () => Promise.resolve(declared),
            adminUiPolicy: policy,
        });
    const app = create();
    assertEquals((await catalog(app)).presetPages, declared);

    for (const disabled of [plugin, presetPlugin]) {
        plugins = [plugin, presetPlugin].map((item) => ({
            ...item,
            enabled: item.id !== disabled.id,
        }));
        assertEquals((await catalog(app)).presetPages, {});
        assertEquals((await catalog(create())).presetPages, {});
        plugins = [plugin, presetPlugin];
        assertEquals((await catalog(app)).presetPages, declared);
    }
    for (const kind of ["tool", "protocol"] as const) {
        plugins = [plugin, { ...presetPlugin, kind }];
        assertEquals((await catalog(app)).presetPages, {});
    }
    plugins = [plugin, presetPlugin];
    const registered = presets;
    presets = [];
    assertEquals((await catalog(app)).presetPages, {});
    presets = [{ ...registered[0]!, sourcePluginId: "missing.source" }];
    assertEquals((await catalog(app)).presetPages, {});
    presets = registered;

    declared = { [presetPlugin.id]: "/admin/assets/plugins/sample/updated.js" };
    assertEquals((await catalog(app)).presetPages, {});
    policy.trustedModules[`${presetPlugin.id}:setup`] =
        declared[presetPlugin.id]!;
    assertEquals((await catalog(app)).presetPages, declared);
    assertEquals((await catalog(create())).presetPages, declared);
    declared = {};
    assertEquals((await catalog(app)).presetPages, {});
});

Deno.test("UI catalog never promotes manifest trust or inherited grants to module execution", async () => {
    const id = "sample.preset";
    const modulePath = "/admin/assets/plugins/sample/setup.js";
    const declarations = { [id]: modulePath };
    const plugins: PluginDto[] = [plugin, {
        ...plugin,
        id,
        kind: "preset",
        trust: "trusted",
    }];
    const presets: PresetDto[] = [{
        id,
        sourcePluginId: plugin.id,
        name: "预设",
        version: "1",
    }];
    for (
        const trustedModules of [
            {},
            { [id]: modulePath },
            { [`${id}:setup`]: "/admin/assets/plugins/sample/other.js" },
            Object.create({ [`${id}:setup`]: modulePath }),
        ]
    ) {
        const app = createServerApp({
            adminCatalog: { plugins, presets },
            adminPresetPages: declarations,
            adminUiPolicy: { trustedModules },
        });
        assertEquals((await catalog(app)).presetPages, {});
    }
    for (
        const path of [
            "https://cdn.example.test/setup.js",
            "/admin/assets/plugins/../setup.js",
            "/admin/assets/plugins/%2e%2e/setup.js",
            "/admin/assets/plugins/sample//setup.js",
            "/admin/assets/plugins/sample/setup.js?x=1",
            "/admin/assets/plugins/sample/setup.html",
        ]
    ) {
        const app = createServerApp({
            adminCatalog: { plugins, presets },
            adminPresetPages: { [id]: path },
            adminUiPolicy: { trustedModules: { [`${id}:setup`]: path } },
        });
        assertEquals((await catalog(app)).presetPages, {});
    }
});

Deno.test("UI catalog reloads approved preset declarations without evaluating their JavaScript", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-live-preset-ui-",
    });
    const pluginRoot = new URL("file:///");
    pluginRoot.pathname = `${directory.replaceAll("\\", "/")}/`;
    const presetRoot = new URL("sample-preset/", pluginRoot);
    await Deno.mkdir(presetRoot);
    const id = "sample.preset";
    const initialPath = "/admin/assets/plugins/sample/setup.js";
    const updatedPath = "/admin/assets/plugins/sample/updated.js";
    const policy = { trustedModules: { [`${id}:setup`]: initialPath } };
    const manifest = (modulePath: string) => ({
        id,
        kind: "preset",
        trust: "trusted",
        sourcePluginId: plugin.id,
        presetPage: { modulePath },
    });
    try {
        await Deno.writeTextFile(
            new URL("mod.ts", presetRoot),
            'throw new Error("must never import this runtime");',
        );
        const manifestUrl = new URL("manifest.json", presetRoot);
        await Deno.writeTextFile(
            manifestUrl,
            JSON.stringify(manifest(initialPath)),
        );
        const app = createServerApp({
            adminCatalog: {
                plugins: [plugin, { ...plugin, id, kind: "preset" }],
                presets: [{
                    id,
                    sourcePluginId: plugin.id,
                    name: "预设",
                    version: "1",
                }],
            },
            adminPresetPages: () =>
                loadPresetPages(policy, { pluginRoot, warn: () => undefined }),
            adminUiPolicy: policy,
        });
        assertEquals((await catalog(app)).presetPages, { [id]: initialPath });
        await Deno.writeTextFile(
            manifestUrl,
            JSON.stringify(manifest(updatedPath)),
        );
        assertEquals((await catalog(app)).presetPages, {});
        policy.trustedModules[`${id}:setup`] = updatedPath;
        assertEquals((await catalog(app)).presetPages, { [id]: updatedPath });
        await Deno.writeTextFile(
            manifestUrl,
            JSON.stringify({ ...manifest(updatedPath), presetPage: undefined }),
        );
        assertEquals((await catalog(app)).presetPages, {});
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("UI catalog refresh reads changed manifests without evaluating runtime entrypoints", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-live-ui-" });
    const pluginRoot = new URL("file:///");
    pluginRoot.pathname = `${directory.replaceAll("\\", "/")}/`;
    const sampleRoot = new URL("sample/", pluginRoot);
    await Deno.mkdir(sampleRoot);
    const manifestUrl = new URL("manifest.json", sampleRoot);
    const manifest = (title: string) => ({
        ...plugin,
        apiVersion: "1",
        configSchema: { ...schema, title },
        ui: [{ ...contribution, title }],
    });
    const options = { pluginRoot, warn: () => undefined };
    try {
        await Deno.writeTextFile(
            manifestUrl,
            JSON.stringify(manifest("初始声明")),
        );
        await Deno.writeTextFile(
            new URL("mod.ts", sampleRoot),
            'throw new Error("must never import this runtime");',
        );
        const app = createServerApp({
            adminCatalog: { plugins: [plugin] },
            adminUiContributions: () => loadUiContributions(options),
            adminUiSchemas: () => loadSourceSchemas(options),
        });
        assertEquals((await catalog(app)).contributions[0]?.title, "初始声明");
        await Deno.writeTextFile(
            manifestUrl,
            JSON.stringify(manifest("刷新声明")),
        );
        const refreshed = await catalog(app);
        assertEquals(refreshed.contributions[0]?.title, "刷新声明");
        assertEquals(refreshed.schemas.sample?.title, "刷新声明");
        await Deno.writeTextFile(
            manifestUrl,
            JSON.stringify({
                ...manifest("未安装"),
                id: "unregistered",
                ui: [{ ...contribution, pluginId: "unregistered" }],
            }),
        );
        assertEquals((await catalog(app)).contributions, []);
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("UI catalog requires a same-origin web session before resolving host declarations", async () => {
    let reads = 0;
    let presetReads = 0;
    const app = createServerApp({
        adminAuthToken: "operator-secret",
        adminCatalog: { plugins: [plugin] },
        adminUiContributions: () => {
            reads++;
            return [contribution];
        },
        adminPresetPages: () => {
            presetReads++;
            return Promise.resolve({});
        },
    });
    assertEquals((await app.request(`${origin}/admin/ui/catalog`)).status, 401);
    assertEquals(
        (await app.request(`${origin}/admin/ui/catalog`, {
            headers: { authorization: "Bearer wrong-secret" },
        })).status,
        401,
    );
    assertEquals(reads, 0);
    assertEquals(presetReads, 0);
    const login = await app.request(`${origin}/admin/session`, {
        method: "POST",
        headers: { origin },
        body: new URLSearchParams({ token: "operator-secret" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const headerVariants: Record<string, string>[] = [{
        origin: "https://attacker.test",
    }, { "sec-fetch-site": "cross-site" }];
    for (const headers of headerVariants) {
        assertEquals(
            (await app.request(`${origin}/admin/ui/catalog`, {
                headers: { ...headers, cookie },
            })).status,
            403,
        );
    }
    assertEquals(reads, 0);
    assertEquals(presetReads, 0);
    assertEquals((await catalog(app, { cookie })).contributions, [
        contribution,
    ]);
    assertEquals(reads, 1);
    assertEquals(presetReads, 1);
    assertEquals(
        (await catalog(app, { authorization: "Bearer operator-secret" }))
            .contributions,
        [contribution],
    );
    assertEquals(
        (await app.request(`${origin}/api/admin/ui/catalog`, {
            headers: { authorization: "Bearer operator-secret" },
        })).status,
        404,
    );
});

Deno.test("removed UI declarations immediately revoke their host actions", async () => {
    let declarations: readonly UiContribution[] = [contribution];
    let calls = 0;
    const app = createServerApp({
        adminCatalog: { plugins: [plugin] },
        adminUiContributions: () => declarations,
        adminUiPolicy: { allowedActions: { "sample:quota": ["refresh"] } },
        adminUiActions: {
            refresh: () => {
                calls++;
                return {};
            },
        },
    });
    const invoke = () =>
        app.request(`${origin}/admin/ui/action`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({
                contributionId: "sample:quota",
                action: { id: "refresh", payload: {} },
            }),
        });
    assertEquals((await invoke()).status, 200);
    declarations = [];
    assertEquals((await invoke()).status, 403);
    assertEquals(calls, 1);
});

Deno.test("invalid UI metadata fails as a bounded web error without exposing provider details", async () => {
    const app = createServerApp({
        adminCatalog: { plugins: [plugin] },
        adminUiContributions: () => {
            throw new Error("private-manifest-secret");
        },
    });
    const response = await app.request(`${origin}/admin/ui/catalog`);
    assertEquals(response.status, 502);
    assertFalse((await response.text()).includes("private-manifest-secret"));
    const invalid = createServerApp({
        adminCatalog: { plugins: [plugin] },
        adminUiContributions: [{ ...contribution, title: "x".repeat(10_000) }],
    });
    const rejected = await invalid.request(`${origin}/admin/ui/catalog`);
    assertEquals(rejected.status, 502);
    assert((await rejected.json()).error.code.length > 0);
});
