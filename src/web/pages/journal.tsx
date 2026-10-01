import type { JournalSnapshot } from "@heimdall/admin-contracts/console.ts";
import { JournalTable } from "../shared/journal-table.tsx";
import { journalHref as href } from "../shared/journal-links.ts";
import { Icon } from "../shared/icons.tsx";
import {
    REQUEST_STATUSES,
    requestState,
} from "../shared/activity-presentation.ts";

function JsonSection(
    { title, value, open = false }: {
        title: string;
        value: unknown;
        open?: boolean;
    },
) {
    return (
        <details class="journal-json" open={open}>
            <summary>
                <Icon name="chevron-right" size={15} />
                {title}
            </summary>
            <pre
                tabIndex={0}
            >{value === undefined || value === null ? "暂无记录" : JSON.stringify(value, null, 2)}</pre>
        </details>
    );
}

/** Native forms, links and details remain usable before the island arrives. */
export function JournalSnapshotView(
    { snapshot }: { snapshot: JournalSnapshot },
) {
    const detail = snapshot.detail;
    return (
        <>
            <section class="panel journal-page" aria-labelledby="journal-title">
                <header class="panel-heading journal-heading">
                    <div>
                        <h2 id="journal-title">请求记录</h2>
                        <p>查找每一次调用，查看请求、响应与事件帧。</p>
                    </div>
                </header>
                <form
                    class="journal-filters"
                    role="search"
                    method="get"
                    action="/admin"
                >
                    <input type="hidden" name="view" value="requests" />
                    <label class="journal-search" for="journal-search">
                        <span class="sr-only">搜索请求</span>
                        <Icon name="search" size={17} />
                        <input
                            id="journal-search"
                            name="q"
                            type="search"
                            maxLength={200}
                            value={snapshot.q ?? ""}
                            placeholder="请求 ID、模型、操作或插件"
                        />
                        <button type="submit">搜索</button>
                    </label>
                    <input
                        type="hidden"
                        name="status"
                        value={snapshot.status ?? ""}
                    />
                    <nav class="journal-status-pills" aria-label="请求状态">
                        {["", ...REQUEST_STATUSES].map((value) => (
                            <a
                                class={`journal-status-pill${
                                    value === (snapshot.status ?? "")
                                        ? " is-active"
                                        : ""
                                }`}
                                aria-current={value === (snapshot.status ?? "")
                                    ? "true"
                                    : undefined}
                                href={href(snapshot, {
                                    status: value || null,
                                    cursor: null,
                                    id: null,
                                })}
                            >
                                {value ? requestState(value).label : "全部状态"}
                            </a>
                        ))}
                    </nav>
                    {(snapshot.q || snapshot.status) && (
                        <a class="secondary-button" href={href({})}>清除筛选</a>
                    )}
                </form>
                {snapshot.error && (
                    <p class="form-error" role="alert">{snapshot.error}</p>
                )}
                {snapshot.requests.length > 0
                    ? (
                        <JournalTable
                            requests={snapshot.requests}
                            selectedId={snapshot.selectedId}
                            location={snapshot}
                        />
                    )
                    : !snapshot.error && (
                        <p class="empty-state">没有符合条件的请求记录。</p>
                    )}
                <div class="journal-pagination">
                    <span>本页 {snapshot.requests.length} 条</span>
                    {snapshot.cursor && (
                        <a
                            class="secondary-button"
                            href={href(snapshot, { cursor: null, id: null })}
                        >
                            返回首屏
                        </a>
                    )}
                    {snapshot.nextCursor && (
                        <a
                            class="secondary-button"
                            href={href(snapshot, {
                                cursor: snapshot.nextCursor,
                                id: null,
                            })}
                        >
                            下一页
                        </a>
                    )}
                </div>
            </section>
            {snapshot.selectedId && (
                <section
                    class="panel journal-detail"
                    aria-labelledby="journal-detail-title"
                >
                    <div class="journal-detail-header">
                        <div class="journal-detail-heading">
                            <h2 id="journal-detail-title">请求详情</h2>
                            <code>{snapshot.selectedId}</code>
                        </div>
                        <div class="journal-detail-actions">
                            <a
                                class="secondary-button"
                                href={`/admin/ui/requests/export?id=${
                                    encodeURIComponent(snapshot.selectedId)
                                }`}
                                download
                            >
                                下载完整 JSON
                            </a>
                            <a
                                class="secondary-button"
                                href={href(snapshot, { id: null })}
                            >
                                关闭详情
                            </a>
                        </div>
                    </div>
                    {snapshot.detailError && (
                        <p class="form-error" role="alert">
                            {snapshot.detailError}
                        </p>
                    )}
                    {detail && (
                        <div class="journal-detail-content">
                            <div class="journal-payloads">
                                <JsonSection
                                    title="用量"
                                    value={detail.request.usage}
                                />
                                <JsonSection
                                    title="请求"
                                    value={detail.request.request}
                                    open
                                />
                                <JsonSection
                                    title="响应"
                                    value={detail.request.response}
                                />
                                <JsonSection
                                    title="错误"
                                    value={detail.request.error}
                                    open={detail.request.error !== undefined}
                                />
                                <JsonSection
                                    title="元数据"
                                    value={{
                                        ...detail.request,
                                        request: undefined,
                                        response: undefined,
                                        error: undefined,
                                        usage: undefined,
                                    }}
                                />
                            </div>
                            <section class="journal-frames" aria-label="事件帧">
                                <h3>事件帧 · 本页 {detail.frames.length} 条</h3>
                                {detail.frames.map((frame) => (
                                    <JsonSection
                                        key={frame.seq}
                                        title={`#${frame.seq} · ${frame.timestamp}`}
                                        value={frame}
                                    />
                                ))}
                                {detail.nextAfterSeq !== null && (
                                    <a
                                        class="secondary-button"
                                        href={href(snapshot, {
                                            afterSeq: String(
                                                detail.nextAfterSeq,
                                            ),
                                        })}
                                    >
                                        后续事件帧
                                    </a>
                                )}
                            </section>
                        </div>
                    )}
                </section>
            )}
        </>
    );
}
