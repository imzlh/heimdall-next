import type { ListedSource } from "@heimdall/admin-contracts/console.ts";
import { readSourceCooldown } from "@heimdall/admin-contracts/source-health.ts";

export const SOURCE_RECOVERY_NOTE =
    "解除后仅恢复调度资格，不代表上游验证成功。";

const REASONS = {
    authentication: "上游认证失败，请检查凭据或授权",
    rate_limit: "上游限流，暂时降低调度优先级",
    upstream: "上游服务异常，暂时降低调度优先级",
    transport: "连接上游失败，请检查网络或代理",
    probe: "最近连接探测失败",
} as const;

export function cooldownRemaining(until: string, now: number): string {
    const seconds = Math.ceil((Date.parse(until) - now) / 1000);
    if (seconds <= 0) return "冷却时间已到，可刷新状态";
    if (seconds < 60) return `约 ${seconds} 秒后自动解除`;
    return `约 ${Math.ceil(seconds / 60)} 分钟后自动解除`;
}

/** Stable SSR deadline; the owning island supplies a clock for live remaining time. */
export function SourceHealthDetails(
    { source, now, onReset, pending = false, editing = false }: {
        source: ListedSource;
        now?: number;
        onReset?: () => void;
        pending?: boolean;
        editing?: boolean;
    },
) {
    const cooldown = readSourceCooldown(source.cooldown);
    if (source.health !== "cooldown" || !cooldown) return null;
    const deadline = cooldown.until.replace("T", " ").replace(
        /\.\d+Z$/,
        " UTC",
    );
    return (
        <div class="source-health-details">
            <strong>{REASONS[cooldown.reason]}</strong>
            <span>
                自动解除：<time datetime={cooldown.until}>{deadline}</time>
            </span>
            {now !== undefined && (
                <span class="source-health-remaining">
                    {cooldownRemaining(cooldown.until, now)}
                </span>
            )}
            {(onReset || editing) && source.enabled && (
                <>
                    <p>{SOURCE_RECOVERY_NOTE}</p>
                    <button
                        type="button"
                        class="button-secondary source-recovery-button"
                        disabled={pending || !onReset}
                        onClick={onReset}
                        title={onReset
                            ? SOURCE_RECOVERY_NOTE
                            : "交互加载后可用"}
                    >
                        解除冷却
                    </button>
                </>
            )}
        </div>
    );
}
