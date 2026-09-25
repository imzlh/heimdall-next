/** Storage value shapes shared by server components and plugins. */

export type StorageKeyPart = string | number | bigint | boolean | Uint8Array;
export type StorageKey = readonly StorageKeyPart[];

export interface VersionedValue<T> {
    readonly value: T;
    readonly versionstamp: string;
}

export interface WriteOptions {
    readonly expectedVersionstamp?: string | null;
    readonly expireIn?: number;
}

export interface StoredEntry<T> extends VersionedValue<T> {
    readonly key: StorageKey;
}

export interface PluginRuntimeState {
    readonly enabled: boolean;
    readonly version?: string;
    readonly digest?: string;
    readonly signerKeyId?: string;
    readonly updatedAt: string;
    readonly lastError?: string;
}
