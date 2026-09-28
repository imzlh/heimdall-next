import {
    exportJournalRequest,
    loadJournalRequest,
    loadJournalRequests,
} from "../api/journal.ts";
import { describeError } from "../api/transport.ts";
import type { RequestStatusDto } from "@heimdall/admin-contracts";
import type { JournalApi, JournalInitial, JournalState } from "./types.ts";

interface ListPlan {
    readonly cursor: string | null;
    readonly trail: readonly (string | null)[];
}

const defaultApi: JournalApi = {
    list: loadJournalRequests,
    detail: loadJournalRequest,
    export: exportJournalRequest,
};

/** Owns network lifetimes; timers and browser effects stay in the page island. */
export function createJournalController(
    options: { initial?: JournalInitial; api?: JournalApi } = {},
) {
    const { initial, api = defaultApi } = options;
    let state: JournalState = {
        requests: initial?.requests ?? [],
        nextCursor: initial?.nextCursor ?? null,
        q: initial?.q ?? "",
        status: initial?.status ?? "",
        cursor: initial?.cursor ?? null,
        page: 1,
        canPrevious: false,
        loading: !initial,
        error: initial?.error ?? "",
        autoRefresh: true,
        visible: true,
        selectedId: initial?.selectedId ?? "",
        detail: initial?.detail?.request ?? null,
        frames: initial?.detail?.frames ?? [],
        nextAfterSeq: initial?.detail?.nextAfterSeq ?? null,
        detailLoading: false,
        detailError: initial?.detailError ?? "",
        framesLoading: false,
        framesError: "",
        action: "",
        actionError: "",
        notice: "",
    };
    let trail: readonly (string | null)[] = [state.cursor];
    let listRun: AbortController | undefined;
    let listAutomatic = false;
    let detailRun: AbortController | undefined;
    let framesRun: AbortController | undefined;
    let actionRun: AbortController | undefined;
    let retryPlan: ListPlan | undefined;
    let disposed = false;
    let started = false;
    const listeners = new Set<(state: JournalState) => void>();
    function patch(update: Partial<JournalState>) {
        if (disposed) return;
        state = { ...state, ...update };
        for (const listener of listeners) listener(state);
    }

    async function loadList(plan: ListPlan, automatic = false) {
        if (disposed) return;
        listRun?.abort();
        const run = listRun = new AbortController();
        listAutomatic = automatic;
        retryPlan = plan;
        patch({ loading: true, error: "" });
        try {
            const result = await api.list({
                q: state.q || undefined,
                status: state.status || undefined,
                cursor: plan.cursor,
                limit: 30,
                signal: run.signal,
            });
            if (disposed || run !== listRun || run.signal.aborted) return;
            trail = plan.trail;
            retryPlan = undefined;
            patch({
                ...result,
                cursor: plan.cursor,
                page: trail.length,
                canPrevious: trail.length > 1,
                error: "",
            });
        } catch (cause) {
            if (disposed || run !== listRun || run.signal.aborted) return;
            patch({ error: `请求日志读取失败：${describeError(cause)}` });
        } finally {
            if (!disposed && run === listRun) {
                listRun = undefined;
                patch({ loading: false });
            }
        }
    }

    function cancelDetail() {
        detailRun?.abort();
        framesRun?.abort();
        actionRun?.abort();
        detailRun = framesRun = actionRun = undefined;
    }

    function closeDetail() {
        cancelDetail();
        patch({
            selectedId: "",
            detail: null,
            frames: [],
            nextAfterSeq: null,
            detailLoading: false,
            framesLoading: false,
            detailError: "",
            framesError: "",
            action: "",
            actionError: "",
            notice: "",
        });
    }

    async function select(id: string) {
        if (disposed || !id) return;
        cancelDetail();
        const run = detailRun = new AbortController();
        patch({
            selectedId: id,
            detail: null,
            frames: [],
            nextAfterSeq: null,
            detailLoading: true,
            detailError: "",
            framesLoading: false,
            framesError: "",
            action: "",
            actionError: "",
            notice: "",
        });
        try {
            const result = await api.detail(id, {
                frameLimit: 50,
                signal: run.signal,
            });
            if (disposed || detailRun !== run || run.signal.aborted) return;
            patch({
                detail: result.request,
                frames: result.frames,
                nextAfterSeq: result.nextAfterSeq,
            });
        } catch (cause) {
            if (disposed || detailRun !== run || run.signal.aborted) return;
            patch({ detailError: `详情读取失败：${describeError(cause)}` });
        } finally {
            if (!disposed && detailRun === run) {
                detailRun = undefined;
                patch({ detailLoading: false });
            }
        }
    }

    function stopAutomaticRun() {
        if (!listAutomatic || !listRun) return;
        listRun.abort();
        listRun = undefined;
        patch({ loading: false });
    }

    return {
        getState: () => state,
        subscribe(listener: (state: JournalState) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        start() {
            if (started || disposed) return;
            started = true;
            if (!initial) void loadList({ cursor: state.cursor, trail });
            if (state.selectedId && !state.detail && !state.detailError) {
                void select(state.selectedId);
            }
        },
        refresh() {
            return loadList({ cursor: state.cursor, trail });
        },
        retry() {
            return loadList(retryPlan ?? { cursor: state.cursor, trail });
        },
        filter(q: string, status: RequestStatusDto | "") {
            if (disposed) return Promise.resolve();
            closeDetail();
            trail = [null];
            patch({
                q: q.trim(),
                status,
                cursor: null,
                page: 1,
                canPrevious: false,
                requests: [],
                nextCursor: null,
            });
            return loadList({ cursor: null, trail });
        },
        next() {
            if (state.loading || !state.nextCursor) return Promise.resolve();
            return loadList({
                cursor: state.nextCursor,
                trail: [...trail, state.nextCursor],
            });
        },
        previous() {
            if (state.loading || trail.length < 2) return Promise.resolve();
            const previous = trail.slice(0, -1);
            return loadList({
                cursor: previous.at(-1) ?? null,
                trail: previous,
            });
        },
        first() {
            return loadList({ cursor: null, trail: [null] });
        },
        setAutoRefresh(enabled: boolean) {
            patch({ autoRefresh: enabled });
            if (!enabled) stopAutomaticRun();
        },
        setVisible(visible: boolean) {
            patch({ visible });
            if (!visible) stopAutomaticRun();
        },
        tickAutoRefresh() {
            if (
                disposed || !state.visible || !state.autoRefresh ||
                state.cursor !== null || state.loading
            ) return Promise.resolve();
            return loadList({ cursor: null, trail: [null] }, true);
        },
        select,
        closeDetail,
        async moreFrames() {
            if (
                disposed || state.framesLoading || state.detailLoading ||
                !state.detail || state.nextAfterSeq === null
            ) return;
            const id = state.selectedId;
            const run = framesRun = new AbortController();
            patch({ framesLoading: true, framesError: "" });
            try {
                const result = await api.detail(id, {
                    afterSeq: state.nextAfterSeq!,
                    frameLimit: 50,
                    signal: run.signal,
                });
                if (disposed || framesRun !== run || run.signal.aborted) return;
                const seen = new Set(state.frames.map((frame) => frame.seq));
                patch({
                    detail: result.request,
                    frames: [
                        ...state.frames,
                        ...result.frames.filter((frame) =>
                            !seen.has(frame.seq)
                        ),
                    ],
                    nextAfterSeq: result.nextAfterSeq,
                });
            } catch (cause) {
                if (disposed || framesRun !== run || run.signal.aborted) return;
                patch({
                    framesError: `事件帧读取失败：${describeError(cause)}`,
                });
            } finally {
                if (!disposed && framesRun === run) {
                    framesRun = undefined;
                    patch({ framesLoading: false });
                }
            }
        },
        async exportDetail(
            action: "copy" | "download",
            consume: (json: string, filename: string) => void | Promise<void>,
        ) {
            if (disposed || !state.detail || state.action) return;
            const id = state.selectedId;
            const run = actionRun = new AbortController();
            patch({ action, actionError: "", notice: "" });
            try {
                const result = await api.export(id, { signal: run.signal });
                if (disposed || actionRun !== run || run.signal.aborted) return;
                const name = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
                await consume(
                    JSON.stringify(result, null, 2),
                    `heimdall-request-${name}.json`,
                );
                if (disposed || actionRun !== run || run.signal.aborted) return;
                patch({
                    notice: action === "copy"
                        ? "完整 JSON 已复制"
                        : "完整 JSON 已下载",
                });
            } catch (cause) {
                if (disposed || actionRun !== run || run.signal.aborted) return;
                patch({
                    actionError: `${action === "copy" ? "复制" : "下载"}失败：${
                        describeError(cause)
                    }`,
                });
            } finally {
                if (!disposed && actionRun === run) {
                    actionRun = undefined;
                    patch({ action: "" });
                }
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            listRun?.abort();
            listRun = undefined;
            cancelDetail();
            listeners.clear();
        },
    };
}

export type JournalController = ReturnType<typeof createJournalController>;
