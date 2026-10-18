import type { DesktopWindow } from "./native.ts";
import { unwrapDesktopResult } from "./native.ts";
import {
    type DesktopWindowState,
    sanitizeDesktopWindowState,
} from "./window-state.ts";

export const DESKTOP_BINDING = "__heimdallDesktopInvoke";

/** A window-scoped capability: native bind has no caller origin/frame metadata. */
export function createWindowControls(options: {
    window: DesktopWindow;
    origin: string;
    initial: DesktopWindowState;
    active: () => boolean;
    menu: () => Deno.MenuItem[];
    action: (id: string) => void;
    changed: (state: DesktopWindowState) => void;
    physicalCoordinates?: boolean;
    trayEnabled: boolean;
}) {
    const target = options.window;
    let token = "";
    let expanded = false;
    let normal = options.initial;
    let drag: [number, number] | undefined;
    let dragScale = 1;
    let disposed = false;
    let resizing: {
        edge: string;
        x: number;
        y: number;
        width: number;
        height: number;
        scale: number;
    } | undefined;
    const physicalCoordinates = options.physicalCoordinates ??
        Deno.build.os === "windows";
    const state = () => ({
        expanded,
        alwaysOnTop: normal.alwaysOnTop ?? false,
        trayEnabled: options.trayEnabled,
    });

    function remember(): void {
        if (target.isClosed() || expanded) return;
        const [width, height] = target.getSize();
        const [x, y] = target.getPosition();
        normal = sanitizeDesktopWindowState({
            width,
            height,
            x,
            y,
            alwaysOnTop: normal.alwaysOnTop,
        });
        options.changed(normal);
    }

    function apply(bounds: DesktopWindowState): void {
        target.setSize(bounds.width, bounds.height);
        if (bounds.x !== undefined && bounds.y !== undefined) {
            target.setPosition(bounds.x, bounds.y);
        }
    }

    function reset(): void {
        expanded = false;
        drag = undefined;
        normal = {
            width: 1280,
            height: 840,
            x: 40,
            y: 40,
            alwaysOnTop: normal.alwaysOnTop,
        };
        apply(normal);
        options.changed(normal);
        publish();
    }

    function toggleAlwaysOnTop(): void {
        normal = { ...normal, alwaysOnTop: !normal.alwaysOnTop };
        target.setAlwaysOnTop(normal.alwaysOnTop!);
        options.changed(normal);
        publish();
    }

    function publish(): void {
        if (!token || !options.active()) return;
        void target.executeJs(
            `globalThis.dispatchEvent(new CustomEvent("heimdall:desktop-state", {detail:${
                JSON.stringify(state())
            }}))`,
        )
            .then(unwrapDesktopResult)
            .catch((error) => console.error("[desktop] Window state:", error));
    }

    // Native bindings require async callbacks, including rejected commands.
    // deno-lint-ignore require-await
    target.bind(DESKTOP_BINDING, async (credential, command, payload) => {
        if (
            !token || credential !== token || !options.active() ||
            target.isClosed()
        ) {
            throw new Error("Desktop window capability expired.");
        }
        switch (command) {
            case "state":
                break;
            case "hide":
                options.action("hide");
                break;
            case "chat":
                options.action("chat");
                break;
            case "console":
                options.action("console");
                break;
            case "toggle-always-on-top":
                toggleAlwaysOnTop();
                break;
            case "toggle-expand": {
                drag = undefined;
                if (expanded) {
                    expanded = false;
                    apply(normal);
                } else {
                    const area = workArea(payload, physicalCoordinates);
                    remember();
                    expanded = true;
                    apply(area);
                }
                publish();
                break;
            }
            case "fit": {
                const area = workArea(payload, physicalCoordinates);
                if (!expanded) {
                    remember();
                    const width = Math.min(normal.width, area.width);
                    const height = Math.min(normal.height, area.height);
                    normal = {
                        ...normal,
                        width,
                        height,
                        x: Math.max(
                            area.x,
                            Math.min(
                                normal.x ?? area.x,
                                area.x + area.width - width,
                            ),
                        ),
                        y: Math.max(
                            area.y,
                            Math.min(
                                normal.y ?? area.y,
                                area.y + area.height - height,
                            ),
                        ),
                    };
                    apply(normal);
                    options.changed(normal);
                }
                break;
            }
            case "drag-start":
                dragScale = nativeScale(payload, physicalCoordinates);
                if (!expanded) drag = target.getPosition();
                break;
            case "drag-move": {
                const point = coordinates(payload);
                if (drag && !expanded) {
                    target.setPosition(
                        drag[0] + Math.round(point.x * dragScale),
                        drag[1] + Math.round(point.y * dragScale),
                    );
                }
                break;
            }
            case "drag-end":
                drag = undefined;
                remember();
                break;
            case "resize-start": {
                const edge =
                    payload && typeof payload === "object" && "edge" in payload
                        ? payload.edge
                        : undefined;
                if (
                    typeof edge !== "string" ||
                    !["n", "ne", "e", "se", "s", "sw", "w", "nw"].includes(edge)
                ) throw new Error("Invalid window resize edge.");
                const scale = nativeScale(payload, physicalCoordinates);
                if (!expanded) {
                    drag = undefined;
                    const [width, height] = target.getSize();
                    const [x, y] = target.getPosition();
                    resizing = { edge, scale, width, height, x, y };
                }
                break;
            }
            case "resize-move": {
                const delta = coordinates(payload);
                if (!resizing || expanded) break;
                const { edge, scale, x, y, width, height } = resizing;
                const dx = Math.round(delta.x * scale);
                const dy = Math.round(delta.y * scale);
                const nextWidth = Math.max(
                    Math.round(640 * scale),
                    Math.min(
                        16384,
                        width +
                            (edge.includes("e")
                                ? dx
                                : edge.includes("w")
                                ? -dx
                                : 0),
                    ),
                );
                const nextHeight = Math.max(
                    Math.round(480 * scale),
                    Math.min(
                        16384,
                        height +
                            (edge.includes("s")
                                ? dy
                                : edge.includes("n")
                                ? -dy
                                : 0),
                    ),
                );
                apply({
                    width: nextWidth,
                    height: nextHeight,
                    x: edge.includes("w") ? x + width - nextWidth : x,
                    y: edge.includes("n") ? y + height - nextHeight : y,
                });
                break;
            }
            case "resize-end":
                resizing = undefined;
                remember();
                break;
            case "menu": {
                const point = coordinates(payload);
                target.showContextMenu(point.x, point.y, options.menu());
                break;
            }
            default:
                throw new Error("Unsupported desktop command.");
        }
        return state();
    });

    return {
        remember,
        reset,
        toggleAlwaysOnTop,
        state,
        revoke() {
            token = "";
            drag = undefined;
            resizing = undefined;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            token = "";
            drag = undefined;
            resizing = undefined;
            target.unbind(DESKTOP_BINDING);
        },
        async grant(): Promise<void> {
            token = crypto.randomUUID();
            // Check again in the document receiving the capability, in case a
            // navigation occurred while the host inspected the previous page.
            unwrapDesktopResult(
                await target.executeJs(`(() => {
                if (location.origin !== ${
                    JSON.stringify(options.origin)
                } || window !== window.top) return;
                const boot = document.getElementById("heimdall-boot") || document.getElementById("heimdall-chat-boot");
                let value; try { value = JSON.parse(boot?.textContent || "{}"); } catch { return; }
                if (!(value.authenticated || value.snapshot?.authenticated || value.initial?.authenticated)) return;
                const token = ${JSON.stringify(token)};
                const invoke = globalThis.bindings?.${DESKTOP_BINDING};
                if (typeof invoke !== "function") throw new Error("Native desktop binding is unavailable.");
                globalThis.heimdallDesktop = (command, payload) => invoke(token, command, payload ?? null);
                globalThis.dispatchEvent(new Event("heimdall:desktop-ready"));
            })()`),
            );
        },
    };
}

