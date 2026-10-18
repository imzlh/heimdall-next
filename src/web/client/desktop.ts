/** Browser-only view of the narrow bridge installed by the desktop host. */
type DesktopCommand =
    | "state"
    | "fit"
    | "hide"
    | "toggle-expand"
    | "drag-start"
    | "drag-move"
    | "drag-end"
    | "resize-start"
    | "resize-move"
    | "resize-end"
    | "menu"
    | "chat"
    | "console"
    | "toggle-always-on-top";

type DesktopPayload = Record<string, number | string>;
type DesktopBridge = (
    command: DesktopCommand,
    payload?: DesktopPayload,
) => Promise<unknown>;

function bridge(): DesktopBridge | undefined {
    return (globalThis as { heimdallDesktop?: DesktopBridge }).heimdallDesktop;
}

export async function invokeDesktop(
    command: DesktopCommand,
    payload?: DesktopPayload,
): Promise<unknown> {
    const invoke = bridge();
    if (typeof invoke !== "function") {
        throw new Error("Desktop window is not connected");
    }
    return await invoke(command, payload);
}

/** Work-area offsets may be negative on displays to the left of the primary. */
function workArea(): DesktopPayload {
    const display = screen as Screen & {
        availLeft?: number;
        availTop?: number;
    };
    return {
        x: Number.isFinite(display.availLeft) ? display.availLeft! : 0,
        y: Number.isFinite(display.availTop) ? display.availTop! : 0,
        width: display.availWidth || display.width,
        height: display.availHeight || display.height,
        scale: globalThis.devicePixelRatio || 1,
    };
}

type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface WindowGesture {
    readonly kind: "drag" | "resize";
    readonly region: HTMLElement;
    readonly pointerId: number;
    readonly screenX: number;
    readonly screenY: number;
    queue: Promise<unknown>;
    pending?: DesktopPayload;
    frame?: number;
}

