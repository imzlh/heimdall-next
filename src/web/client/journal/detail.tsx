/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef } from "hono/jsx/dom";
import { Icon } from "../../shared/icons.tsx";
import { requestState } from "../../shared/activity-presentation.ts";
import { journalTime, requestDuration } from "../../shared/journal-table.tsx";
import { copyChatText } from "../chat/clipboard.ts";
import type { JournalController } from "./controller.ts";
import type { JournalState } from "./types.ts";

function JsonSection({ title, value, open = false }: {
    title: string;
    value: unknown;
    open?: boolean;
}) {
    return (
        <details class="journal-json" open={open}>
            <summary>
                <Icon name="chevron-right" size={15} />
                {title}
            </summary>
            {value === undefined || value === null
                ? <p class="journal-empty-value">暂无数据</p>
                : (
                    <pre
                        tabIndex={0}
                    ><code>{JSON.stringify(value, null, 2)}</code></pre>
                )}
        </details>
    );
}

function eventLabel(event: unknown): string {
    if (!event || typeof event !== "object") return "事件";
    const type = (event as Record<string, unknown>).type;
    return typeof type === "string" ? type : "事件";
}

export function downloadJournalJson(json: string, filename: string) {
    const url = URL.createObjectURL(
        new Blob([json], { type: "application/json;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    try {
        document.body.appendChild(anchor);
        anchor.click();
    } finally {
        anchor.remove();
        globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

/** Native modal supplies focus trapping; closing always cancels pending reads. */
export function JournalDetailDrawer({ state, controller }: {
    state: JournalState;
    controller: JournalController;
}) {
    const dialog = useRef<HTMLDialogElement | null>(null);
    const close = useRef<HTMLButtonElement | null>(null);
    useEffect(() => {
        const element = dialog.current;
        const trigger = document.activeElement as HTMLElement | null;
        if (element && !element.open) element.showModal();
        close.current?.focus();
        return () => {
            if (element?.open) element.close();
            if (trigger?.isConnected && !trigger.hasAttribute("disabled")) {
                trigger.focus();
            }
        };
    }, []);

    const detail = state.detail;
    const status = detail ? requestState(detail.status) : null;
    return (
        <dialog
            ref={dialog}
            class="journal-detail"
            aria-labelledby="journal-detail-title"
            aria-describedby="journal-detail-description"
            onCancel={(event: Event) => {
                event.preventDefault();
                controller.closeDetail();
            }}
            onClick={(event) => {
                const element = dialog.current;
                if (!element || event.target !== element) return;
                const rect = element.getBoundingClientRect();
                if (
                    event.clientX < rect.left || event.clientX > rect.right ||
                    event.clientY < rect.top || event.clientY > rect.bottom
                ) {
                    controller.closeDetail();
                }
            }}
        >
            <header class="journal-detail-header">
                <div class="journal-detail-heading">
                    <span class="journal-eyebrow">请求详情</span>
                    <h2 id="journal-detail-title">
                        {detail?.model || "请求记录"}
                    </h2>
                    <p id="journal-detail-description">
                        <code>{state.selectedId}</code>
                    </p>
                </div>
                <button
                    ref={close}
                    type="button"
                    class="icon-button"
                    aria-label="关闭请求详情"
                    onClick={() => controller.closeDetail()}
                >
                    <Icon name="close" />
                </button>
            </header>
            <div
                class="journal-detail-content"
                aria-busy={state.detailLoading ? "true" : "false"}
            >
                {state.detailLoading && (
                    <p class="journal-loading" role="status">
                        <Icon name="spinner" />正在读取请求详情…
                    </p>
                )}
                {state.detailError && (
                    <div class="journal-error" role="alert">
                        <p>{state.detailError}</p>
                        <button
                            type="button"
                            onClick={() =>
                                void controller.select(state.selectedId)}
                        >
                            重试详情
                        </button>
                    </div>
                )}
                {detail && (
                    <>
                        <dl class="journal-detail-meta">
                            <div>
                                <dt>状态</dt>
                                <dd>
                                    <span
                                        class={`status-chip chip-${
                                            status!.tone
                                        }`}
                                    >
                                        {status!.label}
                                    </span>
                                </dd>
                            </div>
                            <div>
                                <dt>总耗时</dt>
                                <dd>{requestDuration(detail)}</dd>
                            </div>
                            <div>
                                <dt>接收时间 · UTC</dt>
                                <dd>
                                    <time dateTime={detail.receivedAt}>
                                        {journalTime(detail.receivedAt)}
                                    </time>
                                </dd>
                            </div>
                            <div>
                                <dt>操作</dt>
                                <dd>{detail.operation || "—"}</dd>
                            </div>
                            {detail.protocolPluginId && (
                                <div>
                                    <dt>协议插件</dt>
                                    <dd>
                                        <code>{detail.protocolPluginId}</code>
                                    </dd>
                                </div>
                            )}
                            {detail.upstreamPluginId && (
                                <div>
                                    <dt>来源插件</dt>
                                    <dd>
                                        <code>{detail.upstreamPluginId}</code>
                                    </dd>
                                </div>
                            )}
                        </dl>
                        {detail.usage && (
                            <div class="journal-usage" aria-label="Token 用量">
                                <span>
                                    输入{" "}
                                    <strong>
                                        {detail.usage.inputTokens
                                            ?.toLocaleString("zh-CN") ?? "—"}
                                    </strong>
                                </span>
                                <span>
                                    输出{" "}
                                    <strong>
                                        {detail.usage.outputTokens
                                            ?.toLocaleString("zh-CN") ?? "—"}
                                    </strong>
                                </span>
                                <span>
                                    总计{" "}
                                    <strong>
                                        {detail.usage.totalTokens
                                            ?.toLocaleString("zh-CN") ?? "—"}
                                    </strong>{" "}
                                    tokens
                                </span>
                            </div>
                        )}
                        <div class="journal-payloads">
                            <JsonSection
                                title="请求 · Request"
                                value={detail.request}
                                open
                            />
                            <JsonSection
                                title="响应 · Response"
                                value={detail.response}
                            />
                            <JsonSection
                                title="错误 · Error"
                                value={detail.error}
                                open={detail.status === "error"}
                            />
                            <JsonSection
                                title="用量 · Usage"
                                value={detail.usage}
                            />
                        </div>
                        <section
                            class="journal-frames"
                            aria-labelledby="journal-frames-title"
                            aria-busy={state.framesLoading ? "true" : "false"}
                        >
                            <div class="journal-frames-heading">
                                <h3 id="journal-frames-title">
                                    事件帧 · Frames
                                </h3>
                                <span>{state.frames.length} 条已加载</span>
                            </div>
                            {state.frames.length
                                ? state.frames.map((frame) => (
                                    <details
                                        class="journal-json journal-frame"
                                        key={frame.seq}
                                    >
                                        <summary>
                                            <Icon
                                                name="chevron-right"
                                                size={15}
                                            />
                                            <code>#{frame.seq}</code>
                                            <strong>
                                                {eventLabel(frame.event)}
                                            </strong>
                                            <time dateTime={frame.timestamp}>
                                                {journalTime(frame.timestamp)}
                                            </time>
                                        </summary>
                                        <pre
                                            tabIndex={0}
                                        ><code>{JSON.stringify(frame, null, 2)}</code></pre>
                                    </details>
                                ))
                                : (
                                    <p class="journal-empty-value">
                                        暂无事件帧。
                                    </p>
                                )}
                            {state.framesError && (
                                <p class="form-error" role="alert">
                                    {state.framesError}
                                </p>
                            )}
                            {state.nextAfterSeq !== null && (
                                <button
                                    class="journal-more-frames"
                                    type="button"
                                    disabled={state.framesLoading}
                                    onClick={() => void controller.moreFrames()}
                                >
                                    {state.framesLoading
                                        ? "正在读取…"
                                        : state.framesError
                                        ? "重试事件帧"
                                        : "加载后续事件帧"}
                                    <Icon name="chevron-down" size={15} />
                                </button>
                            )}
                            {state.nextAfterSeq === null &&
                                state.frames.length > 0 && (
                                <p class="journal-frame-end">
                                    已加载当前全部事件帧
                                </p>
                            )}
                        </section>
                    </>
                )}
            </div>
            <footer class="journal-detail-footer">
                {state.actionError && (
                    <p class="form-error" role="alert">{state.actionError}</p>
                )}
                {state.notice && (
                    <p class="journal-notice" role="status">
                        <Icon name="check" size={15} />
                        {state.notice}
                    </p>
                )}
                <div class="journal-detail-actions">
                    <button
                        type="button"
                        disabled={state.detailLoading || state.framesLoading}
                        onClick={() => void controller.select(state.selectedId)}
                    >
                        <Icon name="refresh" size={15} />刷新详情
                    </button>
                    <div>
                        <button
                            type="button"
                            disabled={!detail || !!state.action}
                            onClick={() => void controller.exportDetail(
                                "copy",
                                copyChatText,
                            )}
                        >
                            <Icon name="copy" size={15} />
                            {state.action === "copy"
                                ? "正在复制…"
                                : "复制 JSON"}
                        </button>
                        <button
                            class="primary-button"
                            type="button"
                            disabled={!detail || !!state.action}
                            onClick={() => void controller.exportDetail(
                                "download",
                                downloadJournalJson,
                            )}
                        >
                            <Icon name="download" size={15} />
                            {state.action === "download"
                                ? "正在下载…"
                                : "下载完整 JSON"}
                        </button>
                    </div>
                </div>
            </footer>
        </dialog>
    );
}
