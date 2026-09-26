import type { MiddlewarePlugin } from "@heimdall/contracts";
import { MiddlewareRegistry } from "@heimdall/kernel";

/**
 * Global HIP middleware loaded by the trusted directory composition.
 * Source-specific bindings are a separate policy and are not inferred here.
 */
export class BuiltinMiddlewarePlugins {
    readonly registry = new MiddlewareRegistry();
    readonly #plugins = new Map<string, MiddlewarePlugin>();

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
