import {
    assert,
    assertEquals,
    assertNotEquals,
    assertRejects,
    assertThrows,
} from "@std/assert";
import {
    createDesktopHost,
    type DesktopHostOptions,
} from "@heimdall/core/desktop/host.ts";
import type {
    DesktopNative,
    DesktopTray,
    DesktopWindow,
} from "@heimdall/core/desktop/native.ts";

const origin = "http://127.0.0.1:54321";
type DesktopCallback = Parameters<DesktopWindow["bind"]>[1];

/** Native load callbacks do not await their JS listeners. */
function nextTurn(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

class NativeWindow extends EventTarget implements DesktopWindow {
    visible = true;
    reportedClosed = false;
    physicallyClosed = false;
    closeCalls = 0;
    readonly navigations: string[] = [];
    readonly commandsAfterDestruction: string[] = [];
    readonly scripts: string[] = [];
    readonly bindings = new Map<string, DesktopCallback>();
    readonly contextMenus: Array<{
        x: number;
        y: number;
        menu: Deno.MenuItem[];
    }> = [];
    size: [number, number];
    position: [number, number] = [100, 120];
    opacity = 1;
    alwaysOnTop = false;
    reloadCalls = 0;
    unbindCalls = 0;
    sizeError: Error | undefined;
    unbindError: Error | undefined;
    page: unknown = { href: "about:blank" };
    inspectionError: Error | undefined;
    pendingInspection: Promise<unknown> | undefined;

    constructor(
        readonly backend: NativeBackend,
        readonly options: Deno.BrowserWindowOptions,
    ) {
        super();
        // Deno consumes a precreated native window for the first constructor.
        this.size = backend.windows.length === 0
            ? [1280, 840]
            : [options.width ?? 1280, options.height ?? 840];
        if (backend.windows.length > 0) {
            this.position = [options.x ?? 100, options.y ?? 120];
            this.alwaysOnTop = options.alwaysOnTop ?? false;
            this.opacity = options.opacity ?? 1;
        }
    }

    isClosed(): boolean {
        return this.reportedClosed;
    }

    isVisible(): boolean {
        return this.visible && !this.physicallyClosed;
    }

    show(): void {
        if (this.physicallyClosed) this.commandsAfterDestruction.push("show");
        this.visible = true;
    }

    hide(): void {
        if (this.physicallyClosed) this.commandsAfterDestruction.push("hide");
        this.visible = false;
    }

    focus(): void {
        if (this.physicallyClosed) this.commandsAfterDestruction.push("focus");
        this.backend.focused = this;
    }

    close(): void {
        this.closeCalls++;
        this.reportedClosed = true;
        this.physicallyClosed = true;
        this.visible = false;
        this.backend.recordWindowDestruction();
    }

    /** Deno 2.9.6 reports the X click before the deferred OS destruction. */
    requestClose(): void {
        this.reportedClosed = true;
        this.dispatchEvent(new Event("close"));
    }

    navigate(url: string): void {
        if (this.physicallyClosed) {
            this.commandsAfterDestruction.push("navigate");
        }
        this.navigations.push(url);
    }

    executeJs(script: string): Promise<unknown> {
        if (this.physicallyClosed) {
            this.commandsAfterDestruction.push("executeJs");
        }
        this.scripts.push(script);
        if (
            !script.includes("location.href") ||
            !script.includes("authenticated")
        ) {
            return Promise.resolve({ ok: true, value: null });
        }
        if (this.pendingInspection) return this.pendingInspection;
        return this.inspectionError
            ? Promise.reject(this.inspectionError)
            : Promise.resolve(this.page);
    }

    openDevtools(): void {}

    bind(
        name: string,
        handler: DesktopCallback,
    ): void {
        this.bindings.set(name, handler);
    }

    unbind(name: string): void {
        this.unbindCalls++;
        if (this.unbindError) throw this.unbindError;
        this.bindings.delete(name);
    }

    getSize(): [number, number] {
        if (this.sizeError) throw this.sizeError;
        return [...this.size];
    }

    setSize(width: number, height: number): void {
        if (this.physicallyClosed) {
            this.commandsAfterDestruction.push("setSize");
        }
        this.size = [width, height];
    }

    getPosition(): [number, number] {
        return [...this.position];
    }

    setPosition(x: number, y: number): void {
        if (this.physicallyClosed) {
            this.commandsAfterDestruction.push("setPosition");
        }
        this.position = [x, y];
    }

    setOpacity(opacity: number): void {
        this.opacity = opacity;
    }

    isAlwaysOnTop(): boolean {
        return this.alwaysOnTop;
    }

    setAlwaysOnTop(alwaysOnTop: boolean): void {
        if (this.physicallyClosed) {
            this.commandsAfterDestruction.push("setAlwaysOnTop");
        }
        this.alwaysOnTop = alwaysOnTop;
    }

    reload(): void {
        if (this.physicallyClosed) this.commandsAfterDestruction.push("reload");
        this.reloadCalls++;
    }

    showContextMenu(x: number, y: number, menu: Deno.MenuItem[]): void {
        if (this.physicallyClosed) {
            this.commandsAfterDestruction.push("showContextMenu");
        }
        this.contextMenus.push({ x, y, menu });
    }

    get bridgeToken(): string | undefined {
        for (const script of this.scripts.toReversed()) {
            const value = /const token\s*=\s*("(?:\\.|[^"\\])*")/.exec(script)
                ?.[1];
            if (value) return JSON.parse(value);
        }
        return undefined;
    }

    get bridge() {
        const invoke = this.bindings.get("__heimdallDesktopInvoke");
        assert(invoke, "The window must register its native IPC handler");
        return invoke;
    }

    invoke(
        command: string,
        payload?: unknown,
    ): ReturnType<DesktopCallback> {
        assert(
            this.bridgeToken,
            "Only an authenticated page receives a bridge token",
        );
        return this.bridge(this.bridgeToken, command, payload);
    }

    async load(
        path: string,
        authenticated = false,
        envelope = true,
    ): Promise<void> {
        const page = {
            href: `${origin}${path}`,
            path,
            authenticated,
            main: true,
        };
        await this.loadPage(page, envelope);
    }

    async loadPage(page: unknown, envelope = true): Promise<void> {
        this.page = envelope ? { ok: true, value: page } : page;
        this.dispatchEvent(new Event("load"));
        await nextTurn();
    }
}

