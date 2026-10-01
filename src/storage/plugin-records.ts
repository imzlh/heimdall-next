import type {
    PluginArtifact,
    PluginRecord,
    PluginRecordStore,
} from "@heimdall/plugin-host";
import type { ConfigStore, StorageKeyPart } from "@heimdall/storage";
import { StorageConflictError } from "@heimdall/storage";

const CHUNK_BYTES = 48 * 1024;
const MAX_PACKAGE_BYTES = 1024 * 1024;
interface StoredPluginRecord extends PluginRecord {
    readonly artifact?: {
        readonly key: string;
        readonly chunks: number;
        readonly size: number;
        readonly entrypoint: string;
        readonly digest?: string;
        readonly signature?: Uint8Array;
        readonly signerKeyId?: string;
    };
}

function publicRecord(
    record: StoredPluginRecord,
    revision: string,
): PluginRecord {
    const { artifact: _artifact, ...metadata } = record;
    return { ...metadata, revision };
}

/** Durable PluginHost record store backed by the host's namespaced KV port. */
export class ConfigPluginRecordStore implements PluginRecordStore {
    readonly #store: ConfigStore;
    readonly #artifacts: ConfigStore;

    constructor(
        store: ConfigStore,
        namespace: readonly StorageKeyPart[] = ["heimdall", "plugins"],
    ) {
        this.#store = store.namespace(...namespace);
        this.#artifacts = store.namespace(...namespace, "artifacts");
    }

    async get(id: string): Promise<PluginRecord | undefined> {
        assertPluginId(id);
        const record = await this.#store.get<StoredPluginRecord>([id]);
        return record === null
            ? undefined
            : publicRecord(record.value, record.versionstamp);
    }

    async put(record: PluginRecord): Promise<void> {
        assertPluginId(record.manifest.id);
        const previous = await this.#store.get<StoredPluginRecord>([
            record.manifest.id,
        ]);
        if ((previous?.versionstamp ?? undefined) !== record.revision) {
            throw new StorageConflictError(
                "plugin record changed before lifecycle update",
            );
        }
        const { revision: _revision, ...metadata } = record;
        await this.#store.set([record.manifest.id], {
            ...metadata,
            ...(previous?.value.artifact === undefined
                ? {}
                : { artifact: previous.value.artifact }),
        }, { expectedVersionstamp: previous?.versionstamp ?? null });
    }

    async delete(id: string, expectedRevision?: string): Promise<void> {
        assertPluginId(id);
        const previous = await this.#store.get<StoredPluginRecord>([id]);
        if (
            expectedRevision !== undefined &&
            previous?.versionstamp !== expectedRevision
        ) {
            throw new StorageConflictError(
                "plugin record changed before uninstall",
            );
        }
        await this.#store.delete([id], previous?.versionstamp ?? null);
        // A concurrent reinstall may already have committed a different package.
        // Delete only the old immutable generation, never every package for this ID.
        if (previous?.value.artifact !== undefined) {
            await this.#cleanArtifacts(id, previous.value.artifact.key);
        }
    }

    async list(): Promise<readonly PluginRecord[]> {
        const records: PluginRecord[] = [];
        for await (const entry of this.#store.list<StoredPluginRecord>()) {
            if (entry.key.length !== 1) continue;
            const id = entry.value?.manifest?.id;
            if (typeof id !== "string") continue;
            try {
                assertPluginId(id);
            } catch {
                continue;
            }
            records.push(publicRecord(entry.value, entry.versionstamp));
        }
        return records.sort((left, right) =>
            left.manifest.id.localeCompare(right.manifest.id)
        );
    }

    async install(
        record: PluginRecord,
        artifact: PluginArtifact,
    ): Promise<void> {
        const id = record.manifest.id;
        assertPluginId(id);
        if (
            artifact.bytes === undefined || artifact.bytes.byteLength === 0 ||
            artifact.bytes.byteLength > MAX_PACKAGE_BYTES
        ) {
            throw new TypeError(
                "plugin package must contain 1 to 1048576 bytes",
            );
        }
        const key = crypto.randomUUID();
        const bytes = new Uint8Array(artifact.bytes);
        const chunks = Math.ceil(bytes.length / CHUNK_BYTES);
        try {
            for (let index = 0; index < chunks; index++) {
                await this.#artifacts.set(
                    [id, key, index],
                    bytes.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
                );
            }
            // The single record is the commit point. Readers never observe a partial package.
            await this.#store.set(
                [id],
                {
                    ...record,
                    artifact: {
                        key,
                        chunks,
                        size: bytes.length,
                        entrypoint: artifact.entrypoint,
                        ...(artifact.digest === undefined
                            ? {}
                            : { digest: artifact.digest }),
                        ...(artifact.signature === undefined
                            ? {}
                            : { signature: artifact.signature }),
                        ...(artifact.signerKeyId === undefined
                            ? {}
                            : { signerKeyId: artifact.signerKeyId }),
                    },
                } satisfies StoredPluginRecord,
                { expectedVersionstamp: null },
            );
        } catch (error) {
            await this.#cleanArtifacts(id, key);
            throw error;
        }
    }

    async readArtifact(id: string): Promise<PluginArtifact | undefined> {
        assertPluginId(id);
        const record = (await this.#store.get<StoredPluginRecord>([id]))?.value;
        const descriptor = record?.artifact;
        if (record === undefined || descriptor === undefined) return undefined;
        if (
            !Number.isSafeInteger(descriptor.size) || descriptor.size < 1 ||
            descriptor.size > MAX_PACKAGE_BYTES ||
            descriptor.chunks !== Math.ceil(descriptor.size / CHUNK_BYTES)
        ) {
            throw new TypeError("invalid persisted plugin package");
        }
        const bytes = new Uint8Array(descriptor.size);
        for (let index = 0; index < descriptor.chunks; index++) {
            const chunk = (await this.#artifacts.get<Uint8Array>([
                id,
                descriptor.key,
                index,
            ]))?.value;
            if (
                !(chunk instanceof Uint8Array) ||
                chunk.byteLength !==
                    Math.min(CHUNK_BYTES, descriptor.size - index * CHUNK_BYTES)
            ) {
                throw new TypeError("persisted plugin package is incomplete");
            }
            bytes.set(chunk, index * CHUNK_BYTES);
        }
        return {
            manifest: record.manifest,
            entrypoint: descriptor.entrypoint,
            bytes,
            digest: record.digest,
            signature: descriptor.signature,
            signerKeyId: descriptor.signerKeyId,
        };
    }

    async #cleanArtifacts(id: string, key?: string): Promise<void> {
        // A cleanup failure leaves unreachable bytes, never an enabled or partial install.
        try {
            for await (
                const entry of this.#artifacts.list(
                    key === undefined ? [id] : [id, key],
                )
            ) {
                await this.#artifacts.delete(entry.key);
            }
        } catch { /* Retryable housekeeping; metadata already committed. */ }
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
