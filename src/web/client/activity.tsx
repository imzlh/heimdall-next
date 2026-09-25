/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx/dom */
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

export function ActivityPanel({ revision, initial }: {
    revision: number;
    initial?: Pick<ConsoleSnapshot, "requests" | "usage" | "errors">;
}) {
    const [requests, setRequests] = useState<JournalRequest[]>(
        initial?.requests ?? [],
    );
    const [usage, setUsage] = useState<UsageSnapshot | null>(
        initial?.usage.usage ?? null,
    );
    const [days, setDays] = useState<UsageDay[]>(initial?.usage.days ?? []);
    const [requestError, setRequestError] = useState(
        initial?.errors.requests ?? "",
    );
    const [usageError, setUsageError] = useState(initial?.errors.usage ?? "");
    const [loading, setLoading] = useState(!initial);

    useEffect(() => {
        if (initial && revision === 0) return;
        let active = true;
        setLoading(true);
        setRequestError("");
        setUsageError("");
        void Promise.allSettled([loadRequests({ limit: 20 }), loadUsage()])
            .then(([requestResult, usageResult]) => {
                if (!active) return;
                if (requestResult.status === "fulfilled") {
                    setRequests(
                        Array.isArray(requestResult.value?.requests)
                            ? requestResult.value.requests
                            : [],
                    );
                } else {
                    setRequests([]);
                    setRequestError(
                        `请求记录读取失败：${
                            describeError(requestResult.reason)
                        }`,
                    );
                }
                if (usageResult.status === "fulfilled") {
                    setUsage(usageResult.value?.usage ?? null);
                    setDays(
                        Array.isArray(usageResult.value?.days)
                            ? usageResult.value.days
                            : [],
                    );
                } else {
                    setUsage(null);
                    setDays([]);
                    setUsageError(
                        `用量读取失败：${describeError(usageResult.reason)}`,
                    );
                }
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
                    <h2 id="activity-title">用量与最近请求</h2>
                    <p>最近 20 条请求</p>
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
                ? (
                    <div class="table-wrap request-table-wrap">
                        <table class="request-table">
                            <caption class="sr-only">最近 20 条请求</caption>
                            <thead>
                                <tr>
                                    <th scope="col">
                                        接收时间 <small>UTC</small>
                                    </th>
                                    <th scope="col">模型 / 操作</th>
                                    <th scope="col">状态</th>
                                    <th scope="col">请求 ID</th>
                                </tr>
                            </thead>
                            <tbody>
                                {requests.map((request) => {
                                    const state = requestState(request.status);
                                    return (
                                        <tr key={request.requestId}>
                                            <td class="request-time">
                                                <time
                                                    dateTime={request
                                                        .receivedAt}
                                                >
                                                    {requestReceivedTime(
                                                        request.receivedAt,
                                                    )}
                                                </time>
                                            </td>
                                            <td class="request-model">
                                                <strong title={request.model}>
                                                    {request.model ||
                                                        "未指定模型"}
                                                </strong>
                                                <small>
                                                    {request.operation ||
                                                        "未知操作"}
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
                                            <td class="request-id">
                                                <code title={request.requestId}>
                                                    {request.requestId}
                                                </code>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )
                : !loading && !requestError && (
                    <p class="empty-state">暂无请求记录。</p>
                )}
        </section>
    );
}
