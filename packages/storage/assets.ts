/** Runtime-neutral binary image repository. The core never receives a database. */
export interface ChatAssetRecord {
    readonly id: string;
    readonly mediaType: string;
    readonly size: number;
    readonly sha256: string;
    readonly createdAt: string;
    readonly name?: string;
}

export interface ChatAssetData {
    readonly asset: ChatAssetRecord;
    readonly bytes: Uint8Array;
}

export interface ChatAssetStore {
    /** Atomically deduplicate the media type + digest and persist bytes once. */
    put(
        asset: ChatAssetRecord,
        bytes: Uint8Array,
        lease?: { readonly id: string; readonly expiresAt: string },
    ): ChatAssetRecord;
    get(id: string): ChatAssetRecord | null;
    read(id: string): ChatAssetData | null;
    /** Host calls only after checking references across every conversation branch. */
    delete(id: string): void;
    /** Reusing an ID renews only that asset's lease; a different owner returns false. */
    createLease(assetId: string, leaseId: string, expiresAt: string): boolean;
    deleteLease(assetId: string, leaseId: string): boolean;
    markForReclaim(ids: readonly string[], now: string): void;
    clearReclaim(ids: readonly string[]): void;
    listReclaimable(now: string, limit: number): readonly string[];
    pruneExpiredLeases(now: string, limit: number): void;
    /** Atomic lease check prevents a reservation racing the final delete. */
    deleteIfUnleased(id: string, now: string): boolean;
    close(): void;
}
