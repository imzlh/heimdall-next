import {
    isUiAction,
    isUiJsonObject,
    resolveUiRender,
    UI_LIMITS,
    uiActionAllowed,
} from "@heimdall/admin-contracts/ui.ts";
import type {
    UiAction,
    UiContext,
    UiContribution,
    UiPolicy,
} from "@heimdall/admin-contracts/ui.ts";

import { mountUiModule } from "./lifecycle.ts";
import { randomUuid } from "../random-id.ts";
import type { TrustedUiModule, UiCleanup } from "./lifecycle.ts";
export type { TrustedUiModule, UiCleanup } from "./lifecycle.ts";

export interface UiExtensionOptions {
    readonly policy?: UiPolicy;
    /** Host adapter validates operation-specific payloads; never fetch arbitrary URLs. */
    readonly onAction?: (
        contribution: UiContribution,
        action: UiAction,
        context: UiContext,
    ) => void | Promise<void>;
}

export type UiFrameMessage =
    | { protocol: "heimdall.ui"; version: 1; instance: string; kind: "ready" }
    | {
        protocol: "heimdall.ui";
        version: 1;
        instance: string;
        kind: "resize";
        height: number;
    }
    | {
        protocol: "heimdall.ui";
        version: 1;
        instance: string;
        kind: "action";
        action: UiAction;
    };

/** Opaque-origin frames are authenticated by Window identity AND an instance nonce. */
export function validateUiFrameMessage(
    event: Pick<MessageEvent, "source" | "origin" | "data">,
    expectedSource: MessageEventSource | null,
    instance: string,
): UiFrameMessage | null {
    if (
        !expectedSource || event.source !== expectedSource ||
        event.origin !== "null"
    ) return null;
    const value: unknown = event.data;
    if (
        !isUiJsonObject(value) || value.protocol !== "heimdall.ui" ||
        value.version !== 1 || value.instance !== instance
    ) return null;
    if (value.kind === "ready" && Object.keys(value).length === 4) {
        return value as unknown as UiFrameMessage;
    }
    if (
        value.kind === "resize" && Object.keys(value).length === 5 &&
        typeof value.height === "number" && Number.isFinite(value.height)
    ) return value as unknown as UiFrameMessage;
    if (
        value.kind === "action" && Object.keys(value).length === 5 &&
        isUiAction(value.action)
    ) return value as unknown as UiFrameMessage;
    return null;
}

export function uiFrameHeight(height: number): number {
    return Math.max(
        UI_LIMITS.frameMinHeight,
        Math.min(
            UI_LIMITS.frameMaxHeight,
            Math.round(
                Number.isFinite(height) ? height : UI_LIMITS.frameMinHeight,
            ),
        ),
    );
}