class NativeTray extends EventTarget implements DesktopTray {
    destroyed = false;
    menu: Deno.MenuItem[] = [];

    constructor(readonly backend: NativeBackend) {
        super();
    }

    setIcon(_bytes: Uint8Array): void {
        if (this.backend.setupFailure === "icon") {
            throw new Error("native icon failed");
        }
    }

    setTooltip(_text: string): void {}

    setMenu(menu: Deno.MenuItem[]): void {
        if (this.backend.setupFailure === "menu") {
            throw new Error("native menu failed");
        }
        this.menu = menu;
    }

    destroy(): void {
        this.destroyed = true;
    }

    select(id: string): void {
        assert(
            this.menu.some((entry) =>
                typeof entry === "object" && "item" in entry &&
                entry.item.id === id && entry.item.enabled
            ),
            `The native tray must expose an enabled ${id} action`,
        );
        this.dispatchEvent(new CustomEvent("menuclick", { detail: { id } }));
    }
}

/** The real Windows backend stops once its final physical window disappears. */
class NativeBackend implements DesktopNative {
    readonly windows: NativeWindow[] = [];
    readonly tray = new NativeTray(this);
    physicalWindowCoordinates?: boolean;
    trayCreationCalls = 0;
    focused: NativeWindow | undefined;
    loopStopped = false;
    setupFailure: "window" | "tray" | "icon" | "menu" | undefined;

    createWindow(options: Deno.BrowserWindowOptions): NativeWindow {
        if (this.setupFailure === "window" && this.windows.length === 2) {
            throw new Error("native window failed");
        }
        assert(
            !this.loopStopped,
            "A stopped native loop cannot create windows",
        );
        const window = new NativeWindow(this, options);
        this.windows.push(window);
        return window;
    }

    createTray(): NativeTray {
        this.trayCreationCalls++;
        if (this.setupFailure === "tray") {
            throw new Error("native tray failed");
        }
        return this.tray;
    }

    recordWindowDestruction(): void {
        if (this.windows.every((window) => window.physicallyClosed)) {
            this.loopStopped = true;
        }
    }

    get main(): NativeWindow {
        return this.windows[2]!;
    }

    get keeper(): NativeWindow {
        return this.windows[1]!;
    }

    get initial(): NativeWindow {
        return this.windows[0]!;
    }

    get liveWindows(): NativeWindow[] {
        return this.windows.filter((window) => !window.physicallyClosed);
    }
}

function startHost(
    native = new NativeBackend(),
    onQuit: () => Promise<void> = () => Promise.resolve(),
    onCopyGateway?: (url: string) => Promise<void>,
    extra: Partial<DesktopHostOptions> = {},
) {
    let token = 0;
    const host = createDesktopHost({
        native,
        origin,
        icon: new Uint8Array([1, 2, 3]),
        bootstrapUrl: () =>
            `${origin}/admin/desktop/bootstrap#token=single-use-${++token}`,
        onQuit,
        onCopyGateway,
        ...extra,
    });
    return { native, host };
}

async function makeReady(
    subject: ReturnType<typeof startHost>,
    envelope = true,
): Promise<void> {
    await subject.native.main.load("/admin/chat", true, envelope);
    await subject.host.ready;
}

for (const envelope of [true, false]) {
    Deno.test(`desktop bootstraps its main native window immediately (${envelope ? "2.9.6 envelope" : "unwrapped result"})`, async () => {
        const subject = startHost();
        await using host = subject.host;
        await nextTurn();
        assertEquals(subject.native.keeper.opacity, 0);
        assertEquals(subject.native.keeper.isVisible(), false);
        assertEquals(subject.native.main.options.frameless, true);
        const bootstrap = subject.native.main.navigations.at(-1)!;
        assertEquals(new URL(bootstrap).pathname, "/admin/desktop/bootstrap");
        assertEquals(host.isReady(), false);

        await subject.native.initial.load("/", false, envelope);
        await subject.native.keeper.load("/", false, envelope);
        assertEquals(subject.native.main.navigations, [bootstrap]);

        await subject.native.main.load(
            "/admin/desktop/bootstrap",
            false,
            envelope,
        );
        await subject.native.main.load("/admin/chat", false, envelope);
        assertEquals(host.isReady(), false, "The login screen is not ready");
        await subject.native.main.load("/admin/chat", true, envelope);
        await host.ready;
        assert(host.isReady());
        assert(subject.native.main.isVisible());
        assertEquals(subject.native.focused, subject.native.main);
    });
}

Deno.test("desktop replaces the precreated placeholder with a nonactivating frameless keeper after authentication", async () => {
    const subject = startHost();
    await using host = subject.host;
    const { initial, keeper, main } = subject.native;
    assertEquals(subject.native.windows.length, 3);
    assertEquals(initial.getSize(), [1280, 840]);
    assertEquals(initial.opacity, 0);
    assertEquals(initial.isVisible(), false);
    assertEquals(initial.closeCalls, 0);
    assertEquals(keeper.options.noActivate, true);
    assertEquals(keeper.options.frameless, true);
    assertEquals(keeper.opacity, 0);
    assertEquals(keeper.isVisible(), false);
    assertEquals(main.options.frameless, true);

    await initial.load("/");
    await main.load("/admin/desktop/bootstrap");
    await main.load("/admin/chat", false);
    assertEquals(initial.closeCalls, 0);
    await makeReady(subject);
    assertEquals(initial.closeCalls, 1);
    assertEquals(initial.physicallyClosed, true);
    assertEquals(subject.native.liveWindows, [keeper, main]);
    assertEquals(subject.native.loopStopped, false);
    await main.load("/admin/chat", true);
    assertEquals(initial.closeCalls, 1);
    await host.quit();
    assertEquals(initial.closeCalls, 1);
    assertEquals(subject.native.liveWindows, []);
});

