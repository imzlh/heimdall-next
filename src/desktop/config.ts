import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readServerEnvironment } from "../composition/runtime-env.ts";
import type { ServerEnvironment } from "../composition/runtime-env.ts";

export interface DesktopArguments {
    readonly help: boolean;
    readonly headless: boolean;
    readonly smoke: boolean;
    readonly debug: boolean;
    readonly tray?: boolean;
    readonly dataDirectory?: string;
    readonly port?: number;
    /** Embedded by the desktop packager; native geometry differs by backend. */
    readonly nativeBackend?: "webview" | "cef";
}

export function parseDesktopArguments(
    args: readonly string[],
): DesktopArguments {
    let help = false;
    let headless = false;
    let smoke = false;
    let debug = false;
    let tray: boolean | undefined;
    let dataDirectory: string | undefined;
    let port: number | undefined;
    let nativeBackend: "webview" | "cef" | undefined;
    for (let index = 0; index < args.length; index++) {
        const argument = args[index]!;
        if (argument === "--help" || argument === "-h") help = true;
        else if (argument === "--headless") headless = true;
        else if (argument === "--smoke") smoke = true;
        else if (argument === "--debug") debug = true;
        else if (argument === "--tray") tray = true;
        else if (argument === "--no-tray") tray = false;
        else if (
            argument === "--data-dir" || argument.startsWith("--data-dir=")
        ) {
            const value = argument.startsWith("--data-dir=")
                ? argument.slice("--data-dir=".length)
                : args[++index];
            if (!value || value.startsWith("--")) {
                throw new Error("--data-dir requires a directory.");
            }
            dataDirectory = resolve(value);
        } else if (argument === "--port" || argument.startsWith("--port=")) {
            const value = argument.startsWith("--port=")
                ? argument.slice("--port=".length)
                : args[++index];
            port = readDesktopPort(value);
        } else if (argument.startsWith("--native-backend=")) {
            const value = argument.slice("--native-backend=".length);
            if (value !== "webview" && value !== "cef") {
                throw new Error("Invalid native desktop backend.");
            }
            nativeBackend = value;
        } else {
            throw new Error(`Unknown desktop argument: ${argument}`);
        }
    }
    return {
        help,
        headless,
        smoke,
        debug,
        dataDirectory,
        port,
        ...(tray !== undefined ? { tray } : {}),
        ...(nativeBackend ? { nativeBackend } : {}),
    };
}

export function readDesktopPort(value: string | undefined): number {
    if (value === undefined || !/^\d+$/.test(value.trim())) {
        throw new Error("Desktop port must be an integer from 0 to 65535.");
    }
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error("Desktop port must be an integer from 0 to 65535.");
    }
    return port;
}

/** Durable desktop state is independent of the executable and working directory. */
export function desktopDataDirectory(
    env: (name: string) => string | undefined = (name) => Deno.env.get(name),
    os: typeof Deno.build.os = Deno.build.os,
): string {
    const override = env("HEIMDALL_DESKTOP_DATA_DIR")?.trim();
    if (override) return resolve(override);
    const home = env("HOME") || env("USERPROFILE");
    if (os === "windows") {
        const local = env("LOCALAPPDATA") ||
            (home && join(home, "AppData", "Local"));
        if (local) return join(local, "Heimdall");
    } else if (os === "darwin" && home) {
        return join(home, "Library", "Application Support", "Heimdall");
    } else {
        const dataHome = env("XDG_DATA_HOME") ||
            (home && join(home, ".local", "share"));
        if (dataHome) return join(dataHome, "heimdall");
    }
    throw new Error(
        "Cannot locate user data directory; set HEIMDALL_DESKTOP_DATA_DIR.",
    );
}

export interface DesktopConfiguration {
    readonly dataDirectory: string;
    readonly profileDirectory: string;
    readonly adminToken: string;
    readonly bootstrapToken: string;
    readonly environment: ServerEnvironment;
}

export async function createDesktopConfiguration(
    args: DesktopArguments,
    requestedDirectory?: string,
    env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): Promise<DesktopConfiguration> {
    const dataDirectory = requestedDirectory ?? args.dataDirectory ??
        desktopDataDirectory(env);
    await Deno.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const profileDirectory = join(dataDirectory, "webview");
    await Deno.mkdir(profileDirectory, { recursive: true, mode: 0o700 });
    const adminToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const bootstrapToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    // Desktop storage and authentication belong to this host. Server-only HOST,
    // PORT, token and database overrides must not redirect a desktop instance.
    const ignored = new Set([
        "HOST",
        "PORT",
        "HEIMDALL_KV_PATH",
        "HEIMDALL_REQUESTS_PATH",
        "HEIMDALL_CHAT_PATH",
        "HEIMDALL_CHAT_ASSETS_PATH",
        "HEIMDALL_ADMIN_TOKEN",
        "HEIMDALL_ADMIN_ASSETS",
        "HEIMDALL_PUBLIC_BASE_URL",
    ]);
    const base = readServerEnvironment(
        (name) => ignored.has(name) ? undefined : env(name),
        dataDirectory,
    );
    const port = args.port ?? (args.smoke ? 0 : readDesktopPort(
        env("HEIMDALL_DESKTOP_PORT") ?? "8088",
    ));
    return {
        dataDirectory,
        profileDirectory,
        adminToken,
        bootstrapToken,
        environment: {
            ...base,
            hostname: "127.0.0.1",
            port,
            kvPath: join(dataDirectory, "config.kv"),
            requestsPath: join(dataDirectory, "requests.sqlite"),
            chatPath: join(dataDirectory, "chat.sqlite"),
            chatAssetsPath: join(dataDirectory, "chat-assets.sqlite"),
            adminAuthToken: adminToken,
            adminAssetsRoot: fileURLToPath(
                new URL("../../public/assets/", import.meta.url),
            ),
            httpLog: args.debug,
        },
    };
}