function coordinates(value: unknown): { x: number; y: number } {
    if (!value || typeof value !== "object") {
        throw new Error("Invalid window coordinates.");
    }
    const { x, y } = value as Record<string, unknown>;
    if (
        typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) ||
        !Number.isFinite(y) || Math.abs(x) > 100_000 || Math.abs(y) > 100_000
    ) {
        throw new Error("Invalid window coordinates.");
    }
    return { x: Math.round(x), y: Math.round(y) };
}

function workArea(
    value: unknown,
    physicalCoordinates: boolean,
): { x: number; y: number; width: number; height: number } {
    const point = coordinates(value);
    const { width, height } = value as Record<string, unknown>;
    if (
        typeof width !== "number" || typeof height !== "number" ||
        !Number.isFinite(width) || !Number.isFinite(height) || width < 320 ||
        height < 240 || width > 16384 || height > 16384
    ) {
        throw new Error("Invalid display work area.");
    }
    const scale = nativeScale(value, physicalCoordinates);
    return {
        x: Math.round(point.x * scale),
        y: Math.round(point.y * scale),
        width: Math.round(width * scale),
        height: Math.round(height * scale),
    };
}

function nativeScale(value: unknown, physicalCoordinates: boolean): number {
    const scale = value && typeof value === "object" && "scale" in value
        ? value.scale
        : 1;
    if (
        typeof scale !== "number" || !Number.isFinite(scale) || scale < 0.5 ||
        scale > 8
    ) {
        throw new Error("Invalid display scale.");
    }
    // WebView2 uses physical bounds under per-monitor DPI awareness.
    return physicalCoordinates ? scale : 1;
}
