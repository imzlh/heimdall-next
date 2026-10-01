/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import { createPortal } from "hono/jsx/dom";
import type { SystemLogLevel } from "@heimdall/admin-contracts/system-log.ts";
import type { SystemLogSnapshot } from "@heimdall/admin-contracts/console.ts";
import { Icon, type IconName } from "../../shared/icons.tsx";
import { SystemLogLedger } from "../../shared/system-log-table.tsx";
import { systemLogLevel } from "../../shared/system-log-data.ts";
import { createSystemLogController } from "./controller.ts";

/** Severity order for the segmented filter, matching the ledger's dots. */
const LEVEL_FILTERS: readonly (SystemLogLevel | "")[] = [
    "",
    "info",
    "warn",
    "error",
    "debug",
];

/** Icon per filter; icons carry the same colors as the timeline dots. */
const LEVEL_ICONS: Record<SystemLogLevel | "", IconName> = {
    "": "list",
    info: "info",
    warn: "warning",
    error: "error",
    debug: "bug",
};

export function SystemLogPage(
    { revision, initial, filterSlot }: {
        revision: number;
        initial?: SystemLogSnapshot;
        /** Header element the level filter teleports into. */
        filterSlot?: { readonly current: HTMLElement | null };
    },
) {
    const reference = useRef<
        ReturnType<typeof createSystemLogController> | null
    >(null);
    if (!reference.current) {
        reference.current = createSystemLogController({ initial });
    }
    const controller = reference.current;
    const [state, setState] = useState(controller.getState());
    const previousRevision = useRef(revision);
    const [slot, setSlot] = useState<HTMLElement | null>(null);

    useEffect(() => {
        setSlot(filterSlot?.current ?? null);
    }, [filterSlot]);

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

    // The buffer is oldest-first; operators expect the newest event on top.
    const ordered = [...state.entries].reverse();

    return (
        <section class="system-log-page" aria-label="系统日志">
            {slot && createPortal(
                <div
                    class="system-log-levels"
                    role="group"
                    aria-label="日志级别"
                >
                    {LEVEL_FILTERS.map((value) => {
                        const label = value === ""
                            ? "全部"
                            : systemLogLevel(value).label;
                        return (
                            <button
                                key={value || "all"}
                                type="button"
                                class={`system-log-level-chip${
                                    state.level === value ? " is-active" : ""
                                }${value ? ` system-log-chip-${value}` : ""}`}
                                aria-pressed={state.level === value}
                                aria-label={label}
                                title={label}
                                onClick={() => controller.setLevel(value)}
                            >
                                <Icon name={LEVEL_ICONS[value]} size={16} />
                            </button>
                        );
                    })}
                </div>,
                slot,
            )}
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
                {ordered.length > 0
                    ? <SystemLogLedger entries={ordered} />
                    : !state.loading && !state.error
                    ? (
                        <div class="journal-empty">
                            <Icon name="logs" size={30} />
                            <h3>暂无系统事件</h3>
                            <p>管理操作与服务事件会显示在这里。</p>
                        </div>
                    )
                    : null}
            </div>
            <p class="system-log-note">
                系统日志保存在内存中，最多 {state.capacity || 500}{" "}
                条，重启后清空。
                {state.dropped > 0 &&
                    ` 已有 ${state.dropped} 条更早的事件被滚动清除。`}
            </p>
        </section>
    );
}
