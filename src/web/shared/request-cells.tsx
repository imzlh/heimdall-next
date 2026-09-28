import type { UsageDto } from "@heimdall/admin-contracts";
import { Icon } from "./icons.tsx";
import { requestTimings } from "./activity-presentation.ts";

/** Deterministic thousands grouping so SSR and hydration render identically. */
function groupThousands(value: number): string {
    return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

interface RequestTokens {
    input: number;
    cached: number;
    write: number;
    output: number;
    estimated: boolean;
}

/** Per-row token counts, or null when nothing was recorded. */
export function requestTokens(
    row: { usage?: UsageDto | null },
): RequestTokens | null {
    const usage = row.usage;
    if (!usage) return null;
    const input = usage.inputTokens ?? 0;
    const cached = usage.cachedInputTokens ?? 0;
    const write = usage.cacheWriteTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    if (input + cached + write + output === 0) return null;
    const extensions = usage.extensions;
    const estimated = typeof extensions === "object" && extensions !== null &&
        (extensions as { estimated?: unknown }).estimated === true;
    return { input, cached, write, output, estimated };
}

/**
 * Two stacked rows — `↓ 34,001 R33,210 W601` above `↑ 422 ≈` — so the narrow
 * journal column stays scannable. Icons instead of text labels; the arrow
 * colors reuse the trend chart's code (accent = input, success = output).
 * Cache read/write badges follow the input count only when nonzero.
 */
export function TokenSummary({ row }: { row: { usage?: UsageDto | null } }) {
    const tokens = requestTokens(row);
    if (!tokens) return <span class="request-tokens is-empty">—</span>;
    return (
        <span
            class="request-tokens"
            title={tokens.estimated
                ? "根据文本估算，非上游实际计数"
                : undefined}
        >
            <span class="token-line token-in" title="输入 Token">
                <Icon name="arrow-down" size={13} class="token-icon" />
                {groupThousands(tokens.input)}
                {tokens.cached > 0 && (
                    <span class="token-cache">
                        R{groupThousands(tokens.cached)}
                    </span>
                )}
                {tokens.write > 0 && (
                    <span class="token-cache">
                        W{groupThousands(tokens.write)}
                    </span>
                )}
            </span>
            <span class="token-line token-out" title="输出 Token">
                <Icon name="arrow-up" size={13} class="token-icon" />
                {groupThousands(tokens.output)}
                {tokens.estimated && <span class="token-estimated">≈</span>}
            </span>
        </span>
    );
}

/**
 * Latency cell: `首字` + `全程` for a streamed turn, a single total for a
 * one-shot (non-SSE) turn. An em dash stands in until a duration exists.
 */
export function DurationSummary(
    { row }: {
        row: {
            receivedAt?: string;
            completedAt?: string;
            firstTokenAt?: string;
            streaming?: boolean;
        };
    },
) {
    const { firstToken, total } = requestTimings(row);
    if (firstToken === null) {
        return <span class="request-durations">{total ?? "—"}</span>;
    }
    return (
        <span class="request-durations">
            <span class="duration-first">
                <span class="duration-tag">首字</span> {firstToken}
            </span>
            <span class="duration-total">
                <span class="duration-tag">全程</span> {total ?? "—"}
            </span>
        </span>
    );
}
