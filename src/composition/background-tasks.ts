import type { SourceRegistry } from "@heimdall/kernel";
import type { RuntimeSettingsHandle } from "./runtime-settings.ts";
import { probeSources } from "./probe-loop.ts";
import {
    MAINTENANCE_INTERVAL_MS,
    type PrunableJournal,
    runMaintenance,
} from "./maintenance.ts";

/** Own timers and cancellation independently of HTTP and plugin resources. */
export function startBackgroundTasks(
    sources: SourceRegistry,
    settings: RuntimeSettingsHandle,
    requests: PrunableJournal,
    retentionDays: number,
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
        const done = probeSources(sources, 10_000, controller.signal).catch(
            () => undefined,
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

    let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
    if (retentionDays > 0) {
        const sweep = () => {
            try {
                runMaintenance(requests, { retentionDays });
            } catch { /* A failed sweep must not crash the serving process. */ }
        };
        sweep();
        maintenanceTimer = setInterval(sweep, MAINTENANCE_INTERVAL_MS);
    }
    return {
        async [Symbol.asyncDispose]() {
            stopped = true;
            restart = false;
            unsubscribe();
            clearProbeTimer();
            if (maintenanceTimer !== undefined) clearInterval(maintenanceTimer);
            active?.controller.abort();
            // Cancellation also releases the wait when a plugin ignores its signal.
            await active?.done;
        },
    };
}
