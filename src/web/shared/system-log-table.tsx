import type { SystemLogEntryDto } from "@heimdall/admin-contracts/system-log.ts";
import { requestReceivedTime } from "./activity-presentation.ts";
import { systemLogLevel } from "./system-log-data.ts";

/** One displayed row: the newest entry of a run plus how many repeats it hides. */
interface CollapsedRun {
    head: SystemLogEntryDto;
    count: number;
}

/**
 * Collapse consecutive identical events (same scope, level, message and
 * detail) into a single row; the tag then carries the repeat count. Repeats
 * are common for periodic work (health probes) and drown everything else.
 */
function collapseRuns(
    entries: readonly SystemLogEntryDto[],
): readonly CollapsedRun[] {
    const runs: CollapsedRun[] = [];
    for (const entry of entries) {
        const last = runs[runs.length - 1];
        if (
            last !== undefined &&
            last.head.scope === entry.scope &&
            last.head.level === entry.level &&
            last.head.message === entry.message &&
            last.head.detail === entry.detail
        ) {
            last.count += 1;
            continue;
        }
        runs.push({ head: entry, count: 1 });
    }
    return runs;
}

/**
 * The system log reads as an audit timeline: timestamps sit left of the axis,
 * one whole rail threads every level dot, and a fixed tag column keeps scope
 * labels aligned ahead of each message. Shared by SSR and the browser island
 * so both render identically.
 */
export function SystemLogLedger(
    { entries }: { entries: readonly SystemLogEntryDto[] },
) {
    return (
        <ol class="system-log-ledger">
            {collapseRuns(entries).map(({ head, count }) => {
                const level = systemLogLevel(head.level);
                return (
                    <li
                        key={head.seq}
                        class={`system-log-item system-log-level-${head.level}`}
                    >
                        <time class="system-log-time" dateTime={head.time}>
                            {requestReceivedTime(head.time)}
                        </time>
                        <div class="system-log-rail">
                            <span
                                class="system-log-dot"
                                role="img"
                                aria-label={level.label}
                            />
                        </div>
                        <span
                            class="system-log-scope"
                            title={count > 1 ? `连续 ${count} 条相同事件` : undefined}
                        >
                            {head.scope}
                            {count > 1 && (
                                <span class="system-log-scope-count">
                                    ×{count}
                                </span>
                            )}
                        </span>
                        <div class="system-log-body">
                            <p class="system-log-message">{head.message}</p>
                            {head.detail && (
                                <p class="system-log-detail">{head.detail}</p>
                            )}
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}
