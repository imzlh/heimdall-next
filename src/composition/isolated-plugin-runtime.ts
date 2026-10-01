import type { JsonValue } from "@heimdall/contracts";
import type {
    PluginArtifact,
    PluginInvocation,
    PluginRuntime,
} from "@heimdall/plugin-host";
import { validatePluginResult } from "./isolated-plugin-message.ts";

// The only worker capability is JSON RPC. Code and dependencies are prebundled
// in the uploaded ESM; no environment, disk, process or network permission is inherited.
const bootstrap = `
let implementation;
const pending = new Map();
const send = self.postMessage.bind(self);
const close = self.close.bind(self);
self.close = () => { send({ closed: true }); close(); };
self.onmessage = async ({ data }) => {
    if (data.cancel) { pending.get(data.id)?.abort(); return; }
    if (data.method === "__ping") { send({ id: data.id }); return; }
    const controller = new AbortController();
    pending.set(data.id, controller);
    try {
        if (data.method === "__start") {
            implementation = await import(data.module);
            if (typeof implementation.invoke !== "function") throw new Error("plugin must export invoke(method, payload, context)");
            send({ id: data.id });
        } else {
            const value = await implementation.invoke(data.method, data.payload, {
                signal: controller.signal,
                ...(data.request === undefined ? {} : { request: data.request }),
            });
            const json = value === undefined ? undefined : JSON.stringify(value);
            if (json !== undefined && (json.length > 262144 || new TextEncoder().encode(json).byteLength > 262144)) throw new Error("plugin result exceeds 256 KiB");
            send({ id: data.id, value: json === undefined ? undefined : JSON.parse(json) });
        }
    } catch (error) {
        send({ id: data.id, error: String(error?.message ?? error).slice(0, 1000) });
    } finally { pending.delete(data.id); }
};
`;

interface Pending {
    resolve(value: JsonValue | undefined): void;
    reject(error: unknown): void;
    dispose(): void;
}

/** Deno worker adapter. The runtime-neutral PluginHost owns lifecycle policy. */
export class IsolatedPluginRuntime implements PluginRuntime {
    #worker?: Worker;
    #urls: string[] = [];
    #pending = new Map<string, Pending>();
    #heartbeat?: ReturnType<typeof setInterval>;
    #failureListeners = new Set<(error: Error) => void>();

    constructor(readonly timeoutMs = 15_000, readonly heartbeatMs = 15_000) {}

    isActive(): boolean {
        return this.#worker !== undefined;
    }

    onFailure(listener: (error: Error) => void): () => void {
        this.#failureListeners.add(listener);
        return () => this.#failureListeners.delete(listener);
    }

