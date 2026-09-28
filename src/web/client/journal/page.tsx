/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import type { RequestStatusDto } from "@heimdall/admin-contracts";
import { Icon } from "../../shared/icons.tsx";
import { JournalTable } from "../../shared/journal-table.tsx";
import { requestState } from "../../shared/activity-presentation.ts";
import { controlValue } from "../dom.ts";
import { createJournalController } from "./controller.ts";
import type { JournalInitial } from "./types.ts";
import { JournalDetailDrawer } from "./detail.tsx";

const statuses: RequestStatusDto[] = [
    "pending",
    "running",
    "completed",
    "error",
    "cancelled",
];

export function RequestJournalPage({ revision, initial }: {
    revision: number;
    initial?: JournalInitial;
}) {
    const reference = useRef<ReturnType<typeof createJournalController> | null>(
        null,
    );
    if (!reference.current) {
        reference.current = createJournalController({ initial });
    }
    const controller = reference.current;
    const [state, setState] = useState(controller.getState());
    const [search, setSearch] = useState(state.q);
    const previousRevision = useRef(revision);

    useEffect(() => {
        const unsubscribe = controller.subscribe(setState);
        const visibility = () =>
            controller.setVisible(document.visibilityState !== "hidden");
        visibility();
        controller.start();
        setState(controller.getState());
        document.addEventListener("visibilitychange", visibility);
        const timer = setInterval(
            () => void controller.tickAutoRefresh(),
            15_000,
        );
        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", visibility);
            unsubscribe();
            controller.dispose();
        };
    }, [controller]);

    useEffect(() => {
        if (previousRevision.current === revision) return;
        previousRevision.current = revision;
        void controller.refresh();
    }, [revision, controller]);

    return (
        <section class="panel journal-page" aria-labelledby="journal-title">
            <header class="panel-heading journal-heading">
                <div>
                    <h2 id="journal-title">请求记录</h2>
                    <p>查找每一次调用，查看请求、响应与事件帧。</p>
                </div>
                <button
                    class="journal-refresh"
                    type="button"
                    disabled={state.loading}
                    onClick={() => void controller.refresh()}
                >
                    <Icon
                        name={state.loading ? "spinner" : "refresh"}
                        size={16}
                    />
                    {state.loading ? "正在刷新…" : "刷新"}
                </button>
            </header>
            <form
                class="journal-filters"
                role="search"
                method="get"
                action="/admin"
                onSubmit={(event) => {
                    event.preventDefault();
                    void controller.filter(search, state.status);
                }}
            >
                <input type="hidden" name="view" value="requests" />
                <label class="journal-search">
                    <span class="sr-only">搜索请求</span>
                    <Icon name="search" size={17} />
                    <input
                        name="q"
                        type="search"
                        value={search}
                        placeholder="搜索请求 ID、模型、操作或插件"
                        maxLength={200}
                        onInput={(event) => setSearch(controlValue(event))}
                    />
                    <button type="submit">搜索</button>
                </label>
                <label class="journal-status-filter">
                    <span>状态</span>
                    <select
                        name="status"
                        aria-label="请求状态"
                        value={state.status}
                        onInput={(event) =>
                            void controller.filter(
                                search,
                                controlValue(event) as RequestStatusDto | "",
                            )}
                    >
                        <option value="">全部状态</option>
                        {statuses.map((status) => (
                            <option value={status} key={status}>
                                {requestState(status).label}
                            </option>
                        ))}
                    </select>
                </label>
                {(state.q || state.status) && (
                    <button
                        class="journal-clear"
                        type="button"
                        onClick={() => {
                            setSearch("");
                            void controller.filter("", "");
                        }}
                    >
                        清除筛选
                    </button>
                )}
            </form>
            <div class="journal-list-meta">
                <p role="status">
                    {state.loading
                        ? "正在读取请求记录…"
                        : `${state.requests.length} 条记录`}
                    {state.q && <span>· 搜索“{state.q}”</span>}
                </p>
                <label class="journal-auto-refresh">
                    <input
                        type="checkbox"
                        checked={state.autoRefresh}
                        onInput={(event) =>
                            controller.setAutoRefresh(
                                (event.currentTarget as HTMLInputElement)
                                    .checked,
                            )}
                    />
                    <span>
                        每 15 秒刷新{state.autoRefresh && state.cursor !== null
                            ? " · 翻页时暂停"
                            : ""}
                    </span>
                </label>
            </div>
            {state.error && (
                <div class="journal-error" role="alert">
                    <p>{state.error}</p>
                    <button
                        type="button"
                        disabled={state.loading}
                        onClick={() => void controller.retry()}
                    >
                        重试
                    </button>
                </div>
            )}
            <div aria-busy={state.loading ? "true" : "false"}>
                {state.requests.length > 0
                    ? (
                        <JournalTable
                            requests={state.requests}
                            selectedId={state.selectedId}
                            location={state}
                            onSelect={(id) => void controller.select(id)}
                        />
                    )
                    : !state.loading && !state.error
                    ? (
                        <div class="journal-empty">
                            <Icon
                                name={state.q || state.status
                                    ? "search"
                                    : "logs"}
                                size={30}
                            />
                            <h3>
                                {state.q || state.status
                                    ? "没有匹配的请求"
                                    : "暂无请求记录"}
                            </h3>
                            <p>
                                {state.q || state.status
                                    ? "试试其他关键字或清除筛选条件。"
                                    : "通过网关发起调用后，记录会出现在这里。"}
                            </p>
                        </div>
                    )
                    : null}
            </div>
            <footer class="journal-pagination">
                <span>
                    {state.cursor && !state.canPrevious
                        ? "历史记录"
                        : `第 ${state.page} 页`}
                    <small>时间使用 UTC</small>
                </span>
                <div>
                    {state.cursor && (
                        <button
                            type="button"
                            disabled={state.loading}
                            onClick={() => void controller.first()}
                        >
                            回到最新
                        </button>
                    )}
                    <button
                        type="button"
                        disabled={state.loading || !state.canPrevious}
                        onClick={() => void controller.previous()}
                    >
                        <Icon name="arrow-left" size={15} />上一页
                    </button>
                    <button
                        type="button"
                        disabled={state.loading || !state.nextCursor}
                        onClick={() => void controller.next()}
                    >
                        下一页<Icon name="arrow-right" size={15} />
                    </button>
                </div>
            </footer>
            {state.selectedId && (
                <JournalDetailDrawer state={state} controller={controller} />
            )}
        </section>
    );
}
