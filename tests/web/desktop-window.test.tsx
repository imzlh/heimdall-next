import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import { DesktopTitlebar } from "../../src/web/components/desktop-titlebar.tsx";
import { ChatShell } from "../../src/web/components/chat-shell.tsx";
import { AdminShell } from "../../src/web/components/shell.tsx";
import { mountDesktopWindow } from "../../src/web/client/desktop.ts";
import { installTestDom } from "./helpers/jsx-dom.ts";

interface Call {
    command: string;
    payload?: Record<string, number | string>;
}

function event(type: string, fields: Record<string, unknown> = {}) {
    return Object.assign(new Event(type, { cancelable: true }), fields);
}

async function fixture({
    desktop = true,
    connected = true,
    respond = () => Promise.resolve({ expanded: false, alwaysOnTop: false }),
}: {
    desktop?: boolean;
    connected?: boolean;
    respond?: (call: Call) => Promise<unknown>;
} = {}) {
    const dom = installTestDom();
    const calls: Call[] = [];
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const install = (name: string, value: unknown) => {
        if (!originals.has(name)) {
            originals.set(
                name,
                Object.getOwnPropertyDescriptor(globalThis, name),
            );
        }
        Object.defineProperty(globalThis, name, { configurable: true, value });
    };
    const connect = () => {
        install(
            "heimdallDesktop",
            (command: string, payload?: Record<string, number | string>) => {
                const call = { command, payload };
                calls.push(call);
                return respond(call);
            },
        );
        globalThis.dispatchEvent(new Event("heimdall:desktop-ready"));
    };
    install("screen", {
        availLeft: -1440,
        availTop: 24,
        availWidth: 1440,
        availHeight: 876,
    });
    install("devicePixelRatio", 1.5);
    install("heimdallDesktop", undefined);
    if (connected) connect();
    if (desktop) {
        dom.document.documentElement.setAttribute("data-desktop", "true");
    }
    const document = Object.assign(dom.document, {
        querySelector: (selector: string) => dom.root.querySelector(selector),
    });
    await dom.act(() =>
        render(
            <DesktopTitlebar workspace="对话" />,
            dom.root as unknown as HTMLElement,
        )
    );
    const titlebar = dom.root.querySelector("[data-desktop-titlebar]")!;
    const drag = titlebar.querySelector("[data-desktop-drag]")!;
    const captured = new Set<number>();
    for (
        const region of [
            drag,
            ...titlebar.querySelectorAll("[data-desktop-resize]"),
        ]
    ) {
        Object.assign(region, {
            setPointerCapture: (id: number) => captured.add(id),
            hasPointerCapture: (id: number) => captured.has(id),
            releasePointerCapture: (id: number) => captured.delete(id),
        });
    }
    const unmount = mountDesktopWindow(document as unknown as Document);
    await dom.act();
    return {
        dom,
        calls,
        titlebar,
        drag,
        captured,
        connect,
        button: (command: string) =>
            titlebar.querySelector(`[data-desktop-command="${command}"]`)!,
        resize: (edge: string) =>
            titlebar.querySelector(`[data-desktop-resize="${edge}"]`)!,
        async close() {
            unmount();
            await dom.act();
            await dom.act(() =>
                render(null, dom.root as unknown as HTMLElement)
            );
            for (const [name, original] of originals) {
                if (original) Object.defineProperty(globalThis, name, original);
                else Reflect.deleteProperty(globalThis, name);
            }
            dom.restore();
        },
    };
}