Deno.test("desktop X destroys the deferred window while its tray can reopen an authenticated window", async () => {
    const subject = startHost();
    await using host = subject.host;
    await makeReady(subject);
    const original = subject.native.main;
    const firstBootstrap = original.navigations[0];

    original.requestClose();
    assert(original.physicallyClosed, "X must complete the deferred close");
    assertEquals(original.closeCalls, 1);
    assertEquals(subject.native.loopStopped, false);
    assert(subject.native.liveWindows.length > 0);
    assert(subject.native.liveWindows.every((window) => !window.isVisible()));
    assertEquals(subject.native.tray.destroyed, false);
    assertEquals(host.isReady(), false);

    subject.native.tray.select("show");
    const restored = host.currentWindow() as NativeWindow;
    assertNotEquals(restored, original);
    assertNotEquals(restored.navigations[0], firstBootstrap);
    assertEquals(
        new URL(restored.navigations[0]!).pathname,
        "/admin/desktop/bootstrap",
    );
    await restored.load("/admin/chat", true);
    assert(host.isReady());
    assert(restored.isVisible());

    await host.quit();
    assertEquals(original.closeCalls, 1);
    assertEquals(subject.native.liveWindows.length, 0);
    assert(subject.native.tray.destroyed);
});

Deno.test("desktop tray actions hide, restore, switch views and exit without discarding the live window", async () => {
    const subject = startHost();
    await using host = subject.host;
    await makeReady(subject);
    const window = subject.native.main;
    const initialWindowCount = subject.native.windows.length;

    for (const event of ["click", "dblclick"]) {
        subject.native.tray.select("hide");
        assertEquals(window.isVisible(), false);
        assertEquals(window.physicallyClosed, false);
        subject.native.tray.dispatchEvent(new Event(event));
        assert(window.isVisible());
        assertEquals(subject.native.focused, window);
    }
    subject.native.tray.select("console");
    assertEquals(window.navigations.at(-1), `${origin}/admin`);
    await window.load("/admin", true);
    subject.native.tray.select("chat");
    assertEquals(window.navigations.at(-1), `${origin}/admin/chat`);
    await window.load("/admin/chat", true);
    subject.native.tray.select("hide");
    subject.native.tray.select("show");
    assert(window.isVisible());
    assertEquals(subject.native.windows.length, initialWindowCount);

    subject.native.tray.select("quit");
    await host.finished;
    assert(subject.native.tray.destroyed);
    assertEquals(subject.native.liveWindows.length, 0);
});

for (const trigger of ["bridge hide", "native close"] as const) {
    Deno.test(`desktop without a tray gracefully shuts down on ${trigger}`, async () => {
        const native = new NativeBackend();
        native.setupFailure = "tray";
        const shutdown = Promise.withResolvers<void>();
        let quits = 0;
        const subject = startHost(
            native,
            () => {
                quits++;
                return shutdown.promise;
            },
            undefined,
            { trayEnabled: false },
        );
        await using host = subject.host;
        try {
            await makeReady(subject);
            const window = native.main;
            assertEquals(native.trayCreationCalls, 0);
            assertEquals(await window.invoke("state"), {
                expanded: false,
                alwaysOnTop: false,
                trayEnabled: false,
            });
            if (Deno.build.os === "windows") {
                assertEquals(window.options.resizable, false);
            }
            if (trigger === "bridge hide") await window.invoke("hide");
            else window.requestClose();
            await nextTurn();
            assertEquals(quits, 1);
            assertEquals(native.keeper.physicallyClosed, false);
            assertEquals(native.loopStopped, false);
            shutdown.resolve();
            await host.finished;
            assertEquals(native.liveWindows, []);
            assertEquals(native.trayCreationCalls, 0);
            assertEquals(native.tray.destroyed, false);
        } finally {
            shutdown.resolve();
        }
    });
}

Deno.test("desktop without a tray still shuts down if native close cannot unbind its renderer", async () => {
    let quits = 0;
    const subject = startHost(
        new NativeBackend(),
        () => {
            quits++;
            return Promise.resolve();
        },
        undefined,
        { trayEnabled: false },
    );
    await makeReady(subject);
    const failure = new Error("Native window binding unavailable during close");
    subject.native.main.unbindError = failure;
    subject.native.main.requestClose();
    assertEquals(await assertRejects(() => subject.host.finished), failure);
    assertEquals(await assertRejects(() => subject.host.quit()), failure);
    assertEquals(quits, 1);
    assertEquals(subject.native.trayCreationCalls, 0);
    assertEquals(subject.native.liveWindows, []);
});

Deno.test("desktop remains hidden when a reload finishes after the user hides it to the tray", async () => {
    const subject = startHost();
    await using host = subject.host;
    await makeReady(subject);
    const window = subject.native.main;
    subject.native.tray.select("reload");
    subject.native.tray.select("hide");
    assertEquals(window.isVisible(), false);
    await window.load("/admin/chat", true);
    assert(host.isReady());
    assertEquals(window.isVisible(), false);
    subject.native.tray.select("show");
    assert(window.isVisible());
});

