import type { SystemLogSnapshot } from "@heimdall/admin-contracts/console.ts";
import { SYSTEM_LOG_LEVELS } from "@heimdall/admin-contracts/system-log.ts";
import { SystemLogLedger } from "../shared/system-log-table.tsx";
import { systemLogLevel } from "../shared/system-log-data.ts";

/** Level pills as plain links keep filtering usable before the island loads. */
export function SystemLogSnapshotView(
    { snapshot }: { snapshot: SystemLogSnapshot },
) {
    const levels: (readonly [string, string])[] = [
        ["", "全部"],
        ...SYSTEM_LOG_LEVELS.map((level) =>
            [level, systemLogLevel(level).label] as const
        ),
    ];
    return (
        <section class="system-log-page" aria-label="系统日志">
            <nav class="system-log-levels" aria-label="日志级别">
                {levels.map(([value, label]) => {
                    const active = value === (snapshot.level ?? "");
                    return (
                        <a
                            key={value || "all"}
                            class={`system-log-level-chip${
                                active ? " is-active" : ""
                            }`}
                            aria-current={active ? "true" : undefined}
                            href={value === ""
                                ? "/admin?view=logs"
                                : `/admin?view=logs&logLevel=${value}`}
                        >
                            {label}
                        </a>
                    );
                })}
            </nav>
            {snapshot.error && (
                <p class="form-error" role="alert">{snapshot.error}</p>
            )}
            {snapshot.entries.length > 0
                ? <SystemLogLedger entries={snapshot.entries} />
                : !snapshot.error && (
                    <p class="empty-state">
                        暂无系统事件。管理操作与服务事件会显示在这里。
                    </p>
                )}
            <p class="system-log-note">
                系统日志保存在内存中，最多 {snapshot.capacity || "若干"}{" "}
                条，重启后清空。
                {snapshot.dropped > 0 &&
                    ` 已有 ${snapshot.dropped} 条更早的事件被滚动清除。`}
            </p>
        </section>
    );
}
