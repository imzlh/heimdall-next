import type { ChatStore, ConversationRecord } from "@heimdall/storage";
import type { ChatAssetService } from "../chat/assets.ts";
import { isConversationRunning } from "../chat/runs.ts";

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

/** Query only a bounded set of expired conversations; the ordinary sidebar is capped. */
export interface RetentionChatStore extends ChatStore {
    listConversationsOlderThan(
        before: string,
        limit: number,
        after?: { readonly updatedAt: string; readonly id: string },
    ): readonly ConversationRecord[];
}

export interface RetentionSweepResult {
    prunedRequests: number;
    prunedConversations: number;
    prunedAssets: number;
    errors: string[];
}

/** A bounded synchronous pass cannot interleave with conversation command acquisition. */
export function runRetentionSweep(options: {
    readonly requests: PrunableJournal;
    readonly chat: RetentionChatStore;
    readonly assets: Pick<ChatAssetService, "queueReclaim" | "sweep">;
    readonly requestRetentionDays: number;
    readonly chatRetentionDays: number;
    readonly now?: () => Date;
    readonly maxRequests?: number;
    readonly maxConversations?: number;
}): RetentionSweepResult {
    const result: RetentionSweepResult = {
        prunedRequests: 0,
        prunedConversations: 0,
        prunedAssets: 0,
        errors: [],
    };
    const now = options.now?.() ?? new Date();
    const requestBudget = options.maxRequests ?? DEFAULT_MAX_DELETES_PER_SWEEP;
    const chatBudget = options.maxConversations ?? 100;
    if (
        !Number.isInteger(requestBudget) || requestBudget < 1 ||
        !Number.isInteger(chatBudget) || chatBudget < 1
    ) {
        throw new TypeError("retention budgets must be positive integers");
    }
    if (options.requestRetentionDays > 0) {
        const before = new Date(
            now.getTime() - options.requestRetentionDays * DAY_MS,
        ).toISOString();
        try {
            while (result.prunedRequests < requestBudget) {
                const batch = options.requests.pruneOlderThan(
                    before,
                    Math.min(
                        DEFAULT_PRUNE_BATCH,
                        requestBudget - result.prunedRequests,
                    ),
                );
                result.prunedRequests += batch.deleted;
                if (batch.done || batch.deleted === 0) break;
            }
        } catch {
            result.errors.push("请求记录清理失败");
        }
    }
    if (options.chatRetentionDays > 0) {
        const before = new Date(
            now.getTime() - options.chatRetentionDays * DAY_MS,
        ).toISOString();
        let examined = 0;
        let after: { updatedAt: string; id: string } | undefined;
        try {
            while (examined < chatBudget) {
                const take = Math.min(25, chatBudget - examined);
                const candidates = options.chat.listConversationsOlderThan(
                    before,
                    take,
                    after,
                );
                for (const candidate of candidates) {
                    examined++;
                    after = candidate;
                    if (isConversationRunning(options.chat, candidate.id)) {
                        continue;
                    }
                    const current = options.chat.getConversation(candidate.id);
                    if (!current || current.updatedAt >= before) continue;
                    // The durable reclaim queue is written first. Sweep rechecks all
                    // branches, forks, and active upload leases before deleting bytes.
                    options.assets.queueReclaim(
                        options.chat.assetIdsForConversation(candidate.id),
                    );
                    options.chat.deleteConversation(candidate.id);
                    result.prunedConversations++;
                }
                if (candidates.length < take) break;
            }
        } catch {
            result.errors.push("对话清理失败");
        }
    }
    try {
        // sweep has its own 100-asset/100-expired-lease bound. Orphaned uploads
        // are reclaimable independently of whether history retention is enabled.
        result.prunedAssets = options.assets.sweep(options.chat);
    } catch {
        result.errors.push("附件回收失败");
    }
    return result;
}

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
export function readRetentionDays(
    value: string | undefined,
    name = "HEIMDALL_REQUEST_RETENTION_DAYS",
): number {
    if (value === undefined || value.trim().length === 0) return 0;
    const days = Number(value);
    if (!Number.isInteger(days) || days < 0 || days > 3650) {
        throw new RangeError(
            `${name} must be an integer from 0 to 3650`,
        );
    }
    return days;
}
