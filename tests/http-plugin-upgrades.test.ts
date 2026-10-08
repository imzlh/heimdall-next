import { assert, assertEquals, assertFalse } from "@std/assert";
import { packagePlugin } from "../scripts/package-plugin.ts";
import { loadBuiltinComposition } from "../src/composition/builtins.ts";
import { createServerApp } from "../src/http/app.ts";
import { DenoKvConfigStore } from "../src/storage/deno-kv.ts";

const id = "test.http-upgrade";
const origin = "http://localhost";
const token = "test-plugin-upgrade-session";
async function input(version: string) {
    return JSON.parse(
        await packagePlugin(
            {
                id,
                name: "升级测试",
                version,
                apiVersion: "1",
                kind: "tool",
                trust: "isolated",
            },
            `export function invoke(method) { if (method === "tools.list") return [{name:"test_version",description:"version",inputSchema:{type:"object"}}]; return "${version}"; }`,
        ),
    );
}

Deno.test("authenticated management upgrades and rolls back one plugin with catalog revisions and enabled state intact", async () => {
    using kv = await Deno.openKv(":memory:");
    const composition = await loadBuiltinComposition({
        configStore: new DenoKvConfigStore(kv),
        pluginRoot: new URL("./missing-upgrade-directory/", import.meta.url),
        env: () => undefined,
    });
    const app = createServerApp({
        adminAuthToken: token,
        adminCatalog: composition.catalog,
        adminManagement: composition.management,
    });
    const login = await app.request(`${origin}/admin/session`, {
        method: "POST",
        headers: { origin },
        body: new URLSearchParams({ token }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert(cookie);
    const bridge = (
        path: string,
        method: string,
        body?: unknown,
        authenticated = true,
    ) => app.request(`${origin}/admin/ui/request`, {
        method: "POST",
        headers: {
            origin,
            "content-type": "application/json",
            ...(authenticated ? { cookie } : {}),
        },
        body: JSON.stringify({
            path: `/api/admin/${path}`,
            method,
            ...(body === undefined ? {} : { body }),
        }),
    });
    try {
        const installed = await bridge(
            "plugin-package",
            "POST",
            await input("1.0.0"),
        );
        assertEquals(installed.status, 201);
        const original = (await installed.json()).plugin;
        const payload = {
            pluginId: id,
            revision: original.revision,
            package: await input("2.0.0"),
        };
        assertEquals(
            (await bridge("plugin-package", "PATCH", payload, false)).status,
            401,
        );
        assertEquals(
            (await bridge("plugin-package", "PATCH", {
                ...payload,
                revision: undefined,
            })).status,
            400,
        );
        const upgraded = await bridge("plugin-package", "PATCH", payload);
        assertEquals(upgraded.status, 200, await upgraded.clone().text());
        assertEquals((await upgraded.json()).plugin.enabled, false);
        const listed = await (await bridge("plugins", "GET")).json();
        assertEquals(listed.plugins[0].version, "2.0.0");
        assertEquals(listed.plugins[0].rollbackVersion, "1.0.0");
        assert(listed.plugins[0].revision);
        assertFalse(JSON.stringify(listed).includes("export function"));
        assertEquals(
            (await bridge("plugin-package", "PATCH", payload)).status,
            409,
        );
        assertEquals(
            (await bridge("plugin-state", "POST", {
                pluginId: id,
                enabled: true,
            })).status,
            200,
        );
        assertEquals(
            await composition.pluginHost.invoke(id, { method: "version" }),
            "2.0.0",
        );
        const current =
            (await (await bridge("plugins", "GET")).json()).plugins[0];
        const rolledBack = await bridge("plugin-rollback", "POST", {
            pluginId: id,
            revision: current.revision,
        });
        assertEquals(rolledBack.status, 200, await rolledBack.clone().text());
        assertEquals((await rolledBack.json()).plugin.enabled, true);
        assertEquals(
            await composition.pluginHost.invoke(id, { method: "version" }),
            "1.0.0",
        );
        const latest =
            (await (await bridge("plugins", "GET")).json()).plugins[0];
        assertEquals(latest.version, "1.0.0");
        assertEquals(latest.rollbackVersion, undefined);
        assertEquals(
            (await bridge("plugin-rollback", "POST", {
                pluginId: id,
                revision: latest.revision,
            })).status,
            409,
        );
    } finally {
        await composition.close();
    }
});

Deno.test("upgrade package size allows the bounded operation envelope while enforcing the original package limit", async () => {
    let upgrades = 0;
    const app = createServerApp({
        adminAuthToken: token,
        adminManagement: {
            installPlugin: () => Promise.resolve({}),
            upgradePlugin: (_context, pluginId, _input, revision) => {
                upgrades++;
                return Promise.resolve({ pluginId, revision });
            },
        },
    });
    const login = await app.request(`${origin}/admin/session`, {
        method: "POST",
        headers: { origin },
        body: new URLSearchParams({ token }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert(cookie);
    const pack = {
        fill: "x".repeat(2 * 1024 * 1024 - JSON.stringify({ fill: "" }).length),
    };
    const body = { pluginId: id, revision: "revision-1", package: pack };
    const send = (value: unknown) =>
        app.request(`${origin}/admin/ui/request`, {
            method: "POST",
            headers: { origin, cookie, "content-type": "application/json" },
            body: JSON.stringify({
                path: "/api/admin/plugin-package",
                method: "PATCH",
                body: value,
            }),
        });
    const accepted = await send(body);
    assertEquals(accepted.status, 200, await accepted.clone().text());
    assertEquals(upgrades, 1);
    const rejected = await send({
        ...body,
        package: { fill: pack.fill + "x" },
    });
    assertEquals(rejected.status, 413);
    assertEquals(upgrades, 1);
});

Deno.test("package replacement routes can be configured without an installation handler", async () => {
    const app = createServerApp({
        adminManagement: {
            upgradePlugin: (_context, pluginId, _input, revision) =>
                Promise.resolve({ pluginId, revision }),
            rollbackPlugin: (_context, pluginId, revision) =>
                Promise.resolve({ pluginId, revision }),
        },
    });
    for (
        const [path, method] of [["plugin-package", "PATCH"], [
            "plugin-rollback",
            "POST",
        ]]
    ) {
        const response = await app.request(`/api/admin/${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                pluginId: id,
                revision: "current",
                package: {},
            }),
        });
        assertEquals(response.status, 200);
        assertEquals((await response.json()).plugin, {
            pluginId: id,
            revision: "current",
        });
    }
});
