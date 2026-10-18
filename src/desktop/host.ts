import type { DesktopNative, DesktopTray, DesktopWindow } from "./native.ts";
import { unwrapDesktopResult } from "./native.ts";
import { createWindowControls } from "./window-controls.ts";
import {
    DEFAULT_DESKTOP_WINDOW_STATE,
    type DesktopWindowState,
} from "./window-state.ts";

export interface DesktopHostOptions {
    readonly native: DesktopNative;
    readonly origin: string;
    readonly icon: Uint8Array;
    /** Mint a fresh single-use token for each replacement window. */
    readonly bootstrapUrl: () => string;
    readonly onQuit: () => Promise<void>;
    readonly onCopyGateway?: (url: string) => Promise<void>;
    readonly onOpenDataDirectory?: () => Promise<void>;
    readonly initialWindowState?: DesktopWindowState;
    readonly onSaveWindowState?: (state: DesktopWindowState) => Promise<void>;
    readonly debug?: boolean;
    readonly trayEnabled?: boolean;
}

/** Own native windows, scoped renderer capabilities and the resident gateway. */
export function createDesktopHost(options: DesktopHostOptions) {
    const trayEnabled = options.trayEnabled ?? true;
    let windowState = options.initialWindowState ??
        DEFAULT_DESKTOP_WINDOW_STATE;
    const resources = createNativeResources(options, windowState);
    let current = resources.main;
    const { keeper, startup, tray } = resources;
    const destroyed = new WeakSet<DesktopWindow>();
    const ready = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let quitting: Promise<void> | undefined;
    let desiredPath = "/admin/chat";
    let bootstrapping = true;
    let loaded = false;
    let visible = true;
    let inspection = 0;
    let controls: ReturnType<typeof createWindowControls>;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(
        () =>
            fail(
                new Error(
                    "Native desktop navigation did not become ready within 30 seconds.",
                ),
            ),
        30_000,
    );
    void ready.promise.catch(() => undefined);
    void finished.promise.catch(() => undefined);

    function save(): Promise<void> {
        clearTimeout(saveTimer);
        return options.onSaveWindowState?.(windowState).catch((error) => {
            console.error("[desktop] Cannot save window state:", error);
        }) ?? Promise.resolve();
    }

    function changed(state: DesktopWindowState): void {
        windowState = state;
        clearTimeout(saveTimer);
        if (!quitting && options.onSaveWindowState) {
            saveTimer = setTimeout(() => void save(), 500);
        }
        if (!quitting) tray?.setMenu(menu());
    }

    function destroyWindow(target: DesktopWindow): void {
        if (destroyed.has(target)) return;
        destroyed.add(target);
        target.close();
    }

    function watchWindow(target: DesktopWindow): void {
        const scoped = createWindowControls({
            window: target,
            origin: options.origin,
            initial: windowState,
            physicalCoordinates: options.native.physicalWindowCoordinates,
            trayEnabled,
            active: () => target === current && loaded && !quitting,
            menu,
            action,
            changed,
        });
        controls = scoped;
        target.addEventListener("close", () => {
            if (!trayEnabled && target === current) {
                loaded = false;
                inspection++;
                void quit().catch(fail);
                return;
            }
            if (!quitting) {
                scoped.remember();
                scoped.dispose();
                void save();
            }
            if (target === current) {
                loaded = false;
                inspection++;
            }
            // Native close is deferred and not cancelable; finish destruction.
            destroyWindow(target);
        });
        target.addEventListener("load", () => {
            if (target !== current || quitting) return;
            loaded = false;
            scoped.revoke();
            const sequence = ++inspection;
            void inspectLoadedWindow(target, sequence).catch((error) => {
                if (
                    target === current && !target.isClosed() && !quitting &&
                    sequence === inspection
                ) fail(error);
            });
        });
        for (const event of ["resize", "move"]) {
            target.addEventListener(event, () => {
                if (target === current && !quitting) scoped.remember();
            });
        }
        for (const event of ["menuclick", "contextmenuclick"]) {
            target.addEventListener(event, (event) => {
                if (target === current && !target.isClosed() && !quitting) {
                    action((event as CustomEvent<{ id: string }>).detail.id);
                }
            });
        }
    }

    async function inspectLoadedWindow(
        target: DesktopWindow,
        sequence: number,
    ): Promise<void> {
        if (target !== current || target.isClosed() || quitting) return;
        const result = await target.executeJs(`(() => {
            const boot = document.getElementById("heimdall-boot") || document.getElementById("heimdall-chat-boot");
            let authenticated = false;
            try { const value = JSON.parse(boot?.textContent || "{}"); authenticated = !!(value.authenticated || value.snapshot?.authenticated || value.initial?.authenticated); } catch {}
            return { href: location.href, path: location.pathname, authenticated, main: !!document.querySelector("#chat-main, main, [role=main]") };
        })()`);
        if (
            target !== current || target.isClosed() || quitting ||
            sequence !== inspection
        ) return;
        const value = unwrapDesktopResult(result);
        if (!value || typeof value !== "object") return;
        const page = value as {
            href?: string;
            path?: string;
            authenticated?: boolean;
            main?: boolean;
        };
        let url: URL;
        try {
            url = new URL(page.href ?? "");
        } catch {
            return;
        }
        if (
            url.origin !== options.origin || url.username || url.password ||
            page.path !== url.pathname ||
            !(url.pathname === "/admin" ||
                url.pathname.startsWith("/admin/")) ||
            url.pathname === "/admin/desktop/bootstrap" ||
            page.authenticated !== true || page.main !== true
        ) return;
        const first = bootstrapping;
        bootstrapping = false;
        loaded = true;
        if (first && desiredPath !== "/admin/chat") {
            loaded = false;
            target.navigate(`${options.origin}${desiredPath}`);
            return;
        }
        await controls.grant();
        if (
            target !== current || target.isClosed() || quitting ||
            sequence !== inspection
        ) return;
        if (visible) target.show();
        if (visible && first) target.focus();
        if (options.debug && first) target.openDevtools();
        destroyWindow(startup);
        clearTimeout(timeout);
        ready.resolve();
    }

    function fail(error: unknown): void {
        clearTimeout(timeout);
        ready.reject(error);
        finished.reject(error);
    }

    function show(path?: "/admin/chat" | "/admin"): void {
        if (quitting) return;
        visible = true;
        if (path) desiredPath = path;
        if (current.isClosed()) {
            current = options.native.createWindow(
                mainWindowOptions(windowState),
            );
            loaded = false;
            bootstrapping = true;
            watchWindow(current);
            current.navigate(options.bootstrapUrl());
        } else if (path && !bootstrapping) {
            controls.revoke();
            loaded = false;
            current.navigate(`${options.origin}${path}`);
        }
        current.show();
        current.focus();
    }

    function hide(): void {
        if (quitting || current.isClosed()) return;
        if (!trayEnabled) {
            void quit().catch(fail);
            return;
        }
        visible = false;
        controls.remember();
        current.hide();
        void save();
    }

    function menu(): Deno.MenuItem[] {
        const item = (
            id: string,
            label: string,
            enabled = true,
        ): Deno.MenuItem => ({ item: { id, label, enabled } });
        return [
            item("show", "显示主窗口"),
            item("chat", "打开 Chat"),
            item("console", "管理控制台"),
            "separator",
            item("gateway-address", `${options.origin}/v1`, false),
            item("copy-gateway", "复制网关地址", !!options.onCopyGateway),
            item("open-data", "打开数据目录", !!options.onOpenDataDirectory),
            "separator",
            {
                item: {
                    id: "always-on-top",
                    label: "窗口置顶",
                    enabled: true,
                    checked: windowState.alwaysOnTop ?? false,
                },
            },
            item("reset-window", "重置窗口位置与大小"),
            item("reload", "重新加载界面"),
            ...(options.debug ? [item("devtools", "开发者工具")] : []),
            ...(trayEnabled ? [item("hide", "隐藏到托盘")] : []),
            "separator",
            item("quit", "退出 Heimdall"),
        ];
    }

    function action(id: string): void {
        if (quitting) return;
        if (id === "show") show();
        else if (id === "chat") show("/admin/chat");
        else if (id === "console") show("/admin");
        else if (id === "hide") hide();
        else if (id === "copy-gateway") {
            void options.onCopyGateway?.(`${options.origin}/v1`).catch((
                error,
            ) => console.error(
                "[desktop] Cannot copy gateway address:",
                error,
            ));
        } else if (id === "open-data") {
            void options.onOpenDataDirectory?.().catch((error) =>
                console.error("[desktop] Cannot open data directory:", error)
            );
        } else if (id === "quit") void quit().catch(fail);
        else if (
            ["always-on-top", "reset-window", "reload", "devtools"].includes(id)
        ) {
            if (current.isClosed()) show();
            if (id === "always-on-top") controls.toggleAlwaysOnTop();
            else if (id === "reset-window") {
                controls.reset();
                show();
            } else if (id === "reload" && loaded) {
                controls.revoke();
                loaded = false;
                current.reload();
            } else if (id === "devtools" && options.debug) {
                current.openDevtools();
            }
        }
    }

    function quit(): Promise<void> {
        if (quitting) return quitting;
        const completion = Promise.withResolvers<void>();
        quitting = completion.promise;
        clearTimeout(timeout);
        clearTimeout(saveTimer);
        void (async () => {
            const failures: unknown[] = [];
            function cleanup(action: () => void): void {
                try {
                    action();
                } catch (error) {
                    failures.push(error);
                }
            }
            async function shutdown(
                action: () => Promise<void>,
            ): Promise<void> {
                try {
                    await action();
                } catch (error) {
                    failures.push(error);
                }
            }
            // Native getters and unbind can fail as a WebView is being closed.
            // Every owned resource must still be released before reporting it.
            cleanup(() => controls.remember());
            cleanup(() => controls.dispose());
            await shutdown(save);
            await shutdown(options.onQuit);
            cleanup(() => tray?.destroy());
            cleanup(() => destroyWindow(current));
            cleanup(() => destroyWindow(startup));
            cleanup(() => destroyWindow(keeper));
            // The final native close may stop the desktop loop. Settle these
            // promises in this turn without another await after destruction.
            if (failures.length > 0) {
                const error = failures.length === 1
                    ? failures[0]
                    : new AggregateError(failures, "Desktop shutdown failed.");
                finished.reject(error);
                completion.reject(error);
            } else {
                finished.resolve();
                completion.resolve();
            }
        })();
        return quitting;
    }

    try {
        tray?.setMenu(menu());
        tray?.addEventListener("click", () => show());
        tray?.addEventListener("dblclick", () => show());
        tray?.addEventListener(
            "menuclick",
            (event) => action((event as CustomEvent<{ id: string }>).detail.id),
        );
        watchWindow(current);
        current.navigate(options.bootstrapUrl());
    } catch (error) {
        clearTimeout(timeout);
        try {
            tray?.destroy();
        } finally {
            try {
                destroyWindow(current);
            } finally {
                try {
                    destroyWindow(startup);
                } finally {
                    destroyWindow(keeper);
                }
            }
        }
        throw error;
    }
    return {
        ready: ready.promise,
        finished: finished.promise,
        show,
        hide,
        quit,
        currentWindow: () => current,
        isReady: () => loaded && !current.isClosed(),
        isQuitting: () => quitting !== undefined,
        [Symbol.asyncDispose]: quit,
    };
}

