/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useState } from "hono/jsx/dom";
import type { ConsoleSnapshot } from "@heimdall/admin-contracts/console.ts";
import {
    describeError,
    type JournalRequest,
    loadRequests,
    loadUsage,
    type UsageDay,
    type UsageSnapshot,
} from "./api/admin.ts";
import {
    requestReceivedTime,
    requestState,
} from "../shared/activity-presentation.ts";
import { DurationSummary, TokenSummary } from "../shared/request-cells.tsx";

export interface UsageSummaryData {
    usage: UsageSnapshot | null;
    days: UsageDay[];
    error: string;
}

/** Shared usage reader so the overview cards and the activity panel agree. */
export function useUsageData(
    revision: number,
    initial?: Pick<ConsoleSnapshot, "usage" | "errors">,
): UsageSummaryData {
    const [usage, setUsage] = useState<UsageSnapshot | null>(
        initial?.usage.usage ?? null,
    );
    const [days, setDays] = useState<UsageDay[]>(initial?.usage.days ?? []);
    const [error, setError] = useState(initial?.errors.usage ?? "");
    useEffect(() => {
        if (initial && revision === 0) return;
        let active = true;
        void loadUsage().then((result) => {
            if (!active) return;
            setUsage(result?.usage ?? null);
            setDays(Array.isArray(result?.days) ? result.days : []);
            setError("");
        }, (cause) => {
            if (!active) return;
            setUsage(null);
            setDays([]);
            setError(`用量读取失败：${describeError(cause)}`);
        });
        return () => {
            active = false;
        };
    }, [revision]);
    return { usage, days, error };
}

/** Recent request list shared by the activity panel and the model ranking. */
export function useRecentRequests(
    revision: number,
    initial?: Pick<ConsoleSnapshot, "requests" | "errors">,
): { requests: JournalRequest[]; error: string } {
    const [requests, setRequests] = useState<JournalRequest[]>(
        initial?.requests ?? [],
    );
    const [error, setError] = useState(initial?.errors.requests ?? "");
    useEffect(() => {
        if (initial && revision === 0) return;
        let active = true;
        void loadRequests({ limit: 20 }).then((result) => {
            if (!active) return;
            setRequests(
                Array.isArray(result?.requests) ? result.requests : [],
            );
            setError("");
        }, (cause) => {
            if (!active) return;
            setRequests([]);
            setError(`请求记录读取失败：${describeError(cause)}`);
        });
        return () => {
            active = false;
        };
    }, [revision]);
    return { requests, error };
}

export function ActivityPanel({ revision, initial }: {
    revision: number;
    initial?: Pick<ConsoleSnapshot, "requests" | "usage" | "errors">;
}) {
    const [requests, setRequests] = useState<JournalRequest[]>(
        initial?.requests ?? [],
    );
    const [requestError, setRequestError] = useState(
        initial?.errors.requests ?? "",
    );
    const [loading, setLoading] = useState(!initial);
    const { usage, days, error: usageError } = useUsageData(revision, initial);

    useEffect(() => {
        if (initial && revision === 0) return;
        let active = true;
        setLoading(true);
        setRequestError("");
        void loadRequests({ limit: 20 }).then((result) => {
            if (!active) return;
            setRequests(
                Array.isArray(result?.requests) ? result.requests : [],
            );
            setLoading(false);
        }, (cause) => {
            if (!active) return;
            setRequests([]);
            setRequestError(
                `请求记录读取失败：${describeError(cause)}`,
            );
            setLoading(false);
        });
        return () => {
            active = false;
        };
    }, [revision]);

    return (
        <section
            class="panel activity-panel"
            aria-labelledby="activity-title"
            aria-busy={loading ? "true" : "false"}
        >
            <div class="panel-heading">
                <div>
                    <h2 id="activity-title">最近请求</h2>
                    <p>
                        最近 20 条请求 ·{" "}
                        <a href="/admin?view=requests">查看全部</a>
                    </p>
                </div>
                <span class="status-chip chip-muted">
                    {usage
                        ? `${usage.totalTokens.toLocaleString("zh-CN")} tokens`
                        : "暂无用量"}
                </span>
            </div>
            {loading && <p role="status">正在读取用量与请求记录…</p>}
            {usageError && <p class="form-error" role="alert">{usageError}</p>}
            {days.length > 0
                ? (
                    <details class="usage-history">
                        <summary>每日用量 · {days.length} 天</summary>
                        <ul class="catalog-list">
                            {days.map((day) => (
                                <li class="catalog-row" key={day.day}>
                                    <strong>{day.day}</strong>
                                    <span>
                                        {day.totalTokens.toLocaleString(
                                            "zh-CN",
                                        )} tokens ·{" "}
                                        {day.requestCount.toLocaleString(
                                            "zh-CN",
                                        )} 次请求
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </details>
                )
                : null}
            {requestError && (
                <p class="form-error" role="alert">{requestError}</p>
            )}
            {requests.length > 0
                ? <RequestTableRows requests={requests} />
                : !loading && !requestError && (
                    <p class="empty-state">暂无请求记录。</p>
                )}
        </section>
    );
}

function RequestTableRows(
    { requests }: { requests: readonly JournalRequest[] },
) {
    return (
        <div class="table-wrap request-table-wrap">
            <table class="request-table">
                <thead>
                    <tr>
                        <th scope="col">时间 / 请求 ID</th>
                        <th scope="col">模型 / 操作</th>
                        <th scope="col">状态</th>
                        <th scope="col">耗时</th>
                        <th scope="col">Token</th>
                    </tr>
                </thead>
                <tbody>
                    {requests.map((request) => {
                        const state = requestState(request.status);
                        return (
                            <tr key={request.requestId}>
                                <td class="request-time">
                                    <time dateTime={request.receivedAt}>
                                        {requestReceivedTime(
                                            request.receivedAt,
                                        )}
                                    </time>
                                    <a
                                        class="request-id-inline"
                                        title={request.requestId}
                                        href={`/admin?view=requests&id=${
                                            encodeURIComponent(
                                                request.requestId ?? "",
                                            )
                                        }`}
                                    >
                                        {request.requestId}
                                    </a>
                                </td>
                                <td class="request-model">
                                    <strong title={request.model}>
                                        {request.model || "未指定模型"}
                                    </strong>
                                    <small>
                                        {request.operation || "未知操作"}
                                    </small>
                                </td>
                                <td class="request-state">
                                    <span
                                        class={`status-chip chip-${state.tone}`}
                                        title={request.status}
                                    >
                                        {state.label}
                                    </span>
                                </td>
                                <td class="request-duration">
                                    <DurationSummary row={request} />
                                </td>
                                <td class="request-tokens-cell">
                                    <TokenSummary row={request} />
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
