import type {
    SourcePluginFactory,
    SourceProxySelection,
} from "@heimdall/contracts";
import type { SourceProxySummary } from "@heimdall/admin-contracts";
import type { ConfigStore } from "@heimdall/storage";
import {
    parseSourceProxySelection,
    type ProxyPoolHandle,
} from "./proxy-pool.ts";
import type { StoredSourceConfig } from "./source-records.ts";

/** Only configuration crosses this boundary; no network calls are intercepted. */
export class SourceProxyBindings {
    readonly #selections = new Map<string, SourceProxySelection>();

    constructor(readonly pool: ProxyPoolHandle) {}

    async restore(store: ConfigStore): Promise<void> {
        for await (
            const entry of store.namespace("heimdall", "source-config")
                .list<StoredSourceConfig>()
        ) {
            if (entry.value.deleted) continue;
            this.set(String(entry.key.at(-1)), entry.value.proxy);
        }
    }

    /** Called after the corresponding durable source write succeeds. */
    set(sourceId: string, selection?: SourceProxySelection): void {
        this.#selections.set(sourceId, parseSourceProxySelection(selection));
    }

    delete(sourceId: string): void {
        this.#selections.delete(sourceId);
    }

    summary(selection?: SourceProxySelection): SourceProxySummary {
        const resolved = this.pool.resolve(selection);
        if (resolved.mode === "proxy") {
            return {
                mode: "proxy",
                selectedBy: resolved.selectedBy,
                proxyId: resolved.proxy.id,
                name: resolved.proxy.name,
            };
        }
        return resolved;
    }

    wrap(factory: SourcePluginFactory): SourcePluginFactory {
        return {
            ...factory,
            create: (config, options) => {
                let id = typeof config === "object" && config !== null &&
                        "id" in config && typeof config.id === "string"
                    ? config.id
                    : "";
                const source = factory.create(config, {
                    ...options,
                    // A getter keeps both pool edits and per-source edits live,
                    // without discarding plugin-owned sessions or hot contexts.
                    getProxy: options?.getProxy ??
                        (() => this.pool.resolve(this.#selections.get(id))),
                });
                id = source.id;
                return source;
            },
        };
    }
}
