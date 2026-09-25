import type { PluginRoute, ProtocolPlugin } from "../contracts/mod.ts";

import type { ProtocolMatch, ProtocolRouter } from "./mod.ts";

/** A protocol plugin returned a route that it did not declare. */
export class ProtocolRouteError extends Error {
    override readonly name = "ProtocolRouteError";
}

/** More than one protocol plugin declared the same route. */
export class ProtocolRouteConflictError extends Error {
    override readonly name = "ProtocolRouteConflictError";

    constructor(message: string) {
        super(message);
    }
}

/** Registry for protocol adapters at the transport boundary. */
export class ProtocolRegistry implements ProtocolRouter {
    #plugins = new Map<string, ProtocolPlugin>();
    #routeOwners = new Map<string, string>();
    #routeDefinitions = new Map<string, PluginRoute>();

    register(plugin: ProtocolPlugin): void {
        validateProtocolPlugin(plugin);
        const id = plugin.manifest.id;
        if (this.#plugins.has(id)) {
            throw new TypeError(`protocol plugin already registered: ${id}`);
        }

        const routes = plugin.manifest.routes ?? [];
        const localKeys = new Set<string>();
        for (const route of routes) {
            const key = routeKey(route);
            if (localKeys.has(key)) {
                throw new ProtocolRouteError(
                    `protocol plugin ${id} declares ${key} more than once`,
                );
            }
            localKeys.add(key);
            const owner = this.#routeOwners.get(key);
            if (owner !== undefined) {
                throw new ProtocolRouteConflictError(
                    `protocol route ${route.method} ${route.path} is already owned by ${owner}`,
                );
            }
        }
        this.#plugins.set(id, plugin);
        for (const route of routes) {
            const key = routeKey(route);
            this.#routeOwners.set(key, id);
            this.#routeDefinitions.set(key, route);
        }
    }

    unregister(id: string): boolean {
        const removed = this.#plugins.delete(id);
        if (!removed) return false;
        for (const [key, owner] of this.#routeOwners) {
            if (owner === id) {
                this.#routeOwners.delete(key);
                this.#routeDefinitions.delete(key);
            }
        }
        return true;
    }

    get(id: string): ProtocolPlugin | undefined {
        return this.#plugins.get(id);
    }

    list(): readonly ProtocolPlugin[] {
        return [...this.#plugins.values()];
    }

    resolve(
        route: Pick<PluginRoute, "method" | "path">,
    ): ProtocolMatch | undefined {
        const key = routeKey(route);
        const owner = this.#routeOwners.get(key);
        if (owner === undefined) return undefined;
        const plugin = this.#plugins.get(owner);
        const declared = this.#routeDefinitions.get(key);
        if (plugin === undefined || declared === undefined) return undefined;
        return { plugin, route: declared };
    }
}

export function routeKey(route: Pick<PluginRoute, "method" | "path">): string {
    return `${route.method.toUpperCase()}\0${route.path}`;
}

function validateProtocolPlugin(plugin: ProtocolPlugin): void {
    if (plugin === null || typeof plugin !== "object") {
        throw new TypeError("protocol plugin must be an object");
    }
    const manifest = plugin.manifest;
    if (
        manifest === null || typeof manifest !== "object" ||
        manifest.kind !== "protocol"
    ) {
        throw new TypeError(
            `protocol plugin ${
                manifest?.id ?? "<unknown>"
            } must declare kind protocol`,
        );
    }
    if (typeof manifest.id !== "string" || manifest.id.trim().length === 0) {
        throw new TypeError("protocol plugin id is required");
    }
    if (
        typeof plugin.parse !== "function" ||
        typeof plugin.serialize !== "function"
    ) {
        throw new TypeError(`protocol plugin ${manifest.id} is incomplete`);
    }
    if (manifest.routes !== undefined && !Array.isArray(manifest.routes)) {
        throw new ProtocolRouteError(
            `protocol plugin ${manifest.id} routes must be an array`,
        );
    }
    const seen = new Set<string>();
    for (const route of manifest.routes ?? []) {
        if (
            route === null || typeof route !== "object" ||
            typeof route.method !== "string" ||
            typeof route.path !== "string" ||
            typeof route.operation !== "string" ||
            route.method.trim().length === 0 ||
            route.path.trim().length === 0 ||
            route.operation.trim().length === 0
        ) {
            throw new ProtocolRouteError(
                `invalid route in protocol plugin ${manifest.id}`,
            );
        }
        const key = routeKey(route);
        if (seen.has(key)) {
            throw new ProtocolRouteError(
                `protocol plugin ${manifest.id} declares ${key} more than once`,
            );
        }
        seen.add(key);
    }
}
