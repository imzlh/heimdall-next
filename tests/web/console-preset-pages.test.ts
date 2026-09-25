import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { SourceConfigSchema } from "@heimdall/admin-contracts/forms.ts";
import type { UiPolicy } from "@heimdall/admin-contracts/ui.ts";
import {
    createServerApp,
    type ServerAppOptions,
} from "@heimdall/core/http/app.ts";

const sourceId = "example.source";
const presetId = "example.preset";
const modulePath = "/admin/assets/plugins/example/setup.js";
const baseOptions: ServerAppOptions = {
    adminCatalog: {
        plugins: [{
            id: sourceId,
            name: "示例源",
            kind: "source",
            version: "1",
            trust: "trusted",
            enabled: true,
        }, {
            id: presetId,
            name: "示例预设",
            kind: "preset",
            version: "1",
            trust: "trusted",
            enabled: true,
        }],
        presets: [{
            id: presetId,
            name: "示例预设",
            sourcePluginId: sourceId,
            version: "1",
        }],
    },
    adminUiSchemas: {
        [sourceId]: {
            version: 1,
            id: sourceId,
            fields: [
                {
                    type: "string",
                    name: "baseUrl",
                    label: "服务地址",
                    required: true,
                },
                { type: "secret", name: "apiKey", label: "访问令牌" },
            ],
        },
    },
    adminPresetPages: { [presetId]: modulePath },
};

function readBoot(html: string): {
    page: string;
    schemas: Record<string, SourceConfigSchema>;
    presetPages: Record<string, string>;
    draftId?: unknown;
    presetId?: unknown;
} {
    const content = html.match(
        /<script[^>]*id="heimdall-boot"[^>]*>([\s\S]*?)<\/script>/,
    )?.[1];
    assert(content);
    return JSON.parse(content);
}

Deno.test("channel console supplies schema and preset metadata to its existing island", async () => {
    const response = await createServerApp(baseOptions).request(
        "/admin?view=channels",
    );
    const html = await response.text();
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertStringIncludes(html, 'lang="zh"');
    assertStringIncludes(html, "/admin/assets/console.js");
    assertStringIncludes(html, 'id="heimdall-console"');
    assertStringIncludes(html, "<noscript>");
    assert(!html.includes("/admin/assets/source-setup"));
    const boot = readBoot(html);
    assertEquals(boot.page, "channels");
    assertEquals(boot.schemas[sourceId]?.fields[1]?.type, "secret");
    assertEquals(boot.presetPages, {});
});

Deno.test("console preset modules require the exact own host allowlist entry", async () => {
    const policies: UiPolicy[] = [
        {},
        { trustedModules: { [`${presetId}:card`]: modulePath } },
        {
            trustedModules: {
                [`${presetId}:setup`]: "/admin/assets/plugins/other.js",
            },
        },
        {
            trustedModules: Object.create({
                [`${presetId}:setup`]: modulePath,
            }),
        },
    ];
    for (const adminUiPolicy of policies) {
        const html = await (await createServerApp({
            ...baseOptions,
            adminUiPolicy,
        }).request("/admin?view=channels")).text();
        assertEquals(readBoot(html).presetPages, {});
    }
    const app = createServerApp({
        ...baseOptions,
        adminPresetPages: {
            [presetId]: modulePath,
            missing: "/admin/assets/plugins/missing.js",
        },
        adminUiPolicy: {
            trustedModules: {
                [`${presetId}:setup`]: modulePath,
                "missing:setup": "/admin/assets/plugins/missing.js",
            },
        },
    });
    const html = await (await app.request("/admin?view=channels")).text();
    assertEquals(readBoot(html).presetPages, { [presetId]: modulePath });
    assert(!html.includes(`<script type="module" src="${modulePath}"`));
});

Deno.test("console requires login before reading private preset metadata", async () => {
    let reads = 0;
    const app = createServerApp({
        ...baseOptions,
        adminAuthToken: "operator-secret",
        adminPresetPages: () => {
            reads++;
            return Promise.resolve({ [presetId]: modulePath });
        },
        adminUiPolicy: {
            trustedModules: { [`${presetId}:setup`]: modulePath },
        },
    });
    const denied = await app.request("/admin?view=channels");
    const publicHtml = await denied.text();
    assertEquals(denied.status, 200);
    assertEquals(reads, 0);
    assertEquals(readBoot(publicHtml).presetPages, {});
    assertEquals(readBoot(publicHtml).schemas, {});
    assert(!publicHtml.includes("示例预设"));
    const login = await app.request("/admin/session", {
        method: "POST",
        body: new URLSearchParams({ token: "operator-secret" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const response = await app.request("/admin?view=channels", {
        headers: { cookie },
    });
    const html = await response.text();
    assertEquals(response.status, 200);
    assertEquals(reads, 1);
    assertEquals(readBoot(html).presetPages, { [presetId]: modulePath });
    assert(!html.includes("operator-secret"));
});

Deno.test("retired setup query cannot restore a draft or load a separate page", async () => {
    const draft = '</script><script src="https://invalid.test/x.js"></script>';
    const html = await (await createServerApp(baseOptions).request(
        `/admin?view=source-add&mode=custom&draft=${encodeURIComponent(draft)}`,
    )).text();
    const boot = readBoot(html);
    assertEquals(boot.page, "overview");
    assertEquals(boot.draftId, undefined);
    assertEquals(boot.presetId, undefined);
    assert(!html.includes(draft));
    assert(!html.includes("/admin/assets/source-setup"));
    assertStringIncludes(html, 'id="heimdall-console"');
});
