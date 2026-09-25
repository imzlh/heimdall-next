/**
 * Background retention maintenance for the request journal. The journal grows
 * with every /v1 request (a record plus its frames and usage), and nothing
 * reclaims it, so a long-lived instance would grow without bound. This prunes
 * records older than a retention window in bounded batches. Following the
 * project's "off until asked for" stance on destructive background work,
 * retention is disabled (0 days) unless the operator opts in.
 */

/** The journal capability maintenance needs; the SQLite store implements it. */
export interface PrunableJournal {
    pruneOlderThan(
        before: string,
        maxDeletes: number,
    ): { deleted: number; done: boolean };
}

export interface MaintenanceOptions {
    /** Records older than this many days are eligible. 0 disables pruning. */
    readonly retentionDays: number;
    /** Upper bound on deletions per sweep so one pass cannot stall the process. */
    readonly maxDeletesPerSweep?: number;
    /** Rows deleted per DELETE batch inside a sweep. */
    readonly batchSize?: number;
    readonly now?: () => Date;
}

export interface MaintenanceResult {
    readonly prunedRequests: number;
}

const DAY_MS = 86_400_000;
export const DEFAULT_MAX_DELETES_PER_SWEEP = 5_000;
export const DEFAULT_PRUNE_BATCH = 500;
/** How often the executable runs a sweep while retention is enabled. */
export const MAINTENANCE_INTERVAL_MS = 3_600_000;

export function runMaintenance(
    journal: PrunableJournal,
    options: MaintenanceOptions,
): MaintenanceResult {
    const retentionDays = options.retentionDays;
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
        return { prunedRequests: 0 };
    }
    const now = options.now ?? (() => new Date());
    const before = new Date(now().getTime() - retentionDays * DAY_MS)
        .toISOString();
    const budget = options.maxDeletesPerSweep ?? DEFAULT_MAX_DELETES_PER_SWEEP;
    const batch = options.batchSize ?? DEFAULT_PRUNE_BATCH;
    let deleted = 0;
    while (deleted < budget) {
        const take = Math.min(batch, budget - deleted);
        const result = journal.pruneOlderThan(before, take);
        deleted += result.deleted;
        if (result.done || result.deleted === 0) break;
    }
    return { prunedRequests: deleted };
}

/** Parse HEIMDALL_REQUEST_RETENTION_DAYS. Empty or absent means 0 (disabled). */
export function readRetentionDays(value: string | undefined): number {
    if (value === undefined || value.trim().length === 0) return 0;
    const days = Number(value);
    if (!Number.isInteger(days) || days < 0 || days > 3650) {
        throw new RangeError(
            "HEIMDALL_REQUEST_RETENTION_DAYS must be an integer from 0 to 3650",
        );
    }
    return days;
}
