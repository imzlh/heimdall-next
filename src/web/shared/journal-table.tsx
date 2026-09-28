import type { RequestSummaryDto } from "@heimdall/admin-contracts";
import { requestState } from "./activity-presentation.ts";
import { TokenSummary } from "./request-cells.tsx";
import { journalHref, type JournalLocation } from "./journal-links.ts";

export function requestDuration(request: RequestSummaryDto): string {
    if (!request.completedAt) return "—";
    const elapsed = Date.parse(request.completedAt) -
        Date.parse(request.receivedAt);
    if (!Number.isFinite(elapsed) || elapsed < 0) return "—";
    return elapsed < 1000
        ? `${elapsed} ms`
        : `${(elapsed / 1000).toFixed(2)} s`;
}

/** UTC keeps the SSR and browser's first render identical across time zones. */
export function journalTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? value
        : date.toISOString().replace("T", " ").slice(0, 19);
}

function TokenCell({ request }: { request: RequestSummaryDto }) {
    return (
        <td class="request-tokens">
            <TokenSummary row={request} />
        </td>
    );
}

export function JournalTable(
    { requests, selectedId, onSelect, location = {} }: {
        requests: readonly RequestSummaryDto[];
        selectedId?: string;
        onSelect?: (id: string) => void;
        location?: JournalLocation;
    },
) {
    return (
        <div class="table-wrap request-table-wrap">
            <table class="request-table journal-table">
                <caption class="sr-only">请求记录，时间使用 UTC</caption>
                <thead>
                    <tr>
                        <th scope="col">
                            接收时间 <small>UTC</small>
                        </th>
                        <th scope="col">模型 / 操作</th>
                        <th scope="col">状态</th>
                        <th scope="col">耗时</th>
                        <th scope="col">Token</th>
                        <th scope="col">请求 ID</th>
                    </tr>
                </thead>
                <tbody>
                    {requests.map((request) => {
                        const state = requestState(request.status);
                        return (
                            <tr
                                key={request.requestId}
                                class={selectedId === request.requestId
                                    ? "selected"
                                    : undefined}
                            >
                                <td class="request-time">
                                    <time dateTime={request.receivedAt}>
                                        {journalTime(request.receivedAt)}
                                    </time>
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
                                    >
                                        {state.label}
                                    </span>
                                </td>
                                <td>{requestDuration(request)}</td>
                                <TokenCell request={request} />
                                <td class="request-id">
                                    <a
                                        class="journal-request-link"
                                        href={journalHref(location, {
                                            id: request.requestId,
                                        })}
                                        aria-label={`查看请求 ${request.requestId}`}
                                        onClick={onSelect
                                            ? (event: MouseEvent) => {
                                                if (
                                                    event.button !== 0 ||
                                                    event.ctrlKey ||
                                                    event.metaKey ||
                                                    event.shiftKey ||
                                                    event.altKey
                                                ) return;
                                                event.preventDefault();
                                                onSelect(request.requestId);
                                            }
                                            : undefined}
                                    >
                                        <code title={request.requestId}>
                                            {request.requestId}
                                        </code>
                                    </a>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
