import type { UiContext } from "@heimdall/admin-contracts/ui.ts";

export type UiCleanup = () => void | Promise<void>;
export interface TrustedUiModule {
    /** Request actions by dispatching `heimdall:ui-action` with JSON detail. */
    mount(
        element: HTMLElement,
        context: UiContext,
    ): void | UiCleanup | Promise<void | UiCleanup>;
}

/** Cancellation covers both a pending module load and asynchronous mount work. */
export function mountUiModule(
    load: () => Promise<TrustedUiModule>,
    element: HTMLElement,
    context: UiContext,
    ready: () => void,
    report: () => void,
): UiCleanup {
    let disposed = false;
    let cleanup: UiCleanup | undefined;
    const release = async () => {
        const callback = cleanup;
        cleanup = undefined;
        if (callback) {
            try {
                await callback();
            } catch { /* Cleanup failures stay within the extension. */ }
        }
    };
    void load().then(async (module) => {
        if (disposed) return;
        if (typeof module.mount !== "function") {
            throw new TypeError("UI module must export mount");
        }
        const result = await module.mount(
            element,
            JSON.parse(JSON.stringify(context)),
        );
        if (typeof result === "function") cleanup = result;
        if (disposed) await release();
        else ready();
    }).catch(() => {
        if (!disposed) report();
    });
    return async () => {
        disposed = true;
        await release();
    };
}