Deno.test("desktop copies the gateway only on its enabled tray action and stays running if clipboard access fails", async () => {
    const copied: string[] = [];
    let stopped = false;
    const subject = startHost(new NativeBackend(), () => {
        stopped = true;
        return Promise.resolve();
    }, (url) => {
        copied.push(url);
        return Promise.reject(new Error("clipboard unavailable"));
    });
    await using host = subject.host;
    await makeReady(subject);
    subject.native.tray.select("hide");
    subject.native.tray.select("show");
    assertEquals(copied, []);

    subject.native.tray.select("copy-gateway");
    await nextTurn();
    assertEquals(copied, [`${origin}/v1`]);
    assert(host.isReady());
    assertEquals(stopped, false);
    assertEquals(subject.native.tray.destroyed, false);
    assertEquals(subject.native.loopStopped, false);
});

Deno.test("desktop restores the requested console view after a new window finishes authentication", async () => {
    const subject = startHost();
    await using host = subject.host;
    await makeReady(subject);
    subject.native.main.requestClose();
    subject.native.tray.select("console");
    const restored = host.currentWindow() as NativeWindow;
    assertEquals(
        new URL(restored.navigations.at(-1)!).pathname,
        "/admin/desktop/bootstrap",
    );
    await restored.load("/admin/chat", true);
    assertEquals(restored.navigations.at(-1), `${origin}/admin`);
    assertEquals(host.isReady(), false);
    await restored.load("/admin", true);
    assert(host.isReady());
});

Deno.test("desktop can reopen a window closed before its first native navigation without rotating an in-flight bootstrap", async () => {
    const subject = startHost();
    await using host = subject.host;
    await nextTurn();
    subject.native.main.requestClose();
    subject.native.tray.select("show");
    const restored = host.currentWindow() as NativeWindow;
    const bootstrap = restored.navigations[0];
    await restored.load("/admin/desktop/bootstrap");
    assertEquals(restored.navigations, [bootstrap]);
    await restored.load("/admin/chat", true);
    await host.ready;
    assert(host.isReady());
});

Deno.test("desktop ignores an old window inspection that finishes after the tray has replaced it", async () => {
    const subject = startHost();
    await using host = subject.host;
    await nextTurn();
    const pending = Promise.withResolvers<unknown>();
    const original = subject.native.main;
    original.pendingInspection = pending.promise;
    original.dispatchEvent(new Event("load"));
    original.requestClose();
    subject.native.tray.select("show");
    pending.resolve({ href: `${origin}/`, path: "/" });
    await nextTurn();
    assertEquals(original.commandsAfterDestruction, []);
    assertEquals(original.navigations.length, 1);

    const restored = host.currentWindow() as NativeWindow;
    await restored.load("/admin/chat", true);
    await host.ready;
    assert(host.isReady());
});

Deno.test("desktop ignores a destroyed renderer inspection failure after a replacement window is ready", async () => {
    const subject = startHost();
    await using host = subject.host;
    await makeReady(subject);
    const original = subject.native.main;
    const pending = Promise.withResolvers<unknown>();
    original.pendingInspection = pending.promise;
    original.dispatchEvent(new Event("load"));
    original.requestClose();
    subject.native.tray.select("show");
    const restored = host.currentWindow() as NativeWindow;
    await restored.load("/admin/chat", true);
    let failure: unknown;
    void host.finished.catch((error) => failure = error);
    pending.reject(new Error("The inspected WebView has been destroyed"));
    await nextTurn();
    assertEquals(failure, undefined);
    assert(host.isReady());
    assertEquals(subject.native.tray.destroyed, false);
    assertEquals(original.commandsAfterDestruction, []);
});

Deno.test("desktop cannot show or navigate a destroyed window when renderer inspection finishes after quit", async () => {
    const subject = startHost();
    await using host = subject.host;
    await subject.native.main.load("/");
    const pending = Promise.withResolvers<unknown>();
    subject.native.main.pendingInspection = pending.promise;
    subject.native.main.dispatchEvent(new Event("load"));
    host.show("/admin");
    await host.quit();
    pending.resolve({
        href: `${origin}/admin/chat`,
        path: "/admin/chat",
        authenticated: true,
        main: true,
    });
    await nextTurn();
    assertEquals(subject.native.main.commandsAfterDestruction, []);
});

Deno.test("desktop only trusts authenticated main pages at its exact local URL", async () => {
    const subject = startHost();
    await using host = subject.host;
    const window = subject.native.main;
    const authenticatedPage = {
        href: `${origin}/admin/chat`,
        path: "/admin/chat",
        authenticated: true,
        main: true,
    };
    const invalidPages = [
        { ...authenticatedPage, href: "https://evil.example/admin/chat" },
        { ...authenticatedPage, href: `${origin}/admin/login` },
        { ...authenticatedPage, href: "http://127.0.0.1:54322/admin/chat" },
        { ...authenticatedPage, href: "not a URL" },
        { ...authenticatedPage, authenticated: false },
        { ...authenticatedPage, main: false },
        { ...authenticatedPage, path: "/" },
        null,
        "authenticated",
    ];
    for (const page of invalidPages) {
        await window.loadPage(page);
        assertEquals(host.isReady(), false);
        assertEquals(window.bridgeToken, undefined);
    }
    await subject.native.keeper.loadPage(authenticatedPage);
    assertEquals(host.isReady(), false);
    assertEquals(subject.native.keeper.bridgeToken, undefined);
    await makeReady(subject);
    assert(host.isReady());
    assert(window.bridgeToken);
});

