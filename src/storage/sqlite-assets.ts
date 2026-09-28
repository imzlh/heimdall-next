import type {
    ChatAssetData,
    ChatAssetRecord,
    ChatAssetStore,
} from "@heimdall/storage";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS image_assets (
    id TEXT PRIMARY KEY,
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    name TEXT,
    bytes BLOB NOT NULL,
    UNIQUE(media_type, sha256)
);
CREATE TABLE IF NOT EXISTS image_asset_leases (
    id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, expires_at TEXT NOT NULL,
    FOREIGN KEY(asset_id) REFERENCES image_assets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS image_asset_leases_asset_expiry ON image_asset_leases(asset_id, expires_at);
CREATE INDEX IF NOT EXISTS image_asset_leases_expiry ON image_asset_leases(expires_at);
CREATE TABLE IF NOT EXISTS image_asset_reclaim (
    asset_id TEXT PRIMARY KEY, requested_at TEXT NOT NULL,
    FOREIGN KEY(asset_id) REFERENCES image_assets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS image_asset_reclaim_requested ON image_asset_reclaim(requested_at, asset_id);
`;
const COLUMNS = "id, media_type, size, sha256, created_at, name";

interface AssetRow {
    id: string;
    media_type: string;
    size: number;
    sha256: string;
    created_at: string;
    name: string | null;
    bytes?: Uint8Array;
}

/** Separate asset database keeps binary payloads out of history scans and DTOs. */
export class SqliteChatAssetStore implements ChatAssetStore {
    #closed = false;
    constructor(readonly db: DatabaseSync) {}

    put(
        asset: ChatAssetRecord,
        bytes: Uint8Array,
        lease?: { readonly id: string; readonly expiresAt: string },
    ): ChatAssetRecord {
        this.#alive();
        if (asset.size !== bytes.byteLength || asset.size < 1) {
            throw new TypeError("asset byte size does not match its metadata");
        }
        return this.#transaction(() => {
            this.db.prepare(
                `INSERT INTO image_assets (${COLUMNS}, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(media_type, sha256) DO NOTHING`,
            ).run(
                asset.id,
                asset.mediaType,
                asset.size,
                asset.sha256,
                asset.createdAt,
                asset.name ?? null,
                bytes,
            );
            const row = this.db.prepare(
                `SELECT ${COLUMNS} FROM image_assets WHERE media_type = ? AND sha256 = ?`,
            ).get(asset.mediaType, asset.sha256) as unknown as AssetRow;
            const stored = toRecord(row);
            if (
                lease &&
                !this.#insertLease(stored.id, lease.id, lease.expiresAt)
            ) {
                throw new TypeError("asset lease id is already in use");
            }
            return stored;
        });
    }

    get(id: string): ChatAssetRecord | null {
        this.#alive();
        const row = this.db.prepare(
            `SELECT ${COLUMNS} FROM image_assets WHERE id = ?`,
        )
            .get(id) as AssetRow | undefined;
        return row ? toRecord(row) : null;
    }

    read(id: string): ChatAssetData | null {
        this.#alive();
        const row = this.db.prepare(
            `SELECT ${COLUMNS}, bytes FROM image_assets WHERE id = ?`,
        )
            .get(id) as AssetRow | undefined;
        return row ? { asset: toRecord(row), bytes: row.bytes! } : null;
    }

    delete(id: string): void {
        this.#alive();
        this.db.prepare("DELETE FROM image_assets WHERE id = ?").run(id);
    }

    createLease(assetId: string, leaseId: string, expiresAt: string): boolean {
        return this.#transaction(() =>
            this.#insertLease(assetId, leaseId, expiresAt)
        );
    }

    #insertLease(assetId: string, leaseId: string, expiresAt: string): boolean {
        const result = this.db.prepare(
            `INSERT INTO image_asset_leases(id, asset_id, expires_at) VALUES(?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET expires_at = MAX(expires_at, excluded.expires_at)
            WHERE asset_id = excluded.asset_id`,
        ).run(leaseId, assetId, expiresAt);
        if (Number(result.changes) === 0) return false;
        // Every upload is a future cleanup candidate even when it is never sent.
        this.markForReclaim([assetId], expiresAt);
        return true;
    }

    deleteLease(assetId: string, leaseId: string): boolean {
        this.#alive();
        const result = this.db.prepare(
            "DELETE FROM image_asset_leases WHERE id = ? AND asset_id = ?",
        ).run(leaseId, assetId);
        return Number(result.changes) > 0;
    }

    markForReclaim(ids: readonly string[], now: string): void {
        this.#alive();
        const statement = this.db.prepare(
            `INSERT INTO image_asset_reclaim(asset_id, requested_at)
            SELECT id, ? FROM image_assets WHERE id = ? ON CONFLICT(asset_id) DO NOTHING`,
        );
        for (const id of new Set(ids)) statement.run(now, id);
    }

    clearReclaim(ids: readonly string[]): void {
        this.#alive();
        const statement = this.db.prepare(
            "DELETE FROM image_asset_reclaim WHERE asset_id = ?",
        );
        for (const id of ids) statement.run(id);
    }

    listReclaimable(now: string, limit: number): readonly string[] {
        this.#alive();
        return (this.db.prepare(`SELECT r.asset_id FROM image_asset_reclaim r
            WHERE NOT EXISTS(SELECT 1 FROM image_asset_leases l WHERE l.asset_id = r.asset_id AND l.expires_at > ?)
            ORDER BY r.requested_at, r.asset_id LIMIT ?`).all(
            now,
            Math.max(1, Math.min(100, limit)),
        ) as { asset_id: string }[]).map((row) => row.asset_id);
    }

    pruneExpiredLeases(now: string, limit: number): void {
        this.#alive();
        this.db.prepare(`DELETE FROM image_asset_leases WHERE id IN (
            SELECT id FROM image_asset_leases WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
        )`).run(now, Math.max(1, Math.min(100, limit)));
    }

    deleteIfUnleased(id: string, now: string): boolean {
        this.#alive();
        const result = this.db.prepare(
            `DELETE FROM image_assets WHERE id = ? AND NOT EXISTS (
            SELECT 1 FROM image_asset_leases WHERE asset_id = ? AND expires_at > ?
        )`,
        ).run(id, id, now);
        return Number(result.changes) > 0;
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.db.close();
    }

    #alive(): void {
        if (this.#closed) throw new Error("chat asset store is closed");
    }

    #transaction<T>(operation: () => T): T {
        this.#alive();
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = operation();
            this.db.exec("COMMIT");
            return result;
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
}

export function openSqliteChatAssetStore(path: string): SqliteChatAssetStore {
    const file = path.trim();
    if (!file) throw new TypeError("chat asset store path is required");
    const slash = file.replaceAll("\\", "/").lastIndexOf("/");
    if (slash > 0) Deno.mkdirSync(file.slice(0, slash), { recursive: true });
    const db = new DatabaseSync(file);
    try {
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA busy_timeout = 5000");
        db.exec("PRAGMA foreign_keys = ON");
        db.exec(SCHEMA);
        return new SqliteChatAssetStore(db);
    } catch (error) {
        db.close();
        throw error;
    }
}

function toRecord(row: AssetRow): ChatAssetRecord {
    return {
        id: row.id,
        mediaType: row.media_type,
        size: row.size,
        sha256: row.sha256,
        createdAt: row.created_at,
        ...(row.name ? { name: row.name } : {}),
    };
}