Deno.test("desktop shells render window controls only for desktop documents", () => {
    for (const desktop of [false, true]) {
        for (
            const html of [
                <AdminShell
                    key="admin"
                    title="Heimdall"
                    active="overview"
                    nav={[]}
                    desktop={desktop}
                />,
                <ChatShell key="chat" desktop={desktop} />,
            ].map((node) => node.toString())
        ) {
            assertEquals(html.includes("data-desktop-titlebar"), desktop);
            if (!desktop) continue;
            assertStringIncludes(html, 'data-desktop-command="toggle-expand"');
            assertStringIncludes(html, 'data-desktop-command="hide"');
            assertStringIncludes(html, 'aria-label="关闭窗口"');
            assertStringIncludes(html, 'aria-label="窗口控制"');
            assertEquals(html.match(/data-desktop-resize="/g)?.length, 8);
            assertEquals(
                html.includes('data-desktop-command="minimize"'),
                false,
            );
        }
    }
});

Deno.test("desktop controls await the bridge, fit once and reflect native window state", async () => {
    const view = await fixture({ connected: false });
    try {
        assert(view.button("hide").disabled);
        view.button("hide").click();
        assertEquals(view.calls, []);
        await view.dom.act(view.connect);
        assertEquals(view.calls.map((call) => call.command), ["fit", "state"]);
        assertEquals(view.calls[0]!.payload, {
            x: -1440,
            y: 24,
            width: 1440,
            height: 876,
            scale: 1.5,
        });
        assertEquals(view.button("hide").disabled, false);
        await view.dom.act(() => {
            globalThis.dispatchEvent(new Event("heimdall:desktop-ready"));
            globalThis.dispatchEvent(
                new CustomEvent("heimdall:desktop-state", {
                    detail: { expanded: true, alwaysOnTop: true },
                }),
            );
        });
        assertEquals(view.calls.length, 2);
        assertEquals(
            view.button("toggle-expand").getAttribute("aria-label"),
            "还原窗口",
        );
        assertEquals(
            view.titlebar.querySelector("[data-desktop-expand-icon]")!.hidden,
            true,
        );
        assertEquals(
            view.titlebar.querySelector("[data-desktop-restore-icon]")!.hidden,
            false,
        );
        assertEquals(
            view.titlebar.querySelector("[data-desktop-pinned]")!.hidden,
            false,
        );
        await view.dom.act(() => view.button("hide").click());
        assertEquals(view.calls.at(-1)!.command, "hide");
    } finally {
        await view.close();
    }
});

Deno.test("titlebar drag coalesces pointer movement and finishes before expand", async () => {
    const started = Promise.withResolvers<unknown>();
    const view = await fixture({
        respond: (call) =>
            call.command === "drag-start" ? started.promise : Promise.resolve({
                expanded: call.command === "toggle-expand",
                alwaysOnTop: false,
            }),
    });
    const pointer = (type: string, x: number, y: number) =>
        event(type, {
            pointerId: 7,
            button: 0,
            isPrimary: true,
            screenX: x,
            screenY: y,
        });
    try {
        view.calls.length = 0;
        await view.dom.act(() => {
            view.drag.dispatchEvent(pointer("pointerdown", 100, 80));
            view.drag.dispatchEvent(pointer("pointermove", 120, 90));
            view.drag.dispatchEvent(pointer("pointermove", 140, 110));
        });
        assertEquals(view.calls, [{
            command: "drag-start",
            payload: { scale: 1.5 },
        }]);
        assert(view.captured.has(7));
        await view.dom.act(() => {
            view.drag.dispatchEvent(pointer("pointerup", 155, 120));
            view.drag.dispatchEvent(event("dblclick", { button: 0 }));
        });
        assertEquals(view.captured.size, 0);
        assertEquals(view.calls.length, 1);
        started.resolve({ expanded: false, alwaysOnTop: false });
        await view.dom.act();
        await view.dom.act();
        await view.dom.act();
        assertEquals(view.calls.map((call) => call.command), [
            "drag-start",
            "drag-move",
            "drag-move",
            "drag-end",
            "toggle-expand",
        ]);
        assertEquals(view.calls[1]!.payload, { x: 40, y: 30 });
        assertEquals(view.calls[2]!.payload, { x: 55, y: 40 });
        assertEquals(
            view.button("toggle-expand").getAttribute("aria-label"),
            "还原窗口",
        );
        await view.dom.act(() =>
            view.drag.dispatchEvent(pointer("pointerdown", 100, 80))
        );
        assertEquals(view.calls.length, 5);
    } finally {
        started.resolve({ expanded: false, alwaysOnTop: false });
        await view.close();
    }
});

Deno.test("desktop shortcuts preserve browser pages, IME and modified keystrokes", async () => {
    for (const desktop of [true, false]) {
        const view = await fixture({ desktop });
        try {
            view.calls.length = 0;
            for (
                const [key, command] of [["1", "chat"], ["2", "console"], [
                    "W",
                    "hide",
                ]]
            ) {
                const shortcut = event("keydown", { key, ctrlKey: true });
                await view.dom.act(() =>
                    view.dom.document.dispatchEvent(shortcut)
                );
                assertEquals(shortcut.defaultPrevented, desktop);
                if (desktop) assertEquals(view.calls.at(-1)!.command, command);
            }
            const count = view.calls.length;
            for (
                const fields of [
                    { isComposing: true },
                    { repeat: true },
                    { shiftKey: true },
                    { altKey: true },
                ]
            ) {
                const shortcut = event("keydown", {
                    key: "w",
                    ctrlKey: true,
                    ...fields,
                });
                await view.dom.act(() =>
                    view.dom.document.dispatchEvent(shortcut)
                );
                assertEquals(shortcut.defaultPrevented, false);
            }
            assertEquals(view.calls.length, count);
            if (!desktop) assertEquals(view.calls, []);
        } finally {
            await view.close();
        }
    }
});

Deno.test("desktop close wording follows the native tray policy without removing either behavior", async () => {
    for (const trayEnabled of [false, true]) {
        const view = await fixture({
            respond: () =>
                Promise.resolve({
                    expanded: false,
                    alwaysOnTop: false,
                    trayEnabled,
                }),
        });
        try {
            assertEquals(
                view.button("hide").getAttribute("aria-label"),
                trayEnabled ? "隐藏到托盘，服务继续运行" : "关闭窗口",
            );
            await view.dom.act(() => view.button("hide").click());
            assertEquals(view.calls.at(-1)!.command, "hide");
            await view.dom.act(() =>
                globalThis.dispatchEvent(
                    new CustomEvent("heimdall:desktop-state", {
                        detail: { trayEnabled: !trayEnabled },
                    }),
                )
            );
            assertEquals(
                view.button("hide").getAttribute("aria-label"),
                trayEnabled ? "关闭窗口" : "隐藏到托盘，服务继续运行",
            );
        } finally {
            await view.close();
        }
    }
});

Deno.test("all eight resize regions send their edge and final screen delta without taking keyboard focus", async () => {
    const view = await fixture();
    const pointer = (type: string, x: number, y: number) =>
        event(type, {
            pointerId: 9,
            button: 0,
            isPrimary: true,
            screenX: x,
            screenY: y,
        });
    try {
        for (const edge of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
            const region = view.resize(edge);
            assertEquals(region.getAttribute("tabindex"), null);
            assertEquals(region.getAttribute("aria-hidden"), "true");
            view.calls.length = 0;
            await view.dom.act(() => {
                region.dispatchEvent(pointer("pointerdown", 500, 300));
                region.dispatchEvent(pointer("pointermove", 510, 305));
                region.dispatchEvent(pointer("pointermove", 535, 320));
                region.dispatchEvent(pointer("pointerup", 540, 330));
            });
            await view.dom.act();
            assertEquals(view.calls, [
                { command: "resize-start", payload: { edge, scale: 1.5 } },
                { command: "resize-move", payload: { x: 40, y: 30 } },
                { command: "resize-end", payload: undefined },
            ]);
            assertEquals(view.captured.size, 0);
        }
        await view.dom.act(() =>
            globalThis.dispatchEvent(
                new CustomEvent("heimdall:desktop-state", {
                    detail: { expanded: true },
                }),
            )
        );
        view.calls.length = 0;
        await view.dom.act(() =>
            view.resize("se").dispatchEvent(pointer("pointerdown", 500, 300))
        );
        assertEquals(view.calls, []);
        assertEquals(view.captured.size, 0);
    } finally {
        await view.close();
    }
});

Deno.test("resize cancellation releases capture and finishes before subsequent drag or close", async () => {
    const started = Promise.withResolvers<unknown>();
    const view = await fixture({
        respond: (call) =>
            call.command === "resize-start"
                ? started.promise
                : Promise.resolve({
                    expanded: false,
                    alwaysOnTop: false,
                    trayEnabled: false,
                }),
    });
    const pointer = (type: string, id: number) =>
        event(type, {
            pointerId: id,
            button: 0,
            isPrimary: true,
            screenX: 100,
            screenY: 100,
        });
    try {
        view.calls.length = 0;
        await view.dom.act(() => {
            view.resize("nw").dispatchEvent(pointer("pointerdown", 1));
            view.drag.dispatchEvent(pointer("pointerdown", 2));
            view.resize("nw").dispatchEvent(pointer("pointercancel", 2));
        });
        assertEquals(view.calls.map((call) => call.command), ["resize-start"]);
        assert(view.captured.has(1));
        await view.dom.act(() => {
            globalThis.dispatchEvent(new Event("blur"));
            view.drag.dispatchEvent(pointer("pointerdown", 2));
            view.drag.dispatchEvent(pointer("pointerup", 2));
            view.button("hide").click();
        });
        assertEquals(view.captured.size, 0);
        started.resolve({
            expanded: false,
            alwaysOnTop: false,
            trayEnabled: false,
        });
        await view.dom.act();
        await view.dom.act();
        await view.dom.act();
        assertEquals(view.calls.map((call) => call.command), [
            "resize-start",
            "resize-end",
            "drag-start",
            "drag-end",
            "hide",
        ]);
    } finally {
        started.resolve({
            expanded: false,
            alwaysOnTop: false,
            trayEnabled: false,
        });
        await view.close();
    }
});
