/** The official Deno Desktop API is available only in `deno desktop` apps.
 * https://github.com/denoland/deno/blob/v2.9.6/cli/tsc/dts/lib.deno.desktop.d.ts
 */
export interface DesktopWindow extends EventTarget {
    bind(
        name: string,
        handler: (...args: unknown[]) => Promise<{
            expanded: boolean;
            alwaysOnTop: boolean;
            trayEnabled: boolean;
        }>,
    ): void;
    unbind(name: string): void;
    getSize(): [number, number];
    setSize(width: number, height: number): void;
    getPosition(): [number, number];
    setPosition(x: number, y: number): void;
    setOpacity(opacity: number): void;
    isAlwaysOnTop(): boolean;
    setAlwaysOnTop(value: boolean): void;
    reload(): void;
    showContextMenu(x: number, y: number, menu: Deno.MenuItem[]): void;
    isClosed(): boolean;
    isVisible(): boolean;
    show(): void;
    hide(): void;
    focus(): void;
    close(): void;
    navigate(url: string): void;
    executeJs(script: string): Promise<unknown>;
    openDevtools(options?: Deno.OpenDevtoolsOptions): void;
}

export interface DesktopTray extends EventTarget {
    setIcon(bytes: Uint8Array): void;
    setTooltip(text: string): void;
    setMenu(menu: Deno.MenuItem[]): void;
    destroy(): void;
}

/** Structural adapter keeps window/tray lifecycle tests independent of a GUI. */
export interface DesktopNative {
    readonly physicalWindowCoordinates?: boolean;
    createWindow(options: Deno.BrowserWindowOptions): DesktopWindow;
    createTray(): DesktopTray;
}

/** Deno 2.9.6 envelopes executeJs results; newer runtimes return the value. */
export function unwrapDesktopResult(result: unknown): unknown {
    if (result && typeof result === "object" && "ok" in result) {
        if (result.ok === false) {
            throw new Error("Native renderer evaluation failed.");
        }
        if (result.ok === true && "value" in result) return result.value;
    }
    return result;
}

export function officialDesktopNative(
    backend: "webview" | "cef" = "webview",
): DesktopNative {
    if (
        typeof Deno.BrowserWindow !== "function" ||
        typeof Deno.Tray !== "function"
    ) {
        throw new Error(
            "Native desktop APIs are unavailable. Start with deno task desktop; use --headless only for runtime diagnostics.",
        );
    }
    return {
        physicalWindowCoordinates: Deno.build.os === "windows" &&
            backend === "webview",
        createWindow: (options) => new Deno.BrowserWindow(options),
        createTray: () => new Deno.Tray(),
    };
}