Deno.test("desktop bridge requires its private token and rejects commands outside the native allowlist", async () => {
    let quitCalls = 0;
    let openCalls = 0;
    let copyCalls = 0;
    const subject = startHost(
        new NativeBackend(),
        () => {
            quitCalls++;
            return Promise.resolve();
        },
        () => {
            copyCalls++;
            return Promise.resolve();
        },
        {
            onOpenDataDirectory: () => {
                openCalls++;
                return Promise.resolve();
            },
        },
    );
    await using host = subject.host;
    const window = subject.native.main;
    const originalVisibility = window.isVisible();
    await window.bridge("guessed-token", "hide").catch(() => undefined);
    assertEquals(window.isVisible(), originalVisibility);
    assertEquals(window.bridgeToken, undefined);

    await makeReady(subject);
    const originalSize = window.getSize();
    const originalPosition = window.getPosition();
    for (const token of [undefined, null, "", "wrong", {}]) {
        await window.bridge(token, "hide").catch(() => undefined);
        await window.bridge(token, "toggle-always-on-top").catch(() =>
            undefined
        );
    }
    for (
        const command of [
            "quit",
            "open-data",
            "copy-gateway",
            "navigate",
            "__proto__",
        ]
    ) {
        await window.invoke(command, `${origin}/admin`).catch(() => undefined);
    }
    assert(window.isVisible());
    assertEquals(window.alwaysOnTop, false);
    assertEquals(window.getSize(), originalSize);
    assertEquals(window.getPosition(), originalPosition);
    assertEquals(window.navigations.length, 1);
    assertEquals(quitCalls, 0);
    assertEquals(openCalls, 0);
    assertEquals(copyCalls, 0);
    assertEquals(subject.native.tray.destroyed, false);

    await window.invoke("hide");
    assertEquals(window.isVisible(), false);
    subject.native.tray.select("show");
    await window.invoke("toggle-always-on-top");
    assert(window.alwaysOnTop);
    assert(host.isReady());
});

Deno.test("desktop bridge drags, enlarges and restores the native window using display coordinates", async () => {
    const subject = startHost();
    await using _host = subject.host;
    await makeReady(subject);
    const window = subject.native.main;
    assertEquals(await window.invoke("state"), {
        expanded: false,
        alwaysOnTop: false,
        trayEnabled: true,
    });
    const [startX, startY] = window.getPosition();
    const originalSize = window.getSize();
    await window.invoke("drag-move", { x: 500, y: 500 });
    assertEquals(window.getPosition(), [startX, startY]);
    await window.invoke("drag-start");
    await window.invoke("drag-move", { x: 20, y: -10 });
    assertEquals(window.getPosition(), [startX + 20, startY - 10]);
    await window.invoke("drag-move", { x: 35, y: 15 });
    const restoredPosition = [startX + 35, startY + 15];
    assertEquals(window.getPosition(), restoredPosition);
    await window.invoke("drag-end");
    await window.invoke("drag-move", { x: 500, y: 500 });
    assertEquals(window.getPosition(), restoredPosition);

    const area = { x: -1920, y: 0, width: 1920, height: 1040 };
    assertEquals(await window.invoke("toggle-expand", area), {
        expanded: true,
        alwaysOnTop: false,
        trayEnabled: true,
    });
    assertEquals(window.getSize(), [1920, 1040]);
    assertEquals(window.getPosition(), [-1920, 0]);
    await window.invoke("drag-start");
    await window.invoke("drag-move", { x: 500, y: 500 });
    assertEquals(window.getPosition(), [-1920, 0]);
    await window.invoke("toggle-expand");
    assertEquals(window.getSize(), originalSize);
    assertEquals(window.getPosition(), restoredPosition);

    await window.invoke("fit", { x: 0, y: 0, width: 1024, height: 768 });
    assertEquals(window.getSize(), [1024, 768]);
    assertEquals(window.getPosition(), [0, 0]);
    subject.native.tray.select("reset-window");
    assertEquals(window.getSize(), [1280, 840]);
    assertEquals(window.getPosition(), [40, 40]);
});

Deno.test("desktop applies Windows display scale to work area bounds and drag distances", async () => {
    const subject = startHost();
    await using _host = subject.host;
    await makeReady(subject);
    const window = subject.native.main;
    const originalSize = window.getSize();
    const originalPosition = window.getPosition();
    const scale = Deno.build.os === "windows" ? 1.5 : 1;
    await window.invoke("toggle-expand", {
        x: -1280,
        y: 20,
        width: 1280,
        height: 720,
        scale: 1.5,
    });
    assertEquals(window.getSize(), [1280 * scale, 720 * scale]);
    assertEquals(window.getPosition(), [-1280 * scale, 20 * scale]);
    await window.invoke("toggle-expand");
    assertEquals(window.getSize(), originalSize);
    assertEquals(window.getPosition(), originalPosition);

    await window.invoke("drag-start", { scale: 1.5 });
    await window.invoke("drag-move", { x: 12, y: -8 });
    assertEquals(window.getPosition(), [
        originalPosition[0] + 12 * scale,
        originalPosition[1] - 8 * scale,
    ]);
    await window.invoke("drag-move", { x: 20, y: 4 });
    assertEquals(window.getPosition(), [
        originalPosition[0] + 20 * scale,
        originalPosition[1] + 4 * scale,
    ]);
    await window.invoke("drag-end");
});

Deno.test("desktop CEF keeps work area bounds and drag distances in logical pixels", async () => {
    const native = new NativeBackend();
    native.physicalWindowCoordinates = false;
    const subject = startHost(native);
    await using _host = subject.host;
    await makeReady(subject);
    const window = native.main;
    const originalSize = window.getSize();
    const originalPosition = window.getPosition();
    await window.invoke("toggle-expand", {
        x: -1600,
        y: 30,
        width: 1600,
        height: 900,
        scale: 2,
    });
    assertEquals(window.getSize(), [1600, 900]);
    assertEquals(window.getPosition(), [-1600, 30]);
    await window.invoke("toggle-expand");
    assertEquals(window.getSize(), originalSize);
    assertEquals(window.getPosition(), originalPosition);
    await window.invoke("drag-start", { scale: 2 });
    await window.invoke("drag-move", { x: 12, y: -8 });
    assertEquals(window.getPosition(), [
        originalPosition[0] + 12,
        originalPosition[1] - 8,
    ]);
    await window.invoke("drag-end");
});

