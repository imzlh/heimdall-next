import { join } from "node:path";
import {
    createDesktopConfiguration,
    desktopDataDirectory,
    parseDesktopArguments,
} from "./config.ts";
import { createDesktopHost } from "./host.ts";
import { officialDesktopNative } from "./native.ts";
import { verifyDesktopRuntime, verifyDesktopWindow } from "./smoke.ts";
import { startRuntime } from "../runtime/server.ts";
import { createDesktopWindowStateStore } from "./window-state.ts";

export async function runDesktop(
    args: readonly string[] = Deno.args,
): Promise<void> {
    const options = parseDesktopArguments(args);
    if (options.help) {
        console.log(
            `Heimdall Desktop\n\nUsage: desktop [--debug] [--data-dir PATH]\n  --debug       Open desktop developer tools and log HTTP requests\n  --data-dir P  Override the operating system user data directory\n  --headless    Run the desktop runtime without a native window\n  --port N      Headless gateway port; 0 selects an available port\n  --smoke       Verify startup and exit (temporary data by default)\n  --help        Show this help\n\nNative Deno Desktop assigns a private loopback port automatically.\nEnvironment: HEIMDALL_DESKTOP_DATA_DIR, HEIMDALL_DESKTOP_PORT (headless)`,
        );
        return;
    }
    if (!options.headless && options.port !== undefined) {
        throw new Error(
            "--port is available in headless mode. Native Deno Desktop assigns its own private loopback port.",
        );
    }
    const native = options.headless
        ? undefined
        : officialDesktopNative(options.nativeBackend);
    const temporaryDirectory = options.smoke && !options.dataDirectory
        ? await Deno.makeTempDir({ prefix: "heimdall-desktop-smoke-" })
        : undefined;
    let temporaryCleaned = false;
    const cleanTemporary = async () => {
        if (temporaryDirectory && !temporaryCleaned) {
            // This exact path was allocated by makeTempDir in this invocation.
            await Deno.remove(temporaryDirectory, { recursive: true });
            temporaryCleaned = true;
        }
    };
    try {
        const configuration = await createDesktopConfiguration(
            options,
            temporaryDirectory,
        );
        // The official runtime can create its initial browser before user code.
        // Launch wrappers set this earlier; retain it for later native windows.
        if (
            Deno.build.os === "windows" && !options.smoke &&
            !Deno.env.get("WEBVIEW2_USER_DATA_FOLDER")
        ) {
            Deno.env.set(
                "WEBVIEW2_USER_DATA_FOLDER",
                configuration.profileDirectory,
            );
        }
        let origin = "";
        let bootstrapToken = configuration.bootstrapToken;
        await using runtime = await startRuntime({
            environment: configuration.environment,
            desktopSession: {
                origin: () => origin,
                bootstrapToken: () => bootstrapToken,
            },
        });
        origin = runtime.url;
        if (
            runtime.address.hostname !== "127.0.0.1" &&
            runtime.address.hostname !== "::1"
        ) {
            throw new Error(
                "Desktop runtime must listen only on a loopback address.",
            );
        }
        console.log(`[desktop] Gateway ${origin}/v1`);
        console.log(`[desktop] Data ${configuration.dataDirectory}`);
        const mintBootstrap = () => {
            bootstrapToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
            return `${origin}/admin/desktop/bootstrap#token=${
                encodeURIComponent(bootstrapToken)
            }`;
        };
        if (!native) {
            if (options.smoke) {
                await verifyDesktopRuntime(
                    origin,
                    configuration.adminToken,
                    bootstrapToken,
                );
            } else await waitForShutdown(runtime.finished);
            await runtime.close();
            if (options.smoke) reportSmokePassed(false);
        } else {
            const icon = await Deno.readFile(
                new URL("./icon.png", import.meta.url),
            );
            let smokeChecksPassed = false;
            const windowState = createDesktopWindowStateStore(
                configuration.dataDirectory,
            );
            await using host = createDesktopHost({
                native,
                trayEnabled: options.tray ?? false,
                origin,
                icon,
                bootstrapUrl: mintBootstrap,
                debug: options.debug,
                initialWindowState: await windowState.load(),
                onSaveWindowState: (state) => windowState.save(state),
                onOpenDataDirectory: () =>
                    openDesktopDataDirectory(configuration.dataDirectory),
                onCopyGateway: (url) => navigator.clipboard.writeText(url),
                async onQuit() {
                    await runtime.close();
                    await cleanTemporary();
                    // Destroying the final native window may stop Deno before
                    // another JS turn. The launcher also checks process exit.
                    if (smokeChecksPassed) {
                        reportSmokePassed(true, options.tray ?? false);
                    }
                    console.log(
                        "[desktop] Runtime stopped; storage, plugins and background work closed.",
                    );
                },
            });
            // A tray quit during bootstrap must not leave startup awaiting a
            // renderer that is already being destroyed.
            await Promise.race([host.ready, host.finished]);
            if (!host.isReady()) {
                await host.finished;
                return;
            }
            if (options.smoke) {
                // Deno may show its precreated window again at the ten-second
                // mark. Keep acceptance alive past that native startup path.
                await delay(11_000);
                mintBootstrap();
                await verifyDesktopRuntime(
                    origin,
                    configuration.adminToken,
                    bootstrapToken,
                );
                await verifyDesktopWindow(
                    host.currentWindow(),
                    native.physicalWindowCoordinates,
                    options.tray ?? false,
                );
                if (!options.tray) {
                    smokeChecksPassed = true;
                    await host.currentWindow().executeJs(
                        `setTimeout(() => document.querySelector('[data-desktop-command="hide"]').click(), 0); true`,
                    );
                    await waitForNativeState(
                        () => host.isQuitting(),
                        "Desktop close button did not exit the application.",
                    );
                    await host.finished;
                    return;
                }
                await waitForNativeState(
                    () => !host.currentWindow().isVisible(),
                    "Desktop window did not hide to the tray.",
                );
                host.show();
                await waitForNativeState(
                    () => host.currentWindow().isVisible(),
                    "Desktop window did not become visible after tray restore.",
                );
                host.currentWindow().close();
                await waitForNativeState(
                    () => host.currentWindow().isClosed(),
                    "Desktop window did not finish closing.",
                );
                host.show("/admin/chat");
                await waitForNativeState(
                    () => host.isReady() && host.currentWindow().isVisible(),
                    "Desktop window could not be restored from the tray.",
                );
                console.log(
                    "[desktop] Native smoke passed: titlebar, bindings, expand/restore, always-on-top, tray, hide/show and close/reopen.",
                );
                smokeChecksPassed = true;
                await host.quit();
            } else {
                await Promise.race([
                    host.finished,
                    waitForShutdown(runtime.finished),
                ]);
                await host.quit();
            }
        }
    } finally {
        await cleanTemporary();
    }
}