function mainWindowOptions(
    state: DesktopWindowState,
): Deno.BrowserWindowOptions {
    // WebView2's native sizing frame adds a white nonclient strip. The page's
    // edge handles resize via setSize/setPosition without that frame.
    return {
        title: "Heimdall",
        frameless: true,
        resizable: Deno.build.os !== "windows",
        ...state,
    };
}

function createNativeResources(
    options: DesktopHostOptions,
    state: DesktopWindowState,
): {
    main: DesktopWindow;
    keeper: DesktopWindow;
    startup: DesktopWindow;
    tray: DesktopTray | undefined;
} {
    let main: DesktopWindow | undefined;
    let keeper: DesktopWindow | undefined;
    let startup: DesktopWindow | undefined;
    let tray: DesktopTray | undefined;
    try {
        // Deno's initial window ignores creation flags and is shown again after
        // ten seconds. Retire it after bootstrap; a separate utility window
        // keeps the event loop alive without appearing in the taskbar.
        startup = options.native.createWindow({ title: "Heimdall Startup" });
        startup.setOpacity(0);
        startup.hide();
        keeper = options.native.createWindow({
            title: "Heimdall Background",
            width: 1,
            height: 1,
            opacity: 0,
            frameless: true,
            resizable: false,
            noActivate: true,
        });
        keeper.setOpacity(0);
        keeper.hide();
        const background = keeper;
        background.addEventListener("load", () => {
            if (!background.isClosed()) background.hide();
        });
        main = options.native.createWindow(mainWindowOptions(state));
        if (options.trayEnabled !== false) {
            tray = options.native.createTray();
            tray.setIcon(options.icon);
            tray.setTooltip(`Heimdall · 网关运行中 · ${options.origin}/v1`);
        }
        return { main, keeper, startup, tray };
    } catch (error) {
        try {
            tray?.destroy();
        } catch { /* Preserve startup error. */ }
        try {
            main?.close();
        } catch { /* Release every resource. */ }
        try {
            keeper?.close();
        } catch { /* Preserve startup error. */ }
        try {
            startup?.close();
        } catch { /* Preserve startup error. */ }
        throw error;
    }
}
