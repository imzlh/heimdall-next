import type { SourceRegistry } from "@heimdall/kernel";
import type { RuntimeSettingsHandle } from "./runtime-settings.ts";
import { probeSources } from "./probe-loop.ts";

/** Minimal event sink; the process default `log` satisfies it. */
export interface EventRecorder {
    debug(scope: string, message: string, detail?: string): void;
    info(scope: string, message: string, detail?: string): void;
    warn(scope: string, message: string, detail?: string): void;
    error(scope: string, message: string, detail?: string): void;
}

/** Own timers and cancellation independently of HTTP and plugin resources. */
export function startBackgroundTasks(
    sources: SourceRegistry,
    settings: RuntimeSettingsHandle,
    logger?: EventRecorder,
): AsyncDisposable {
    let stopped = false;
    let interval = settings.get().probeIntervalMs;
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    let active:
        | { controller: AbortController; done: Promise<void> }
        | undefined;
    let restart = false;
    const clearProbeTimer = () => {
        if (probeTimer !== undefined) clearTimeout(probeTimer);
        probeTimer = undefined;
    };
    const schedule = () => {
        if (stopped || active || interval === 0) return;
        clearProbeTimer();
        probeTimer = setTimeout(runProbe, interval);
    };
    const runProbe = () => {
        clearProbeTimer();
        if (stopped || active || interval === 0) return;
        restart = false;
        const controller = new AbortController();
        const done = probeSources(sources, 10_000, controller.signal).then(
            () => logger?.debug("probe", "完成一轮上游健康探测。"),
            (error) => {
                if (controller.signal.aborted) return;
                logger?.warn("probe", "上游健康探测未完成。", reason(error));
            },
        );
        const current = { controller, done };
        active = current;
        void done.then(() => {
            if (active !== current) return;
            active = undefined;
            if (restart) runProbe();
            else schedule();
        });
    };
    const unsubscribe = settings.subscribe(() => {
        const next = settings.get().probeIntervalMs;
        if (stopped || next === interval) return;
        interval = next;
        clearProbeTimer();
        restart = interval > 0;
        if (active) active.controller.abort();
        else if (restart) runProbe();
    });
    if (interval > 0) runProbe();

    return {
        async [Symbol.asyncDispose]() {
            stopped = true;
            restart = false;
            unsubscribe();
            clearProbeTimer();
            active?.controller.abort();
            // Cancellation also releases the wait when a plugin ignores its signal.
            await active?.done;
        },
    };
}

function reason(error: unknown): string | undefined {
    if (error instanceof Error) return error.message;
    return typeof error === "string" && error.length > 0 ? error : undefined;
}
