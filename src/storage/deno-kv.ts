import type {
    ConfigStore,
    StorageKey,
    StorageKeyPart,
    StoredEntry,
    VersionedValue,
    WriteOptions,
} from "@heimdall/storage";
import { StorageConflictError } from "@heimdall/storage";

/**
 * Deno KV adapter for the runtime-neutral configuration port.
 *
 * The adapter keeps the namespace in the key itself so independent server
 * capabilities can share one KV file without seeing each other's records.
 */
export class DenoKvConfigStore implements ConfigStore {
    readonly #kv: Deno.Kv;
    readonly #prefix: readonly StorageKeyPart[];

    constructor(kv: Deno.Kv, prefix: readonly StorageKeyPart[] = []) {
        this.#kv = kv;
        this.#prefix = [...prefix];
    }

    namespace(...path: StorageKeyPart[]): ConfigStore {
        return new DenoKvConfigStore(this.#kv, [
            ...this.#prefix,
            ...path,
        ]);
    }

    async get<T = unknown>(
        path: StorageKey = [],
    ): Promise<VersionedValue<T> | null> {
        const entry = await this.#kv.get<T>(this.key(path));
        if (entry.value === null) return null;
        return {
            value: entry.value,
            versionstamp: entry.versionstamp ?? "",
        };
    }

    async set<T>(
        path: StorageKey,
        value: T,
        options: WriteOptions = {},
    ): Promise<string> {
        const key = this.key(path);
        const operation = this.#kv.atomic();
        if (options.expectedVersionstamp !== undefined) {
            if (typeof options.expectedVersionstamp === "string") {
                const current = await this.#kv.get(key);
                if (current.versionstamp !== options.expectedVersionstamp) {
                    throw new StorageConflictError(
                        `configuration changed while writing ${path.join("/")}`,
                    );
                }
            }
            operation.check({
                key,
                versionstamp: options.expectedVersionstamp,
            });
        }
        operation.set(
            key,
            value,
            options.expireIn === undefined
                ? undefined
                : { expireIn: options.expireIn },
        );
        const result = await operation.commit();
        if (!result.ok) {
            throw new StorageConflictError(
                `configuration changed while writing ${path.join("/")}`,
            );
        }
        return result.versionstamp;
    }

    async delete(
        path: StorageKey,
        expectedVersionstamp?: string | null,
    ): Promise<void> {
        const key = this.key(path);
        if (expectedVersionstamp === undefined) {
            await this.#kv.delete(key);
            return;
        }
        if (typeof expectedVersionstamp === "string") {
            const current = await this.#kv.get(key);
            if (current.versionstamp !== expectedVersionstamp) {
                throw new StorageConflictError(
                    `configuration changed while deleting ${path.join("/")}`,
                );
            }
        }
        const result = await this.#kv.atomic()
            .check({ key, versionstamp: expectedVersionstamp })
            .delete(key)
            .commit();
        if (!result.ok) {
            throw new StorageConflictError(
                `configuration changed while deleting ${path.join("/")}`,
            );
        }
    }

    async *list<T = unknown>(
        path: StorageKey = [],
    ): AsyncIterable<StoredEntry<T>> {
        const prefix = this.key(path);
        for await (const entry of this.#kv.list<T>({ prefix })) {
            yield {
                key: entry.key.slice(
                    this.#prefix.length,
                ) as unknown as StorageKey,
                value: entry.value,
                versionstamp: entry.versionstamp ?? "",
            };
        }
    }

    #key(path: StorageKey): Deno.KvKey {
        return [...this.#prefix, ...path];
    }

    private key(path: StorageKey): Deno.KvKey {
        return this.#key(path);
    }
}
