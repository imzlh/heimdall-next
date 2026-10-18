import { type RuntimeOptions, startRuntime } from "../runtime/server.ts";

/** Backwards-compatible options for the standalone server entry point. */
export type ServeOptions = RuntimeOptions;

/** Run the application until the supervisor or an OS shutdown signal stops it. */
export async function serve(options: ServeOptions = {}): Promise<void> {
    await using runtime = await startRuntime(options);
    using _signals = listenForShutdown(() => runtime.close());
    await runtime.finished;
}

function listenForShutdown(shutdown: () => Promise<void>): Disposable {
    using listeners = new DisposableStack();
    // Deno only supports SIGINT/SIGBREAK on Windows.
    const signals: Deno.Signal[] = Deno.build.os === "windows"
        ? ["SIGINT"]
        : ["SIGINT", "SIGTERM"];
    const handleSignal = () => {
        // The process also awaits runtime.finished, which includes cleanup.
        void shutdown().catch(() => undefined);
    };
    for (const signal of signals) {
        Deno.addSignalListener(signal, handleSignal);
        listeners.defer(() => Deno.removeSignalListener(signal, handleSignal));
    }
    return listeners.move();
}
