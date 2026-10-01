import type { MaintenanceStatusView } from "@heimdall/admin-contracts/console.ts";

/** Stateless markup can be rendered before the settings island is available. */
export function MaintenanceStatus({ status }: {
    status?: MaintenanceStatusView;
}) {
    const label = !status
        ? "未配置自动清理"
        : status.running
        ? "正在清理"
        : status.lastError
        ? "上次清理失败"
        : status.enabled
        ? "自动清理已启用"
        : "仅回收闲置附件";
    const tone = status?.lastError
        ? "red"
        : status?.enabled
        ? "green"
        : "muted";
    return (
        <div class="maintenance-status" aria-label="自动清理状态">
            <div class="maintenance-heading">
                <h3>自动清理</h3>
                <span class={`status-chip chip-${tone}`} role="status">
                    {label}
                </span>
            </div>
            {status
                ? (
                    <>
                        {!status.enabled && (
                            <p class="field-help">
                                请求记录与对话永久保留，仍会定期回收没有引用且租约已到期的附件。
                            </p>
                        )}
                        <dl class="settings-summary maintenance-summary">
                            <dt>上次清理</dt>
                            <dd>
                                <MaintenanceTime
                                    value={status.lastRunAt}
                                    empty="尚未运行"
                                />
                            </dd>
                            <dt>下次清理</dt>
                            <dd>
                                <MaintenanceTime
                                    value={status.nextRunAt}
                                    empty={status.running
                                        ? "本次完成后安排"
                                        : status.enabled
                                        ? "等待安排"
                                        : "未安排"}
                                />
                            </dd>
                            <dt>上次清理数量</dt>
                            <dd class="maintenance-counts">
                                <span>{status.prunedRequests} 条请求记录</span>
                                <span>{status.prunedConversations} 个对话</span>
                                <span>{status.prunedAssets} 个附件</span>
                            </dd>
                        </dl>
                        {status.lastError && (
                            <p class="form-error" role="alert">
                                {status.lastError}
                            </p>
                        )}
                    </>
                )
                : (
                    <p class="field-help">
                        当前实例未提供清理任务状态。保留策略可保存，待自动清理服务启用后执行。
                    </p>
                )}
        </div>
    );
}

function MaintenanceTime({ value, empty }: {
    value: string | null;
    empty: string;
}) {
    if (!value) return <span>{empty}</span>;
    // Explicit UTC keeps SSR and the island identical across server time zones.
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return <span>{empty}</span>;
    return (
        <time dateTime={date.toISOString()}>
            {date.toISOString().slice(0, 19).replace("T", " ")} UTC
        </time>
    );
}
