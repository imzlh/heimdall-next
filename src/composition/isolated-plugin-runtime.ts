import type { JsonValue } from "@heimdall/contracts";
import type { PluginArtifact, PluginInvocation, PluginRuntime } from "@heimdall/plugin-host";

// The only worker capability is JSON RPC. Code and dependencies are prebundled
// in the uploaded ESM; no environment, disk, process or network permission is inherited.
const bootstrap = `
let implementation;
const pending = new Map();
self.onmessage = async ({ data }) => {
    if (data.cancel) { pending.get(data.id)?.abort(); return; }
    const controller = new AbortController();
    pending.set(data.id, controller);
    try {
        if (data.method === "__start") {
            implementation = await import(data.module);
            if (typeof implementation.invoke !== "function") throw new Error("plugin must export invoke(method, payload, context)");
            self.postMessage({ id: data.id });
        } else {
            const value = await implementation.invoke(data.method, data.payload, { signal: controller.signal });
            const json = value === undefined ? undefined : JSON.stringify(value);
            if (json !== undefined && json.length > 262144) throw new Error("plugin result exceeds 256 KiB");
            self.postMessage({ id: data.id, value: json === undefined ? undefined : JSON.parse(json) });
        }
    } catch (error) {
        self.postMessage({ id: data.id, error: String(error?.message ?? error).slice(0, 1000) });
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

    constructor(readonly timeoutMs = 15_000) {}

    async start(artifact: PluginArtifact): Promise<void> {
        if (artifact.manifest.trust !== "isolated" || artifact.bytes === undefined) {
            throw new TypeError("isolated runtime requires bundled ESM bytes");
        }
        await this.stop();
        const module = URL.createObjectURL(new Blob([new Uint8Array(artifact.bytes)], { type: "application/javascript" }));
        const entry = URL.createObjectURL(new Blob([bootstrap], { type: "application/javascript" }));
        this.#urls = [module, entry];
        this.#worker = new Worker(entry, {
            type: "module", name: artifact.manifest.id,
            deno: { permissions: "none" },
        });
        this.#worker.onmessage = ({ data }) => {
            const pending = this.#pending.get(data?.id);
            if (pending === undefined) return;
            this.#pending.delete(data.id);
            pending.dispose();
            if (typeof data.error === "string") pending.reject(new Error(data.error));
            else pending.resolve(data.value);
        };
        this.#worker.onerror = (event) => {
            event.preventDefault();
            this.#terminate(new Error("plugin worker failed"));
        };
        await this.#call("__start", undefined, undefined, module);
    }

    invoke(invocation: PluginInvocation): Promise<JsonValue | undefined> {
        if (invocation.method.startsWith("__")) return Promise.reject(new TypeError("reserved plugin method"));
        return this.#call(invocation.method, invocation.payload, invocation.signal);
    }

    #call(method: string, payload?: JsonValue, signal?: AbortSignal, module?: string): Promise<JsonValue | undefined> {
        if (this.#worker === undefined) return Promise.reject(new Error("plugin worker is not running"));
        if (signal?.aborted) return Promise.reject(signal.reason);
        if (this.#pending.size >= 32) return Promise.reject(new Error("plugin invocation limit reached"));
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const abort = () => {
                this.#worker?.postMessage({ id, cancel: true });
                this.#pending.delete(id);
                dispose();
                reject(signal?.reason);
            };
            const timeout = setTimeout(() => {
                // Terminate runaway synchronous code, including an infinite loop.
                this.#terminate(new Error("plugin invocation timed out"));
            }, this.timeoutMs);
            const dispose = () => {
                clearTimeout(timeout);
                signal?.removeEventListener("abort", abort);
            };
            this.#pending.set(id, { resolve, reject, dispose });
            signal?.addEventListener("abort", abort, { once: true });
            try { this.#worker!.postMessage({ id, method, payload, module }); }
            catch (error) { this.#pending.delete(id); dispose(); reject(error); }
        });
    }

    #terminate(error: Error): void {
        this.#worker?.terminate();
        this.#worker = undefined;
        for (const url of this.#urls) URL.revokeObjectURL(url);
        this.#urls = [];
        for (const pending of this.#pending.values()) { pending.dispose(); pending.reject(error); }
        this.#pending.clear();
    }

    stop(): Promise<void> {
        this.#terminate(new Error("plugin worker stopped"));
        return Promise.resolve();
    }
}
