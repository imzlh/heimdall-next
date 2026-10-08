import type { MiddlewarePlugin } from "@heimdall/contracts";
import { MiddlewareRegistry } from "@heimdall/kernel";
import type { ConfigStore } from "@heimdall/storage";
import {
    parseSourceMiddleware,
    type SourceMiddleware,
} from "@heimdall/admin-contracts/source-middleware.ts";
import type { StoredSourceConfig } from "./source-records.ts";

/**
 * Trusted HIP middleware and host-owned source bindings. Bindings never enable
 * plugins: the kernel resolves their IDs against its enabled global snapshot.
 */
export class BuiltinMiddlewarePlugins {
    readonly registry = new MiddlewareRegistry();
    readonly #plugins = new Map<string, MiddlewarePlugin>();
    readonly #sourceBindings = new Map<string, readonly string[]>();
    readonly #bindingErrors = new Map<string, string>();

    add(plugin: MiddlewarePlugin): void {
        // Validate even disabled plugins so the catalog cannot advertise a
        // switch that only discovers malformed hooks after a durable write.
        const validator = new MiddlewareRegistry();
        validator.register(plugin);
        const id = plugin.manifest.id;
        if (this.#plugins.has(id)) {
            throw new TypeError(`middleware already loaded: ${id}`);
        }
        // Capture the hook functions/order once. Registering a previously
        // validated plugin after persisting its switch cannot fail because a
        // module subsequently changed its exported descriptor.
        this.#plugins.set(
            id,
            Object.freeze({
                manifest: Object.freeze({ ...plugin.manifest }),
                order: plugin.order,
                ...(plugin.transformRequest === undefined ? {} : {
                    transformRequest: plugin.transformRequest.bind(plugin),
                }),
                ...(plugin.transformFrames === undefined ? {} : {
                    transformFrames: plugin.transformFrames.bind(plugin),
                }),
            }),
        );
    }

    has(id: string): boolean {
        return this.#plugins.has(id);
    }

    /** Validate bindings independently of a plugin's current enabled state. */
    validateSelection(value: unknown): SourceMiddleware {
        const selection = parseSourceMiddleware(value);
        for (const id of selection ?? []) {
            if (!this.has(id)) {
                throw new TypeError(`中间件插件不可用：${id}`);
            }
        }
        return selection;
    }

    /** Read before source restoration so damaged bindings can be quarantined. */
    async restoreBindings(store: ConfigStore): Promise<void> {
        this.#sourceBindings.clear();
        this.#bindingErrors.clear();
        const sources = store.namespace("heimdall", "source-config");
        for await (const entry of sources.list<StoredSourceConfig>()) {
            if (entry.value.deleted) continue;
            const sourceId = String(entry.key.at(-1) ?? "");
            if (sourceId) this.setSource(sourceId, entry.value.middleware);
        }
    }

    /** Call only after the source record's durable write succeeds. */
    setSource(sourceId: string, value: unknown): void {
        try {
            const selection = parseSourceMiddleware(value);
            if (selection === null) this.#sourceBindings.delete(sourceId);
            else this.#sourceBindings.set(sourceId, selection);
            this.#bindingErrors.delete(sourceId);
        } catch {
            // A damaged persisted record cannot opt into the global chain or
            // prevent healthy sources from starting. The catalog reports this
            // error and restoration leaves the affected source unregistered.
            this.#sourceBindings.set(sourceId, Object.freeze([]));
            this.#bindingErrors.set(
                sourceId,
                "渠道中间件配置损坏，已停止路由；请重新选择中间件并保存。",
            );
        }
    }

    sourceSelection(sourceId: string): SourceMiddleware {
        return this.#sourceBindings.get(sourceId) ?? null;
    }

    sourceError(sourceId: string): string | undefined {
        return this.#bindingErrors.get(sourceId);
    }

    /** Copies the map; frozen arrays keep a running request's order stable. */
    sourceSnapshot(
        eligible: (sourceId: string) => boolean = () => true,
    ): ReadonlyMap<string, readonly string[]> {
        return new Map(
            [...this.#sourceBindings].filter(([sourceId]) =>
                eligible(sourceId)
            ),
        );
    }

    restore(states: ReadonlyMap<string, boolean>): void {
        for (const id of this.#plugins.keys()) {
            this.setEnabled(id, states.get(id) !== false);
        }
    }

    /** Call only after the switch's durable write succeeds. */
    setEnabled(id: string, enabled: boolean): void {
        const plugin = this.#plugins.get(id);
        if (plugin === undefined) {
            throw new TypeError(`middleware is not loaded: ${id}`);
        }
        if (!enabled) this.registry.unregister(id);
        else if (this.registry.get(id) === undefined) {
            this.registry.register(plugin);
        }
    }
}
