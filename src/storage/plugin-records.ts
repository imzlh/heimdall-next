import type { PluginRecord, PluginRecordStore } from "@heimdall/plugin-host";
import type { ConfigStore, StorageKeyPart } from "@heimdall/storage";

/** Durable PluginHost record store backed by the host's namespaced KV port. */
export class ConfigPluginRecordStore implements PluginRecordStore {
    readonly #store: ConfigStore;

    constructor(
        store: ConfigStore,
        namespace: readonly StorageKeyPart[] = ["heimdall", "plugins"],
    ) {
        this.#store = store.namespace(...namespace);
    }

    async get(id: string): Promise<PluginRecord | undefined> {
        assertPluginId(id);
        return (await this.#store.get<PluginRecord>([id]))?.value;
    }

    async put(record: PluginRecord): Promise<void> {
        assertPluginId(record.manifest.id);
        await this.#store.set([record.manifest.id], record);
    }

    async delete(id: string): Promise<void> {
        assertPluginId(id);
        await this.#store.delete([id]);
    }

    async list(): Promise<readonly PluginRecord[]> {
        const records: PluginRecord[] = [];
        for await (const entry of this.#store.list<PluginRecord>()) {
            const id = entry.value?.manifest?.id;
            if (typeof id !== "string") continue;
            try {
                assertPluginId(id);
            } catch {
                continue;
            }
            records.push(entry.value);
        }
        return records.sort((left, right) =>
            left.manifest.id.localeCompare(right.manifest.id)
        );
    }
}

function assertPluginId(id: string): void {
    if (
        typeof id !== "string" || id.length === 0 || id.length > 128 ||
        id.includes("/") || id.includes("\\") || id.includes("..") ||
        id !== id.toLowerCase() ||
        ![...id].every((character) =>
            character >= "a" && character <= "z" ||
            character >= "0" && character <= "9" ||
            character === "." || character === "_" || character === "-"
        ) ||
        !isAlphaNumeric(id[0]!) || !isAlphaNumeric(id.at(-1)!)
    ) {
        throw new TypeError("invalid plugin id");
    }
}

function isAlphaNumeric(character: string): boolean {
    return character >= "a" && character <= "z" ||
        character >= "0" && character <= "9";
}
