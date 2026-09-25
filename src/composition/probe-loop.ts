import type { SourceRegistry } from "@heimdall/kernel";
import type { SourceProbeResult } from "@heimdall/contracts";

const latestProbes = new WeakMap<SourceRegistry, Map<string, symbol>>();

/** Run the same bounded probe for periodic checks and operator-triggered checks. */
export async function probeSource(
    sources: SourceRegistry,
    sourceId: string,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } =
        {},
): Promise<SourceProbeResult | undefined> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (
        !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
        timeoutMs > 86_400_000
    ) {
        throw new RangeError(
            "probe timeout must be an integer from 1 to 86400000",
        );
    }
    options.signal?.throwIfAborted();
    const source = sources.get(sourceId);
    if (!source?.probe) return;
    let probes = latestProbes.get(sources);
    if (!probes) latestProbes.set(sources, probes = new Map());
    const token = Symbol();
    probes.set(sourceId, token);
    const controller = new AbortController();
    const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
    const timer = setTimeout(
        () =>
            controller.abort(
                new DOMException("probe timed out", "TimeoutError"),
            ),
        timeoutMs,
    );
    let aborted: (() => void) | undefined;
    try {
        const cancellation = new Promise<never>((_, reject) => {
            aborted = () => reject(signal.reason);
            signal.addEventListener("abort", aborted, { once: true });
            if (signal.aborted) aborted();
        });
        const operation = Promise.resolve().then(() => {
            signal.throwIfAborted();
            return source.probe!(signal);
        });
        let result: SourceProbeResult;
        try {
            result = await Promise.race([operation, cancellation]);
            result = { ...result, message: safeProbeMessage(result.message) };
        } catch {
            options.signal?.throwIfAborted();
            result = {
                ok: false,
                message: controller.signal.aborted
                    ? "probe timed out"
                    : "probe failed",
            };
        }
        options.signal?.throwIfAborted();
        // A removed/reconfigured channel or a newer probe owns its current status.
        if (
            sources.get(sourceId) !== source || probes.get(sourceId) !== token
        ) return;
        sources.recordProbe(sourceId, result);
        return result;
    } finally {
        clearTimeout(timer);
        if (aborted) signal.removeEventListener("abort", aborted);
        if (probes.get(sourceId) === token) probes.delete(sourceId);
    }
}

/**
 * Ask each live source that implements `probe` whether its upstream is
 * reachable. The registry only stores the result; the plugin performs I/O.
 */
export async function probeSources(
    sources: SourceRegistry,
    timeoutMs = 10_000,
    signal?: AbortSignal,
): Promise<void> {
    for (const source of sources.list()) {
        signal?.throwIfAborted();
        if (source.probe === undefined) continue;
        await probeSource(sources, source.id, { timeoutMs, signal });
    }
}

export function readProbeInterval(value: string | undefined): number {
    if (value === undefined || value.trim().length === 0) return 300_000;
    const interval = Number(value);
    if (!Number.isInteger(interval) || interval < 0 || interval > 86_400_000) {
        throw new RangeError(
            "HEIMDALL_PROBE_INTERVAL_MS must be an integer from 0 to 86400000",
        );
    }
    return interval;
}

function safeProbeMessage(message: string): string {
    const trimmed = message.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 300) : "probe failed";
}
