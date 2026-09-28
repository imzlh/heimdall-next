import type {
    SystemLogEntryDto,
    SystemLogLevel,
} from "@heimdall/admin-contracts/system-log.ts";
import type { SystemLogSnapshot } from "@heimdall/admin-contracts/console.ts";
import { describeError } from "../api/transport.ts";
import { loadSystemLog } from "../api/system-log.ts";

export interface SystemLogState {
    readonly entries: readonly SystemLogEntryDto[];
    readonly level: SystemLogLevel | "";
    readonly loading: boolean;
    readonly error: string;
    readonly dropped: number;
    readonly capacity: number;
    readonly loaded: boolean;
}

export interface SystemLogControllerOptions {
    readonly initial?: SystemLogSnapshot;
}

/** Newest-last append model: the buffer only ever grows and rolls at capacity. */
export function createSystemLogController(
    options: SystemLogControllerOptions = {},
) {
    const initial = options.initial;
    let state: SystemLogState = {
        entries: initial?.entries ?? [],
        level: initial?.level ?? "",
        loading: false,
        error: initial?.error ?? "",
        dropped: initial?.dropped ?? 0,
        capacity: initial?.capacity ?? 0,
        loaded: initial !== undefined && !initial.error,
    };
    let lastSeq = initial?.nextAfterSeq ?? 0;
    let visible = true;
    let inflight: AbortController | undefined;
    const listeners = new Set<(next: SystemLogState) => void>();

    const set = (patch: Partial<SystemLogState>) => {
        state = { ...state, ...patch };
        for (const listener of listeners) listener(state);
    };

    const cap = () => state.capacity > 0 ? state.capacity : 500;
    const trim = (entries: readonly SystemLogEntryDto[]) =>
        entries.length > cap()
            ? entries.slice(entries.length - cap())
            : entries;

    const run = async (afterSeq: number | undefined) => {
        inflight?.abort();
        const controller = new AbortController();
        inflight = controller;
        set({ loading: true, error: "" });
        try {
            const result = await loadSystemLog({
                level: state.level,
                afterSeq,
                signal: controller.signal,
            });
            if (controller.signal.aborted) return;
            const merged = afterSeq === undefined
                ? result.entries
                : mergeEntries(state.entries, result.entries);
            lastSeq = Math.max(lastSeq, result.nextAfterSeq);
            set({
                entries: trim(merged),
                dropped: result.dropped,
                capacity: result.capacity,
                loading: false,
                loaded: true,
            });
        } catch (error) {
            if (controller.signal.aborted) return;
            set({ loading: false, error: describeError(error) });
        } finally {
            if (inflight === controller) inflight = undefined;
        }
    };

    return {
        getState: () => state,
        subscribe(listener: (next: SystemLogState) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        start() {
            if (!state.loaded && !state.loading) void run(undefined);
        },
        refresh() {
            return run(undefined);
        },
        retry() {
            return run(undefined);
        },
        setLevel(level: SystemLogLevel | "") {
            if (level === state.level) return;
            lastSeq = 0;
            set({ level, entries: [] });
            void run(undefined);
        },
        tickAutoRefresh() {
            if (!visible || state.loading) return;
            return run(lastSeq);
        },
        setVisible(next: boolean) {
            visible = next;
        },
        dispose() {
            inflight?.abort();
            listeners.clear();
        },
    };
}

/** Append only entries newer than what we hold, guarding against overlap. */
function mergeEntries(
    current: readonly SystemLogEntryDto[],
    incoming: readonly SystemLogEntryDto[],
): readonly SystemLogEntryDto[] {
    if (incoming.length === 0) return current;
    const highest = current.length > 0 ? current[current.length - 1]!.seq : 0;
    const fresh = incoming.filter((entry) => entry.seq > highest);
    return fresh.length === 0 ? current : [...current, ...fresh];
}