    async start(artifact: PluginArtifact): Promise<void> {
        if (
            artifact.manifest.trust !== "isolated" ||
            artifact.bytes === undefined
        ) {
            throw new TypeError("isolated runtime requires bundled ESM bytes");
        }
        // Teardown is synchronous so a stop/restart cannot overtake startup
        // between an awaited stop() and allocating the new worker.
        this.#terminate(new Error("plugin worker restarted"));
        let worker: Worker | undefined;
        try {
            const module = URL.createObjectURL(
                new Blob([new Uint8Array(artifact.bytes)], {
                    type: "application/javascript",
                }),
            );
            this.#urls.push(module);
            const entry = URL.createObjectURL(
                new Blob([bootstrap], { type: "application/javascript" }),
            );
            this.#urls.push(entry);
            worker = new Worker(entry, {
                type: "module",
                name: artifact.manifest.id,
                deno: { permissions: "none" },
            });
            this.#worker = worker;
            worker.onmessage = ({ data }) => {
                if (this.#worker !== worker) return;
                if (
                    data === null || typeof data !== "object" ||
                    Array.isArray(data) ||
                    Object.getPrototypeOf(data) !== Object.prototype ||
                    Object.keys(data).some((key) =>
                        !["id", "value", "error", "closed"].includes(key)
                    )
                ) {
                    this.#fail(
                        new Error("plugin worker returned invalid response"),
                    );
                    return;
                }
                if (data?.closed === true) {
                    this.#fail(new Error("plugin worker closed unexpectedly"));
                    return;
                }
                if (
                    data.closed !== undefined || typeof data.id !== "string" ||
                    data.id.length > 128
                ) {
                    this.#fail(
                        new Error("plugin worker returned invalid response"),
                    );
                    return;
                }
                const pending = this.#pending.get(data?.id);
                if (pending === undefined) return;
                let value: JsonValue | undefined;
                try {
                    if (
                        data.error !== undefined &&
                        (typeof data.error !== "string" ||
                            data.error.length > 1000)
                    ) {
                        throw new TypeError(
                            "plugin worker returned invalid error",
                        );
                    }
                    value = validatePluginResult(data.value);
                } catch (error) {
                    this.#fail(error);
                    return;
                }
                this.#pending.delete(data.id);
                pending.dispose();
                if (typeof data.error === "string") {
                    pending.reject(new Error(data.error));
                } else pending.resolve(value);
            };
            worker.onerror = (event) => {
                event.preventDefault();
                if (this.#worker === worker) {
                    this.#fail(new Error("plugin worker failed"));
                }
            };
            worker.onmessageerror = () => {
                if (this.#worker === worker) {
                    this.#fail(new Error("plugin worker message failed"));
                }
            };
            await this.#call("__start", undefined, undefined, module);
            if (this.#worker !== worker) {
                throw new Error("plugin worker stopped during startup");
            }
            // Worker has no standard exit event. A deadline on an internal ping
            // also catches silent exits or overwritten message handlers while idle.
            this.#heartbeat = setInterval(() => {
                this.#call("__ping").catch(() => {});
            }, this.heartbeatMs);
        } catch (error) {
            // An earlier startup rejection must not terminate a newer worker.
            // This also covers failure before Worker construction succeeds.
            if (this.#worker === worker) this.#terminate(error);
            throw error;
        }
    }

    invoke(invocation: PluginInvocation): Promise<JsonValue | undefined> {
        if (invocation.method.startsWith("__")) {
            return Promise.reject(new TypeError("reserved plugin method"));
        }
        return this.#call(
            invocation.method,
            invocation.payload,
            invocation.signal,
            undefined,
            invocation.request === undefined ? undefined : {
                requestId: invocation.request.requestId,
                metadata: invocation.request.metadata,
            },
        );
    }

    #call(
        method: string,
        payload?: JsonValue,
        signal?: AbortSignal,
        module?: string,
        request?: PluginInvocation["request"],
    ): Promise<JsonValue | undefined> {
        const worker = this.#worker;
        if (worker === undefined) {
            return Promise.reject(new Error("plugin worker is not running"));
        }
        if (signal?.aborted) return Promise.reject(signal.reason);
        if (this.#pending.size >= 32) {
            return Promise.reject(new Error("plugin invocation limit reached"));
        }
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const abort = () => {
                signal?.removeEventListener("abort", abort);
                reject(signal?.reason);
                // Cancellation releases the caller immediately, but the worker
                // still owns a slot and deadline until it acknowledges. Clearing
                // its watchdog here would leave synchronous loops running forever.
                try {
                    worker.postMessage({ id, cancel: true });
                } catch (error) {
                    if (this.#worker === worker) this.#fail(error);
                }
            };
            const timeout = setTimeout(() => {
                // Terminate runaway synchronous code, including an infinite loop.
                if (this.#worker === worker) {
                    this.#fail(new Error("plugin invocation timed out"));
                }
            }, this.timeoutMs);
            const dispose = () => {
                clearTimeout(timeout);
                signal?.removeEventListener("abort", abort);
            };
            this.#pending.set(id, { resolve, reject, dispose });
            signal?.addEventListener("abort", abort, { once: true });
            try {
                worker.postMessage({ id, method, payload, module, request });
            } catch (error) {
                this.#pending.delete(id);
                dispose();
                reject(error);
            }
        });
    }

    #terminate(error: unknown): void {
        clearInterval(this.#heartbeat);
        this.#heartbeat = undefined;
        this.#worker?.terminate();
        this.#worker = undefined;
        for (const url of this.#urls) URL.revokeObjectURL(url);
        this.#urls = [];
        for (const pending of this.#pending.values()) {
            pending.dispose();
            pending.reject(error);
        }
        this.#pending.clear();
    }

    #fail(reason: unknown): void {
        const error = reason instanceof Error
            ? reason
            : new Error(String(reason));
        this.#terminate(error);
        for (const listener of this.#failureListeners) {
            try {
                listener(error);
            } catch {
                /* One observer cannot prevent the others from cleaning up. */
            }
        }
    }

    stop(): Promise<void> {
        this.#terminate(new Error("plugin worker stopped"));
        return Promise.resolve();
    }
}