async function openDesktopDataDirectory(directory: string): Promise<void> {
    const command = Deno.build.os === "windows"
        ? "explorer.exe"
        : Deno.build.os === "darwin"
        ? "open"
        : "xdg-open";
    // Only the host-owned path reaches the OS opener; never renderer input or a shell.
    const result = await new Deno.Command(command, {
        args: [directory],
        stdin: "null",
        stdout: "null",
        stderr: "null",
    }).output();
    // Explorer can return 1 when an existing shell instance handles the request.
    if (!result.success && Deno.build.os !== "windows") {
        throw new Error("Cannot open desktop data directory.");
    }
}

async function waitForShutdown(finished: Promise<void>): Promise<void> {
    const signals: Deno.Signal[] = Deno.build.os === "windows"
        ? ["SIGINT"]
        : ["SIGINT", "SIGTERM"];
    const stopped = Promise.withResolvers<void>();
    const stop = () => stopped.resolve();
    for (const signal of signals) Deno.addSignalListener(signal, stop);
    try {
        await Promise.race([stopped.promise, finished]);
    } finally {
        for (const signal of signals) Deno.removeSignalListener(signal, stop);
    }
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForNativeState(
    predicate: () => boolean,
    message: string,
): Promise<void> {
    // Official native operations cross an asynchronous runtime/backend boundary.
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await delay(100);
    }
    throw new Error(message);
}

export async function showDesktopError(error: unknown): Promise<void> {
    const message = error instanceof Error
        ? error.stack ?? error.message
        : String(error);
    console.error(`[desktop] ${message}`);
    const report = Deno.env.get("HEIMDALL_DESKTOP_SMOKE_REPORT");
    if (report && Deno.args.includes("--smoke")) {
        try {
            Deno.writeTextFileSync(
                report,
                JSON.stringify({ status: "failed", error: message }),
            );
        } catch { /* Preserve the original startup failure. */ }
    }
    if (Deno.args.includes("--smoke")) return;
    try {
        const directory = desktopDataDirectory();
        await Deno.mkdir(directory, { recursive: true });
        await Deno.writeTextFile(
            join(directory, "desktop-error.log"),
            `${new Date().toISOString()} ${message}\n`,
            { append: true },
        );
    } catch {
        /* Preserve the original failure if error logging itself fails. */
    }
}

function reportSmokePassed(native: boolean, trayEnabled = false): void {
    const path = Deno.env.get("HEIMDALL_DESKTOP_SMOKE_REPORT");
    if (path) {
        Deno.writeTextFileSync(
            path,
            JSON.stringify(
                {
                    status: "passed",
                    native,
                    trayEnabled,
                    checks: native
                        ? [
                            "loopback",
                            "authentication",
                            "plugins",
                            "assets",
                            "titlebar-bindings",
                            "expand-restore",
                            "window-drag",
                            "edge-resize",
                            "always-on-top",
                            ...(trayEnabled
                                ? ["tray", "hide-show", "close-reopen"]
                                : ["tray-disabled", "close-exits"]),
                            "runtime-shutdown",
                        ]
                        : [
                            "loopback",
                            "authentication",
                            "plugins",
                            "assets",
                            "runtime-shutdown",
                        ],
                },
                null,
                2,
            ),
        );
    }
}