Deno.test("desktop edge resizing preserves opposite edges and clamps native bounds", async () => {
    const subject = startHost();
    await using _host = subject.host;
    await makeReady(subject);
    const window = subject.native.main;
    const [startX, startY] = window.getPosition();
    const [width, height] = window.getSize();
    await window.invoke("resize-start", { edge: "nw", scale: 1 });
    await window.invoke("resize-move", { x: 100, y: 60 });
    assertEquals(window.getSize(), [width - 100, height - 60]);
    assertEquals(window.getPosition(), [startX + 100, startY + 60]);
    await window.invoke("resize-move", { x: 200, y: 120 });
    assertEquals(window.getSize(), [width - 200, height - 120]);
    assertEquals(window.getPosition(), [startX + 200, startY + 120]);
    await window.invoke("resize-move", { x: 10_000, y: 10_000 });
    const minimumPosition = [startX + width - 640, startY + height - 480];
    assertEquals(window.getSize(), [640, 480]);
    assertEquals(window.getPosition(), minimumPosition);
    await window.invoke("resize-end");
    await window.invoke("resize-move", { x: 100, y: 100 });
    assertEquals(window.getSize(), [640, 480]);
    assertEquals(window.getPosition(), minimumPosition);

    await window.invoke("resize-start", { edge: "se", scale: 1 });
    await window.invoke("resize-move", { x: 20_000, y: 20_000 });
    assertEquals(window.getSize(), [16_384, 16_384]);
    assertEquals(window.getPosition(), minimumPosition);
    await window.invoke("resize-end");
});

Deno.test("desktop physical resizing scales minimum dimensions and rejects malformed edges", async () => {
    const native = new NativeBackend();
    native.physicalWindowCoordinates = true;
    const subject = startHost(native);
    await using _host = subject.host;
    await makeReady(subject);
    const window = native.main;
    const originalSize = window.getSize();
    const originalPosition = window.getPosition();
    for (const edge of [undefined, null, "", "north", "sew", "__proto__"]) {
        await assertRejects(() =>
            window.invoke("resize-start", { edge, scale: 1.5 })
        );
    }
    await window.invoke("resize-move", { x: 10, y: 10 });
    assertEquals(window.getSize(), originalSize);
    assertEquals(window.getPosition(), originalPosition);
    await window.invoke("resize-start", { edge: "nw", scale: 1.5 });
    await assertRejects(() => window.invoke("resize-move", { x: NaN, y: 10 }));
    assertEquals(window.getSize(), originalSize);
    await window.invoke("resize-move", { x: 10_000, y: 10_000 });
    assertEquals(window.getSize(), [960, 720]);
    assertEquals(window.getPosition(), [
        originalPosition[0] + originalSize[0] - 960,
        originalPosition[1] + originalSize[1] - 720,
    ]);
    await window.invoke("resize-end");
});

Deno.test("desktop rejects invalid display scale before moving or resizing native windows", async () => {
    const subject = startHost();
    await using _host = subject.host;
    await makeReady(subject);
    const window = subject.native.main;
    const originalSize = window.getSize();
    const originalPosition = window.getPosition();
    for (const scale of [NaN, 0, -1, Infinity, 1000, "1.5"]) {
        const payload = {
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
            edge: "se",
            scale,
        };
        for (
            const command of [
                "fit",
                "toggle-expand",
                "drag-start",
                "resize-start",
            ]
        ) {
            await assertRejects(() => window.invoke(command, payload));
        }
        await window.invoke("drag-move", { x: 40, y: 40 });
        assertEquals(window.getSize(), originalSize);
        assertEquals(window.getPosition(), originalPosition);
    }
});

Deno.test("desktop bridge validates menu and display bounds before issuing native commands", async () => {
    const subject = startHost();
    await using _host = subject.host;
    await makeReady(subject);
    const window = subject.native.main;
    const originalSize = window.getSize();
    const originalPosition = window.getPosition();
    const invalidPoints = [
        undefined,
        null,
        {},
        [],
        { x: "1", y: 0 },
        { x: Infinity, y: 0 },
        { x: 0, y: NaN },
        { x: 100_001, y: 0 },
    ];
    for (const point of invalidPoints) {
        await assertRejects(() => window.invoke("menu", point));
    }
    for (
        const bounds of [
            { x: 0, y: 0, width: 0, height: 800 },
            { x: 0, y: 0, width: 1280, height: -1 },
            { x: 0, y: 0, width: Infinity, height: 800 },
            { x: 0, y: 0, width: "1280", height: 800 },
            { x: 0, y: 0, width: 16_385, height: 800 },
        ]
    ) {
        await assertRejects(() => window.invoke("toggle-expand", bounds));
    }
    assertEquals(window.getSize(), originalSize);
    assertEquals(window.getPosition(), originalPosition);
    assertEquals(window.contextMenus, []);
    await window.invoke("menu", { x: 12.4, y: 22.8 });
    assertEquals(window.contextMenus.length, 1);
    assertEquals(window.contextMenus[0]!.x, 12);
    assertEquals(window.contextMenus[0]!.y, 23);
    assert(window.contextMenus[0]!.menu.length > 0);
    window.dispatchEvent(
        new CustomEvent("menuclick", { detail: { id: "hide" } }),
    );
    assertEquals(window.isVisible(), false);
});

Deno.test("desktop ignores captured native callbacks from a closed window after its replacement is ready", async () => {
    const subject = startHost();
    await using host = subject.host;
    await makeReady(subject);
    const original = subject.native.main;
    const invoke = original.bridge;
    const token = original.bridgeToken;
    original.requestClose();
    subject.native.tray.select("show");
    const restored = host.currentWindow() as NativeWindow;
    await restored.load("/admin/chat", true);
    assertNotEquals(restored.bridgeToken, token);
    for (
        const command of [
            "hide",
            "toggle-expand",
            "toggle-always-on-top",
            "menu",
        ]
    ) {
        await invoke(token, command, { x: 10, y: 20 }).catch(() => undefined);
    }
    assert(restored.isVisible());
    assertEquals(restored.alwaysOnTop, false);
    assertEquals(restored.contextMenus, []);
    assertEquals(original.commandsAfterDestruction, []);
});

