import type { SourceRegistry } from "@heimdall/kernel";
import type { ConfigStore } from "@heimdall/storage";
import {
    readSourceCooldown,
    type SourceCooldown,
} from "@heimdall/contracts/source-health.ts";
import type { StoredSourceConfig } from "./source-records.ts";
import { log } from "../observability/system-log.ts";

interface PersistedSourceHealth {
    readonly configuration: string;
    readonly cooldown: SourceCooldown;
}

/** Cooldowns are host state and contain neither upstream errors nor request data. */
export class SourceHealthPersistence {
    readonly #scope: ConfigStore;
    readonly #configurations = new Map<string, string>();
    readonly #pending = new Map<string, Promise<void>>();
    readonly #failures = new Set<string>();
    #unsubscribe?: () => void;

    constructor(readonly store: ConfigStore, readonly sources: SourceRegistry) {
        this.#scope = store.namespace("heimdall", "source-health");
    }

    async bind(id: string, record: StoredSourceConfig): Promise<void> {
        // Configuration identity prevents an old cooldown being restored onto
        // new credentials, endpoints, plugin types or proxy routes after a crash.
        let json: string;
        try {
            json = JSON.stringify([
                record.sourcePluginId,
                record.config,
                record.proxy ?? null,
            ]);
        } catch {
            this.#configurations.delete(id);
            return;
        }
        const bytes = new TextEncoder().encode(json);
        const hash = new Uint8Array(
            await crypto.subtle.digest("SHA-256", bytes),
        );
        this.#configurations.set(
            id,
            Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(
                "",
            ),
        );
    }

    async restore(): Promise<void> {
        for await (
            const entry of this.store.namespace("heimdall", "source-config")
                .list<StoredSourceConfig>()
        ) {
            if (!entry.value.deleted) {
                await this.bind(String(entry.key.at(-1)), entry.value);
            }
        }
        for await (const entry of this.#scope.list<PersistedSourceHealth>()) {
            const id = String(entry.key.at(-1));
            const cooldown = readSourceCooldown(entry.value?.cooldown);
            if (
                this.sources.get(id) && cooldown &&
                entry.value.configuration === this.#configurations.get(id)
            ) {
                this.sources.restoreCooldown(id, cooldown);
                if (this.sources.healthSnapshot(id).health === "cooldown") {
                    continue;
                }
            }
            await this.#scope.delete([id], entry.versionstamp);
        }
        this.#unsubscribe = this.sources.subscribeHealth((id, cooldown) =>
            this.#enqueue(id, cooldown)
        );
    }

    #enqueue(id: string, cooldown?: SourceCooldown): void {
        const configuration = this.#configurations.get(id);
        // Embedders may register temporary sources that have no persistent record.
        if (!configuration) return;
        const previous = this.#pending.get(id) ?? Promise.resolve();
        const operation = previous.then(async () => {
            if (cooldown) {
                await this.#scope.set([id], { configuration, cooldown });
            } else await this.#scope.delete([id]);
            this.#failures.delete(id);
        }).catch(() => {
            if (!this.#failures.has(id)) {
                log.warn(
                    "source-health",
                    "渠道冷却状态保存失败，将在下次状态变化时重试。",
                );
            }
            this.#failures.add(id);
        });
        this.#pending.set(id, operation);
        void operation.finally(() => {
            if (this.#pending.get(id) === operation) this.#pending.delete(id);
        });
    }

    async flush(id?: string): Promise<void> {
        if (id !== undefined) {
            while (this.#pending.has(id)) await this.#pending.get(id);
            if (!this.#failures.has(id)) return;
        } else {
            while (this.#pending.size) {
                await Promise.all(this.#pending.values());
            }
            if (!this.#failures.size) return;
        }
        throw new Error("渠道冷却状态尚未持久化，请重试。");
    }

    async close(): Promise<void> {
        this.#unsubscribe?.();
        await this.flush();
    }
}