/** SSR owns the chrome; this enhancement only activates inside a desktop page. */
export function mountDesktopWindow(dom: Document = document): () => void {
    if (dom.documentElement.dataset.desktop !== "true") return () => {};
    const titlebar = dom.querySelector<HTMLElement>("[data-desktop-titlebar]");
    const dragRegion = titlebar?.querySelector<HTMLElement>(
        "[data-desktop-drag]",
    );
    if (!titlebar || !dragRegion) return () => {};
    const buttons = titlebar.querySelectorAll<HTMLButtonElement>(
        "[data-desktop-command]",
    );
    const expand = titlebar.querySelector<HTMLButtonElement>(
        '[data-desktop-command="toggle-expand"]',
    );
    const close = titlebar.querySelector<HTMLButtonElement>(
        '[data-desktop-command="hide"]',
    );
    const expandIcon = titlebar.querySelector<HTMLElement>(
        "[data-desktop-expand-icon]",
    );
    const restoreIcon = titlebar.querySelector<HTMLElement>(
        "[data-desktop-restore-icon]",
    );
    const pinned = titlebar.querySelector<HTMLElement>("[data-desktop-pinned]");
    const status = titlebar.querySelector<HTMLElement>("[data-desktop-status]");
    const controller = new AbortController();
    const options = { signal: controller.signal };
    let ready = false;
    let expanded = false;
    let gesture: WindowGesture | undefined;
    let gestureQueue = Promise.resolve<unknown>(undefined);

    const applyState = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        const state = value as {
            expanded?: unknown;
            alwaysOnTop?: unknown;
            trayEnabled?: unknown;
        };
        if (typeof state.expanded === "boolean") {
            expanded = state.expanded;
            titlebar.setAttribute("data-expanded", String(expanded));
            const label = expanded ? "还原窗口" : "展开窗口";
            expand?.setAttribute("aria-label", label);
            expand?.setAttribute("title", label);
            if (expandIcon) expandIcon.hidden = expanded;
            if (restoreIcon) restoreIcon.hidden = !expanded;
            if (expanded && gesture) void finishGesture();
        }
        if (pinned && typeof state.alwaysOnTop === "boolean") {
            pinned.hidden = !state.alwaysOnTop;
        }
        if (typeof state.trayEnabled === "boolean") {
            close?.setAttribute(
                "aria-label",
                state.trayEnabled ? "隐藏到托盘，服务继续运行" : "关闭窗口",
            );
            close?.setAttribute(
                "title",
                state.trayEnabled ? "隐藏到托盘（服务继续运行）" : "关闭窗口",
            );
        }
    };
    const request = async (
        command: DesktopCommand,
        payload?: DesktopPayload,
    ) => {
        try {
            const result = await invokeDesktop(command, payload);
            if (!controller.signal.aborted) {
                applyState(result);
                if (status) status.textContent = "";
            }
            return result;
        } catch {
            if (status && !controller.signal.aborted) {
                status.textContent = "窗口操作暂不可用，请重试。";
            }
        }
    };
    const connect = async () => {
        if (ready || typeof bridge() !== "function") return;
        ready = true;
        titlebar.setAttribute("data-ready", "true");
        for (const button of buttons) button.disabled = false;
        await request("fit", workArea());
        if (!controller.signal.aborted) await request("state");
    };
    const flushMove = (session: WindowGesture) => {
        if (session.frame !== undefined) {
            cancelAnimationFrame(session.frame);
            session.frame = undefined;
        }
        const delta = session.pending;
        session.pending = undefined;
        if (delta) {
            session.queue = session.queue.then(() =>
                request(`${session.kind}-move`, delta)
            );
            gestureQueue = session.queue;
        }
    };
    const finishGesture = () => {
        const session = gesture;
        if (!session) return gestureQueue;
        gesture = undefined;
        flushMove(session);
        session.queue = session.queue.then(() =>
            request(`${session.kind}-end`)
        );
        gestureQueue = session.queue;
        if (session.region.hasPointerCapture(session.pointerId)) {
            session.region.releasePointerCapture(session.pointerId);
        }
        return gestureQueue;
    };
    const toggleExpand = async () => {
        if (!ready) return;
        await finishGesture();
        if (!controller.signal.aborted) {
            await request("toggle-expand", workArea());
        }
    };
    const openMenu = async (x: number, y: number) => {
        if (!ready) return;
        await finishGesture();
        if (controller.signal.aborted) return;
        await request("menu", { x, y });
        if (!controller.signal.aborted) await request("state");
    };
    const runAction = async (command: "hide" | "chat" | "console") => {
        await finishGesture();
        if (!controller.signal.aborted) await request(command);
    };

    for (const button of buttons) {
        button.addEventListener("click", () => {
            if (!ready) return;
            const command = button.dataset.desktopCommand;
            if (command === "toggle-expand") void toggleExpand();
            else if (command === "hide") void runAction("hide");
            else if (command === "menu") {
                const bounds = button.getBoundingClientRect();
                void openMenu(bounds.left, bounds.bottom);
            }
        }, options);
    }
    const attachGesture = (region: HTMLElement, edge?: ResizeEdge) => {
        const kind = edge ? "resize" : "drag";
        region.addEventListener("pointerdown", (event) => {
            if (
                !ready || expanded || gesture || event.button !== 0 ||
                event.isPrimary === false
            ) return;
            try {
                region.setPointerCapture(event.pointerId);
            } catch {
                return;
            }
            event.preventDefault();
            gesture = {
                kind,
                region,
                pointerId: event.pointerId,
                screenX: event.screenX,
                screenY: event.screenY,
                queue: gestureQueue.then(() =>
                    request(`${kind}-start`, {
                        scale: globalThis.devicePixelRatio || 1,
                        ...(edge ? { edge } : {}),
                    })
                ),
            };
            gestureQueue = gesture.queue;
        }, options);
        const current = (event: PointerEvent) => {
            return gesture?.region === region &&
                    gesture.pointerId === event.pointerId
                ? gesture
                : undefined;
        };
        region.addEventListener("pointermove", (event) => {
            const session = current(event);
            if (!session) return;
            session.pending = {
                x: event.screenX - session.screenX,
                y: event.screenY - session.screenY,
            };
            if (session.frame !== undefined) return;
            session.frame = requestAnimationFrame(() => flushMove(session));
        }, options);
        region.addEventListener("pointerup", (event) => {
            const session = current(event);
            if (!session) return;
            if (
                event.screenX !== session.screenX ||
                event.screenY !== session.screenY
            ) {
                session.pending = {
                    x: event.screenX - session.screenX,
                    y: event.screenY - session.screenY,
                };
            }
            void finishGesture();
        }, options);
        for (const type of ["pointercancel", "lostpointercapture"] as const) {
            region.addEventListener(type, (event) => {
                if (current(event)) void finishGesture();
            }, options);
        }
    };
    attachGesture(dragRegion);
    for (
        const region of titlebar.querySelectorAll<HTMLElement>(
            "[data-desktop-resize]",
        )
    ) {
        const edge = region.dataset.desktopResize;
        if (
            edge && ["n", "s", "e", "w", "ne", "nw", "se", "sw"].includes(edge)
        ) {
            attachGesture(region, edge as ResizeEdge);
        }
    }
    dragRegion.addEventListener("dblclick", (event) => {
        if (event.button === 0) void toggleExpand();
    }, options);
    dragRegion.addEventListener("contextmenu", (event) => {
        if (!ready) return;
        event.preventDefault();
        void openMenu(event.clientX, event.clientY);
    }, options);
    dom.addEventListener("keydown", (event) => {
        if (
            !ready || event.defaultPrevented || event.isComposing ||
            event.repeat || !(event.ctrlKey || event.metaKey) ||
            event.altKey || event.shiftKey
        ) return;
        const key = event.key.toLowerCase();
        const action = key === "1"
            ? "chat"
            : key === "2"
            ? "console"
            : key === "w"
            ? "hide"
            : undefined;
        if (!action) return;
        event.preventDefault();
        void runAction(action);
    }, options);
    globalThis.addEventListener("heimdall:desktop-ready", connect, options);
    globalThis.addEventListener("heimdall:desktop-state", (event) => {
        applyState((event as CustomEvent<unknown>).detail);
    }, options);
    globalThis.addEventListener("focus", () => {
        if (ready) void request("state");
    }, options);
    globalThis.addEventListener("blur", finishGesture, options);
    void connect();
    return () => {
        void finishGesture();
        titlebar.removeAttribute("data-ready");
        for (const button of buttons) button.disabled = true;
        controller.abort();
    };
}