/** Enhance one host-owned SSR slot. Cleanup also covers a pending async mount. */
export function enhancePluginSlot(
    root: HTMLElement,
    contribution: UiContribution,
    context: UiContext,
    options: UiExtensionOptions = {},
): UiCleanup {
    const fallback = root.querySelector<HTMLElement>("[data-ui-fallback]");
    const target = root.querySelector<HTMLElement>("[data-ui-mount]");
    const notice = root.querySelector<HTMLElement>("[data-ui-notice]");
    if (!fallback || !target || !isUiJsonObject(context)) return () => {};
    if (notice) {
        notice.hidden = true;
        notice.textContent = "";
    }
    const policy = options.policy ?? {};
    const mode = resolveUiRender(contribution, policy);
    const cleanups: UiCleanup[] = [];
    // A pending old mount may write only into its detached container, never a new mount.
    const stage = document.createElement("div");
    if (mode.kind !== "schema") target.append(stage);
    let disposed = false;
    let failed = false;
    const report = () => {
        if (disposed) return;
        failed = true;
        fallback.hidden = false;
        target.hidden = true;
        for (
            const button of root.querySelectorAll<HTMLButtonElement>(
                "[data-ui-action-index]",
            )
        ) button.disabled = true;
        if (notice) {
            notice.textContent = "插件交互暂不可用，已保留静态内容。";
            notice.hidden = false;
        }
    };
    const reveal = () => {
        if (disposed || failed) return;
        fallback.hidden = true;
        target.hidden = false;
    };
    const runCleanup = async (cleanup: UiCleanup) => {
        try {
            await cleanup();
        } catch { /* A failed plugin cleanup cannot stop host cleanup. */ }
    };
    const dispatch = async (action: unknown) => {
        if (
            disposed || failed || !options.onAction ||
            !uiActionAllowed(contribution, action, policy)
        ) return;
        await options.onAction(
            contribution,
            JSON.parse(JSON.stringify(action)),
            context,
        );
    };
    for (
        const button of root.querySelectorAll<HTMLButtonElement>(
            "[data-ui-action-index]",
        )
    ) {
        button.disabled = true;
        button.removeAttribute("aria-busy");
        const block =
            contribution.schema.blocks[Number(button.dataset.uiActionIndex)];
        if (
            block?.kind !== "action" || !options.onAction ||
            !uiActionAllowed(contribution, block.action, policy)
        ) continue;
        button.disabled = false;
        button.removeAttribute("title");
        let pending = false;
        const click = async () => {
            if (pending) return;
            pending = true;
            button.disabled = true;
            button.setAttribute("aria-busy", "true");
            try {
                await dispatch(block.action);
            } catch {
                report();
            } finally {
                pending = false;
                if (!disposed) {
                    if (!failed) button.disabled = false;
                    button.removeAttribute("aria-busy");
                }
            }
        };
        button.addEventListener("click", click);
        cleanups.push(() => {
            button.removeEventListener("click", click);
            button.disabled = true;
        });
    }
    if (mode.kind === "trusted") {
        const action = (event: Event) => {
            if (event instanceof CustomEvent) {
                void dispatch(event.detail).catch(report);
            }
        };
        stage.addEventListener("heimdall:ui-action", action);
        cleanups.push(() =>
            stage.removeEventListener("heimdall:ui-action", action)
        );
        // The validated path is selected by host policy. No manifest may self-authorize import.
        cleanups.push(mountUiModule(
            () => import(mode.modulePath) as Promise<TrustedUiModule>,
            stage,
            context,
            reveal,
            report,
        ));
    } else if (mode.kind === "sandbox") {
        const frame = document.createElement("iframe");
        const instance = randomUuid();
        frame.title = contribution.title;
        frame.className = "slot-frame";
        frame.sandbox.add("allow-scripts");
        frame.referrerPolicy = "no-referrer";
        frame.setAttribute(
            "allow",
            "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'",
        );
        frame.style.height = `${UI_LIMITS.frameMinHeight}px`;
        const timeout = setTimeout(report, 10_000);
        const receive = (event: MessageEvent) => {
            if (disposed || failed) return;
            const message = validateUiFrameMessage(
                event,
                frame.contentWindow,
                instance,
            );
            if (!message) return;
            if (message.kind === "ready") {
                clearTimeout(timeout);
                reveal();
            }
            if (message.kind === "resize") {
                frame.style.height = `${uiFrameHeight(message.height)}px`;
            }
            if (message.kind === "action") {
                void dispatch(message.action).catch(report);
            }
        };
        const init = () =>
            frame.contentWindow?.postMessage({
                protocol: "heimdall.ui",
                version: 1,
                instance,
                kind: "init",
                context,
            }, "*");
        frame.addEventListener("load", init);
        frame.addEventListener("error", report);
        globalThis.addEventListener("message", receive);
        frame.src = mode.documentPath;
        stage.append(frame);
        cleanups.push(() => {
            clearTimeout(timeout);
            globalThis.removeEventListener("message", receive);
            frame.removeEventListener("load", init);
            frame.removeEventListener("error", report);
            frame.remove();
        });
    }
    return async () => {
        if (disposed) return;
        disposed = true;
        stage.remove();
        target.hidden = true;
        fallback.hidden = false;
        await Promise.allSettled(cleanups.map(runCleanup));
    };
}
