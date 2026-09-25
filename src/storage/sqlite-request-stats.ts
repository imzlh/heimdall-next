import type { DatabaseSync } from "node:sqlite";
import type { ModelWindowStats, RequestWindowStats } from "@heimdall/storage";

/**
 * Aggregate queries over the request journal, bucketed by `received_at`.
 *
 * Every figure in a row describes the same population, the requests received
 * in the window, so counts and tokens stay comparable. The range predicate
 * uses the `requests_received` index and usage joins on its primary key.
 */
const AGGREGATES = `COUNT(*) AS request_count,
    COALESCE(SUM(r.status = 'completed'), 0) AS completed_count,
    COALESCE(SUM(r.status = 'error'), 0) AS failed_count,
    COALESCE(SUM(r.status = 'cancelled'), 0) AS cancelled_count,
    COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
    COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens,
    COALESCE(SUM(u.cached_input_tokens), 0) AS cached_input_tokens,
    COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
    COALESCE(SUM(u.total_tokens), 0) AS total_tokens`;

const WINDOW = `FROM requests r
    LEFT JOIN usage_records u ON u.request_id = r.request_id
    WHERE r.received_at >= ? AND r.received_at < ?`;

interface StatsRow {
    request_count: number;
    completed_count: number;
    failed_count: number;
    cancelled_count: number;
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    cached_input_tokens: number;
    cache_write_tokens: number;
    total_tokens: number;
}

interface ModelRow extends StatsRow {
    model: string | null;
}

export function queryWindowStats(
    db: DatabaseSync,
    from: string,
    until: string,
): RequestWindowStats {
    const row = db.prepare(`SELECT ${AGGREGATES} ${WINDOW}`).get(
        from,
        until,
    ) as unknown as StatsRow;
    return toStats(row);
}

export function queryModelStats(
    db: DatabaseSync,
    from: string,
    until: string,
    limit: number,
): ModelWindowStats[] {
    const rows = db.prepare(
        `SELECT r.model AS model, ${AGGREGATES} ${WINDOW}
         GROUP BY r.model
         ORDER BY request_count DESC, total_tokens DESC,
                  model IS NULL, model ASC
         LIMIT ?`,
    ).all(from, until, limit) as unknown as ModelRow[];
    return rows.map((row) => ({ model: row.model, ...toStats(row) }));
}

function toStats(row: StatsRow): RequestWindowStats {
    return {
        requestCount: row.request_count,
        completedCount: row.completed_count,
        failedCount: row.failed_count,
        cancelledCount: row.cancelled_count,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        reasoningTokens: row.reasoning_tokens,
        cachedInputTokens: row.cached_input_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        totalTokens: row.total_tokens,
    };
}