Deno.test("desktop ignores queued window menu callbacks after the current window has closed", async () => {
    let quits = 0;
    const subject = startHost(new NativeBackend(), () => {
        quits++;
        return Promise.resolve();
    });
    await using _host = subject.host;
    await makeReady(subject);
    const window = subject.native.main;
    const invoke = window.bridge;
    const token = window.bridgeToken;
    const originalWindowCount = subject.native.windows.length;
    window.requestClose();
    await invoke(token, "toggle-always-on-top").catch(() => undefined);
    for (const event of ["menuclick", "contextmenuclick"]) {
        window.dispatchEvent(
            new CustomEvent(event, { detail: { id: "chat" } }),
        );
        window.dispatchEvent(
            new CustomEvent(event, { detail: { id: "quit" } }),
        );
    }
    await nextTurn();
    assertEquals(subject.native.windows.length, originalWindowCount);
    assertEquals(quits, 0);
    assertEquals(subject.native.tray.destroyed, false);
    assertEquals(window.commandsAfterDestruction, []);
});

Deno.test("desktop revokes the previous page bridge while the next page is being inspected", async () => {
    const subject = startHost();
    await using _host = subject.host;
    await makeReady(subject);
    const window = subject.native.main;
    const invoke = window.bridge;
    const token = window.bridgeToken;
    const pending = Promise.withResolvers<unknown>();
    window.pendingInspection = pending.promise;
    window.dispatchEvent(new Event("load"));
    await invoke(token, "hide").catch(() => undefined);
    assert(window.isVisible());
    pending.resolve({
        ok: true,
        value: {
            href: "https://evil.example/admin/chat",
            path: "/admin/chat",
            authenticated: true,
            main: true,
        },
    });
    await nextTurn();
    await invoke(token, "toggle-always-on-top").catch(() => undefined);
    assertEquals(window.alwaysOnTop, false);
    window.pendingInspection = undefined;
    await window.load("/admin/chat", true);
    assertNotEquals(window.bridgeToken, token);
    await window.invoke("hide");
    assertEquals(window.isVisible(), false);
});

Deno.test("desktop ignores an authenticated inspection superseded by another page in the same window", async () => {
    const subject = startHost();
    await using host = subject.host;
    await nextTurn();
    const window = subject.native.main;
    const pending = Promise.withResolvers<unknown>();
    window.pendingInspection = pending.promise;
    window.dispatchEvent(new Event("load"));
    window.pendingInspection = undefined;
    await window.load("/admin/login", false);
    pending.resolve({
        ok: true,
        value: {
            href: `${origin}/admin/chat`,
            path: "/admin/chat",
            authenticated: true,
            main: true,
        },
    });
    await nextTurn();
    assertEquals(host.isReady(), false);
    assertEquals(window.bridgeToken, undefined);
    await makeReady(subject);
    assert(host.isReady());
});

Deno.test("desktop restores native window state and saves the final geometry before quitting", async () => {
    const saved: Array<
        Parameters<NonNullable<DesktopHostOptions["onSaveWindowState"]>>[0]
    > = [];
    const subject = startHost(
        new NativeBackend(),
        () => Promise.resolve(),
        undefined,
        {
            initialWindowState: {
                width: 1120,
                height: 760,
                x: 40,
                y: 50,
                alwaysOnTop: true,
            },
            onSaveWindowState: (state) => {
                saved.push(state);
                return Promise.resolve();
            },
        },
    );
    await using host = subject.host;
    await makeReady(subject);
    const window = subject.native.main;
    assertEquals(window.getSize(), [1120, 760]);
    assertEquals(window.getPosition(), [40, 50]);
    assert(window.alwaysOnTop);
    await window.invoke("toggle-always-on-top");
    window.size = [1180, 780];
    window.position = [75, 85];
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("move"));
    await host.quit();
    assertEquals(saved.at(-1), {
        width: 1180,
        height: 780,
        x: 75,
        y: 85,
        alwaysOnTop: false,
    });
});

Deno.test("desktop native menu opens application data, reloads the page and toggles always on top on demand", async () => {
    let opens = 0;
    const subject = startHost(
        new NativeBackend(),
        () => Promise.resolve(),
        undefined,
        {
            onOpenDataDirectory: () => {
                opens++;
                return Promise.resolve();
            },
        },
    );
    await using _host = subject.host;
    await makeReady(subject);
    const window = subject.native.main;
    assertEquals(opens, 0);
    assertEquals(window.reloadCalls, 0);
    subject.native.tray.select("open-data");
    await nextTurn();
    assertEquals(opens, 1);
    subject.native.tray.select("always-on-top");
    assert(window.alwaysOnTop);
    subject.native.tray.select("always-on-top");
    assertEquals(window.alwaysOnTop, false);
    subject.native.tray.select("reload");
    assertEquals(window.reloadCalls, 1);
    assertEquals(subject.native.tray.destroyed, false);
});

