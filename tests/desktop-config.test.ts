import {
    assert,
    assertEquals,
    assertMatch,
    assertNotEquals,
    assertRejects,
    assertThrows,
} from "@std/assert";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    createDesktopConfiguration,
    desktopDataDirectory,
    parseDesktopArguments,
    readDesktopPort,
} from "@heimdall/core/desktop/config.ts";

function environment(values: Readonly<Record<string, string>>) {
    return (name: string): string | undefined => values[name];
}

/** Every filesystem test owns exactly one freshly created temporary directory. */
async function withTemporaryDirectory(
    run: (directory: string) => Promise<void>,
): Promise<void> {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-config-test-",
    });
    try {
        await run(directory);
    } finally {
        // This path comes directly from makeTempDir, never from config or env.
        await Deno.remove(directory, { recursive: true });
    }
}

Deno.test("desktop data paths select the operating system user data location", () => {
    // These synthetic paths are only passed to the pure resolver; none is opened.
    const home = resolve("synthetic-desktop-home");
    const local = resolve("synthetic-desktop-local-appdata");
    const xdg = resolve("synthetic-desktop-xdg");
    assertEquals(
        desktopDataDirectory(
            environment({ LOCALAPPDATA: local, HOME: home }),
            "windows",
        ),
        join(local, "Heimdall"),
    );
    assertEquals(
        desktopDataDirectory(environment({ USERPROFILE: home }), "windows"),
        join(home, "AppData", "Local", "Heimdall"),
    );
    assertEquals(
        desktopDataDirectory(environment({ HOME: home }), "darwin"),
        join(home, "Library", "Application Support", "Heimdall"),
    );
    assertEquals(
        desktopDataDirectory(
            environment({ XDG_DATA_HOME: xdg, HOME: home }),
            "linux",
        ),
        join(xdg, "heimdall"),
    );
    assertEquals(
        desktopDataDirectory(environment({ HOME: home }), "linux"),
        join(home, ".local", "share", "heimdall"),
    );
    for (const os of ["windows", "darwin", "linux"] as const) {
        assertThrows(
            () => desktopDataDirectory(environment({}), os),
            Error,
            "HEIMDALL_DESKTOP_DATA_DIR",
        );
    }
});

Deno.test("desktop data override is normalized and takes priority over OS paths", () => {
    const override = "desktop-test-data/../desktop chosen data";
    assertEquals(
        desktopDataDirectory(
            environment({
                HEIMDALL_DESKTOP_DATA_DIR: `  ${override}  `,
                LOCALAPPDATA: resolve("unused-local-appdata"),
                HOME: resolve("unused-home"),
            }),
            "windows",
        ),
        resolve(override),
    );
});

Deno.test("desktop arguments accept explicit overrides and reject ambiguous ports", () => {
    const args = parseDesktopArguments([
        "--debug",
        "--headless",
        "--smoke",
        "--data-dir=desktop config test",
        "--port",
        "8089",
        "--port=0",
    ]);
    assertEquals(args, {
        help: false,
        headless: true,
        smoke: true,
        debug: true,
        dataDirectory: resolve("desktop config test"),
        port: 0,
    });
    assertEquals(readDesktopPort("65535"), 65535);
    for (
        const value of [
            undefined,
            "",
            "-1",
            "65536",
            "1.5",
            "1e3",
            "0x50",
            "--debug",
        ]
    ) {
        assertThrows(() => readDesktopPort(value), Error, "Desktop port");
    }
    assertThrows(
        () => parseDesktopArguments(["--data-dir"]),
        Error,
        "--data-dir",
    );
    assertThrows(
        () => parseDesktopArguments(["--port"]),
        Error,
        "Desktop port",
    );
    assertThrows(
        () => parseDesktopArguments(["--host=0.0.0.0"]),
        Error,
        "Unknown desktop argument",
    );
});

Deno.test("desktop arguments accept only supported embedded native backends", () => {
    assertEquals(parseDesktopArguments([]).nativeBackend, undefined);
    for (const backend of ["cef", "webview"] as const) {
        const args = parseDesktopArguments([
            `--native-backend=${backend}`,
            "--smoke",
        ]);
        assertEquals(args.nativeBackend, backend);
        assertEquals(args.smoke, true);
    }
    for (const backend of ["", "webkit", "CEF", "webview2"]) {
        assertThrows(
            () => parseDesktopArguments([`--native-backend=${backend}`]),
            Error,
            "Invalid native desktop backend.",
        );
    }
});

Deno.test("desktop arguments preserve explicit tray enable and disable choices", () => {
    assertEquals(parseDesktopArguments([]).tray, undefined);
    assertEquals(parseDesktopArguments(["--tray"]).tray, true);
    assertEquals(parseDesktopArguments(["--no-tray"]).tray, false);
    assertEquals(
        parseDesktopArguments(["--tray", "--no-tray"]).tray,
        false,
    );
    assertEquals(
        parseDesktopArguments(["--no-tray", "--tray"]).tray,
        true,
    );
});

