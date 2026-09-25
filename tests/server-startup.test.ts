import {
    assertEquals,
    assertMatch,
    assertRejects,
    assertThrows,
} from "@std/assert";
import {
    readServerEnvironment,
    type ServerEnvironment,
} from "@heimdall/core/composition/runtime-env.ts";
import { serve } from "@heimdall/core/composition/serve.ts";

Deno.test("server environment has explicit storage and process defaults", () => {
    const environment = readServerEnvironment(() => undefined, "/application");
    assertEquals(environment.hostname, "127.0.0.1");
    assertEquals(environment.port, 8088);
    assertEquals(environment.kvPath, undefined);
    assertEquals(environment.requestsPath, "/application/data/requests.sqlite");
    assertEquals(environment.chatPath, "/application/data/chat.sqlite");
    assertEquals(environment.retentionDays, 0);
    assertEquals(
        environment.timeZone,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    assertEquals(environment.runtimeSettings, {
        proxyKey: "",
        limitPerMinute: 120,
        probeIntervalMs: 300_000,
    });
    assertEquals(environment.adminAuthToken, undefined);
    assertEquals(environment.adminAssetsRoot, undefined);
    assertEquals(environment.adminUiPolicyPath, undefined);
});

Deno.test("server environment parses deployment overrides and optional assets", () => {
    const values: Record<string, string> = {
        HOST: " 0.0.0.0 ",
        PORT: "9090",
        HEIMDALL_KV_PATH: " /persistent/config.sqlite ",
        HEIMDALL_REQUESTS_PATH: "/persistent/requests.sqlite",
        HEIMDALL_CHAT_PATH: "/persistent/chat.sqlite",
        HEIMDALL_REQUEST_RETENTION_DAYS: "30",
        HEIMDALL_TIMEZONE: " america/new_york ",
        HEIMDALL_PROXY_KEY: " proxy-key ",
        HEIMDALL_RATE_LIMIT: "0",
        HEIMDALL_PROBE_INTERVAL_MS: "0",
        HEIMDALL_ADMIN_TOKEN: " admin-token ",
        HEIMDALL_ADMIN_ASSETS: " /application/assets ",
        HEIMDALL_UI_POLICY_PATH: " /application/ui-policy.json ",
    };
    const environment = readServerEnvironment((name) => values[name]);
    assertEquals(environment, {
        hostname: "0.0.0.0",
        port: 9090,
        kvPath: "/persistent/config.sqlite",
        requestsPath: "/persistent/requests.sqlite",
        chatPath: "/persistent/chat.sqlite",
        retentionDays: 30,
        timeZone: "America/New_York",
        runtimeSettings: {
            proxyKey: "proxy-key",
            limitPerMinute: 0,
            probeIntervalMs: 0,
        },
        adminAuthToken: "admin-token",
        adminAssetsRoot: "/application/assets",
        adminUiPolicyPath: "/application/ui-policy.json",
    });

    values.HEIMDALL_ADMIN_ASSETS = "   ";
    values.HEIMDALL_UI_POLICY_PATH = "   ";
    const optional = readServerEnvironment((name) => values[name]);
    assertEquals(optional.adminAssetsRoot, undefined);
    assertEquals(optional.adminUiPolicyPath, undefined);
});

Deno.test("server environment rejects invalid process settings before startup", () => {
    const invalidSettings = [
        ["PORT", "0"],
        ["PORT", "65536"],
        ["HEIMDALL_RATE_LIMIT", "-1"],
        ["HEIMDALL_PROBE_INTERVAL_MS", "invalid"],
        ["HEIMDALL_REQUEST_RETENTION_DAYS", "1.5"],
        ["HEIMDALL_TIMEZONE", "Mars/Olympus"],
    ] as const;
    for (const [setting, value] of invalidSettings) {
        assertThrows(
            () =>
                readServerEnvironment((name) =>
                    name === setting ? value : undefined
                ),
            RangeError,
            setting,
        );
    }
});

Deno.test("failed server startup closes resources already opened", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-failed-start-",
    });
    try {
        const environment = readServerEnvironment(() => undefined, directory);
        await assertRejects(() =>
            serve({
                environment: {
                    ...environment,
                    kvPath: ":memory:",
                    // Opening a directory as SQLite must fail after KV opens.
                    requestsPath: directory,
                    chatPath: ":memory:",
                },
            })
        );
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("server serves Hono routes and releases resources across restarts", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-startup-" });
    await Deno.mkdir(`${directory}/plugins/example`, { recursive: true });
    await Deno.writeTextFile(
        `${directory}/plugins/example/status.js`,
        "export const status = 'ready';",
    );
    const policyPath = `${directory}/ui-policy.json`;
    await Deno.writeTextFile(
        policyPath,
        JSON.stringify({
            trustedModules: {
                "example:status": "/admin/assets/plugins/example/status.js",
            },
        }),
    );
    const defaults = readServerEnvironment(() => undefined, directory);
    const environment: ServerEnvironment = {
        ...defaults,
        port: 0,
        kvPath: ":memory:",
        requestsPath: ":memory:",
        chatPath: ":memory:",
        adminAssetsRoot: directory,
        adminUiPolicyPath: policyPath,
        runtimeSettings: { ...defaults.runtimeSettings, probeIntervalMs: 0 },
    };
    try {
        // Default Deno operation/resource sanitizers cover both full lifecycles.
        for (let run = 0; run < 2; run++) {
            const controller = new AbortController();
            const listening = Promise.withResolvers<Deno.NetAddr>();
            const client = Deno.createHttpClient({});
            const running = serve({
                environment,
                signal: controller.signal,
                onListen: listening.resolve,
            });
            const startupTimeout = setTimeout(() => {
                listening.reject(new Error("server did not start within 10s"));
            }, 10_000);
            try {
                const address = await Promise.race([
                    listening.promise,
                    running.then(() => {
                        throw new Error("server stopped before listening");
                    }),
                ]);
                clearTimeout(startupTimeout);
                const origin = `http://${address.hostname}:${address.port}`;
                const health = await fetch(`${origin}/health`, { client });
                assertEquals(health.status, 200);
                assertEquals(await health.json(), { status: "ok" });

                const page = await fetch(origin, { client });
                assertEquals(page.status, 200);
                assertMatch(
                    page.headers.get("content-type") ?? "",
                    /text\/html/,
                );
                assertMatch(await page.text(), /<html[\s>]/i);

                const asset = await fetch(
                    `${origin}/admin/assets/plugins/example/status.js`,
                    { client },
                );
                assertEquals(asset.status, 200);
                assertEquals(
                    await asset.text(),
                    "export const status = 'ready';",
                );
            } finally {
                clearTimeout(startupTimeout);
                client.close();
                controller.abort();
                await running;
            }
        }
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
});