Deno.test("desktop ignores captured bridge and menu callbacks once shutdown has started", async () => {
    let copies = 0;
    let opens = 0;
    const shutdown = Promise.withResolvers<void>();
    const subject = startHost(
        new NativeBackend(),
        () => shutdown.promise,
        () => {
            copies++;
            return Promise.resolve();
        },
        {
            onOpenDataDirectory: () => {
                opens++;
                return Promise.resolve();
            },
        },
    );
    await using host = subject.host;
    try {
        await makeReady(subject);
        const window = subject.native.main;
        const invoke = window.bridge;
        const token = window.bridgeToken;
        const stopping = host.quit();
        for (
            const command of [
                "hide",
                "toggle-expand",
                "toggle-always-on-top",
                "menu",
            ]
        ) {
            await invoke(token, command, { x: 10, y: 20 }).catch(() =>
                undefined
            );
        }
        for (
            const id of [
                "hide",
                "chat",
                "copy-gateway",
                "open-data",
                "always-on-top",
                "reload",
            ]
        ) {
            subject.native.tray.select(id);
        }
        assert(window.isVisible());
        assertEquals(window.alwaysOnTop, false);
        assertEquals(window.reloadCalls, 0);
        assertEquals(window.contextMenus, []);
        assertEquals(copies, 0);
        assertEquals(opens, 0);
        shutdown.resolve();
        await stopping;
        await invoke(token, "hide").catch(() => undefined);
        assertEquals(window.commandsAfterDestruction, []);
    } finally {
        shutdown.resolve();
    }
});

Deno.test("desktop waits for runtime shutdown before destroying native resources and quits only once", async () => {
    const shutdown = Promise.withResolvers<void>();
    let calls = 0;
    const subject = startHost(new NativeBackend(), () => {
        calls++;
        return shutdown.promise;
    });
    await using host = subject.host;
    try {
        await makeReady(subject);
        const first = host.quit();
        const second = host.quit();
        assertEquals(first, second);
        await nextTurn();
        assertEquals(calls, 1);
        assertEquals(subject.native.tray.destroyed, false);
        assert(subject.native.liveWindows.includes(subject.native.main));
        assertEquals(subject.native.loopStopped, false);
        shutdown.resolve();
        await first;
        await host.finished;
        assert(subject.native.tray.destroyed);
        assertEquals(subject.native.liveWindows.length, 0);
    } finally {
        shutdown.resolve();
    }
});

for (const failure of ["remember", "unbind", "both"] as const) {
    Deno.test(`desktop completes shutdown after native ${failure} cleanup fails`, async () => {
        let quits = 0;
        const subject = startHost(new NativeBackend(), () => {
            quits++;
            return Promise.resolve();
        });
        await makeReady(subject);
        const window = subject.native.main;
        const rememberError = new Error("Native window bounds unavailable");
        const unbindError = new Error("Native window binding unavailable");
        if (failure !== "unbind") window.sizeError = rememberError;
        if (failure !== "remember") window.unbindError = unbindError;

        const completion = subject.host.quit();
        assertEquals(subject.host.quit(), completion);
        const error = await assertRejects(() => completion);
        assertEquals(await assertRejects(() => subject.host.finished), error);
        if (failure === "both") {
            assert(error instanceof AggregateError);
            assertEquals(error.errors, [rememberError, unbindError]);
        } else {
            assertEquals(
                error,
                failure === "remember" ? rememberError : unbindError,
            );
        }
        assertEquals(quits, 1);
        assertEquals(window.unbindCalls, 1);
        assertEquals(window.closeCalls, 1);
        assertEquals(subject.native.keeper.closeCalls, 1);
        assertEquals(subject.native.initial.closeCalls, 1);
        assert(subject.native.tray.destroyed);
        assertEquals(subject.native.liveWindows.length, 0);
        assert(subject.native.loopStopped);
    });
}

for (const failure of ["window", "tray", "icon", "menu"] as const) {
    Deno.test(`desktop releases partially created native resources after ${failure} setup fails`, () => {
        const native = new NativeBackend();
        native.setupFailure = failure;
        assertThrows(
            () => startHost(native),
            Error,
            `native ${failure} failed`,
        );
        assertEquals(native.liveWindows.length, 0);
        if (failure === "icon" || failure === "menu") {
            assert(native.tray.destroyed);
        }
    });
}

Deno.test("desktop initialization failure remains observable and disposal releases its resources", async () => {
    const native = new NativeBackend();
    let quitCalls = 0;
    const subject = startHost(native, () => {
        quitCalls++;
        return Promise.resolve();
    });
    const failed = new Error("native renderer inspection failed");
    try {
        native.main.inspectionError = failed;
        native.main.dispatchEvent(new Event("load"));
        await assertRejects(() => subject.host.ready, Error, failed.message);
        await assertRejects(() => subject.host.finished, Error, failed.message);
    } finally {
        await subject.host[Symbol.asyncDispose]();
    }
    assertEquals(quitCalls, 1);
    assert(native.tray.destroyed);
    assertEquals(native.liveWindows.length, 0);
});

Deno.test("desktop rejects native evaluation error envelopes without granting a page capability", async () => {
    const subject = startHost();
    await using host = subject.host;
    const window = subject.native.main;
    await window.loadPage({
        ok: false,
        value: {
            href: `${origin}/admin/chat`,
            path: "/admin/chat",
            authenticated: true,
            main: true,
        },
    }, false);
    await assertRejects(
        () => host.ready,
        Error,
        "Native renderer evaluation failed.",
    );
    await assertRejects(
        () => host.finished,
        Error,
        "Native renderer evaluation failed.",
    );
    assertEquals(host.isReady(), false);
    assertEquals(window.bridgeToken, undefined);
});

Deno.test("desktop still releases every native resource when runtime shutdown rejects", async () => {
    const failure = new Error("runtime shutdown failed");
    const subject = startHost(
        new NativeBackend(),
        () => Promise.reject(failure),
    );
    await makeReady(subject);
    let finished: unknown = "pending";
    void subject.host.finished.then(
        () => finished = "resolved",
        (error) => finished = error,
    );
    await assertRejects(() => subject.host.quit(), Error, failure.message);
    await nextTurn();
    assertEquals(
        finished,
        failure,
        "Shutdown observers must receive the error",
    );
    assert(subject.native.tray.destroyed);
    assertEquals(subject.native.liveWindows.length, 0);
});