Deno.test("desktop configuration fixes its listener and ignores server data and auth overrides", async () => {
    await withTemporaryDirectory(async (directory) => {
        const data = join(directory, "desktop");
        const injected = join(directory, "server-injected");
        const configured = await createDesktopConfiguration(
            parseDesktopArguments(["--data-dir", data]),
            undefined,
            environment({
                HOST: "0.0.0.0",
                PORT: "not-a-port",
                HEIMDALL_KV_PATH: join(injected, "config.sqlite"),
                HEIMDALL_REQUESTS_PATH: join(injected, "requests.sqlite"),
                HEIMDALL_CHAT_PATH: join(injected, "chat.sqlite"),
                HEIMDALL_CHAT_ASSETS_PATH: join(injected, "assets.sqlite"),
                HEIMDALL_ADMIN_TOKEN: "injected-server-admin-token",
                HEIMDALL_ADMIN_ASSETS: join(injected, "assets"),
                HEIMDALL_PUBLIC_BASE_URL: "https://injected.example",
                HEIMDALL_HTTP_LOG: "true",
                HEIMDALL_DESKTOP_PORT: "8181",
            }),
        );
        assertEquals(configured.dataDirectory, data);
        assertEquals(configured.profileDirectory, join(data, "webview"));
        assertEquals(configured.environment.hostname, "127.0.0.1");
        assertEquals(configured.environment.port, 8181);
        assertEquals(configured.environment.kvPath, join(data, "config.kv"));
        assertEquals(
            configured.environment.requestsPath,
            join(data, "requests.sqlite"),
        );
        assertEquals(
            configured.environment.chatPath,
            join(data, "chat.sqlite"),
        );
        assertEquals(
            configured.environment.chatAssetsPath,
            join(data, "chat-assets.sqlite"),
        );
        assertEquals(configured.environment.publicBaseUrl, undefined);
        assertEquals(configured.environment.httpLog, false);
        assertEquals(
            configured.environment.adminAuthToken,
            configured.adminToken,
        );
        assertNotEquals(configured.adminToken, "injected-server-admin-token");
        assertEquals(
            configured.environment.adminAssetsRoot,
            fileURLToPath(new URL("../public/assets/", import.meta.url)),
        );
        assert((await Deno.stat(configured.profileDirectory)).isDirectory);
        await assertRejects(() => Deno.stat(injected), Deno.errors.NotFound);
    });
});

Deno.test("desktop CLI overrides environment while host-supplied smoke data stays isolated", async () => {
    await withTemporaryDirectory(async (directory) => {
        const envData = join(directory, "environment-data");
        const cliData = join(directory, "cli-data");
        const temporaryData = join(directory, "smoke-data");
        const env = environment({
            HEIMDALL_DESKTOP_DATA_DIR: envData,
            HEIMDALL_DESKTOP_PORT: "8282",
        });
        const explicit = await createDesktopConfiguration(
            parseDesktopArguments([
                "--data-dir",
                cliData,
                "--port=8383",
                "--debug",
            ]),
            undefined,
            env,
        );
        assertEquals(explicit.dataDirectory, cliData);
        assertEquals(explicit.environment.port, 8383);
        assertEquals(explicit.environment.httpLog, true);
        const smoke = await createDesktopConfiguration(
            parseDesktopArguments(["--smoke"]),
            temporaryData,
            env,
        );
        assertEquals(smoke.dataDirectory, temporaryData);
        assertEquals(smoke.environment.port, 0);
        assertEquals(
            smoke.environment.kvPath,
            join(temporaryData, "config.kv"),
        );
        await assertRejects(() => Deno.stat(envData), Deno.errors.NotFound);
        const defaults = await createDesktopConfiguration(
            parseDesktopArguments([]),
            undefined,
            env,
        );
        assertEquals(defaults.dataDirectory, envData);
        assertEquals(defaults.environment.port, 8282);
    });
});

Deno.test("desktop credentials are distinct random secrets for every launch", async () => {
    await withTemporaryDirectory(async (directory) => {
        const args = parseDesktopArguments([]);
        const first = await createDesktopConfiguration(
            args,
            join(directory, "first"),
            environment({}),
        );
        const second = await createDesktopConfiguration(
            args,
            join(directory, "second"),
            environment({}),
        );
        const tokens = [
            first.adminToken,
            first.bootstrapToken,
            second.adminToken,
            second.bootstrapToken,
        ];
        for (const token of tokens) {
            assertMatch(token, /^[A-Za-z0-9_-]{64,256}$/);
        }
        assertEquals(new Set(tokens).size, tokens.length);
        assertEquals(first.environment.port, 8088);
        assertEquals(second.environment.hostname, "127.0.0.1");
    });
});
