import type { ConfigStore } from "@heimdall/storage";
import type { MaintenanceStatusView } from "@heimdall/admin-contracts/console.ts";
import type { EventRecorder } from "./background-tasks.ts";
import type { RuntimeSettingsHandle } from "./runtime-settings.ts";
import { MAINTENANCE_INTERVAL_MS, runRetentionSweep } from "./maintenance.ts";

type SweepOptions = Parameters<typeof runRetentionSweep>[0];

export interface RetentionRuntime extends AsyncDisposable {
    snapshot(): MaintenanceStatusView;
    /** Also used by embedding hosts and deterministic maintenance tests. */
    run(): Promise<void>;
}

/** Own retention scheduling and its durable last-run summary separately from settings CAS. */
export async function startRetentionMaintenance(options: {
    readonly store: ConfigStore;
    readonly settings: RuntimeSettingsHandle;
    readonly requests: SweepOptions["requests"];
    readonly chat: SweepOptions["chat"];
    readonly assets: SweepOptions["assets"];
    readonly logger?: EventRecorder;
    readonly now?: () => Date;
    readonly intervalMs?: number;
}): Promise<RetentionRuntime> {
    const now = options.now ?? (() => new Date());
    const interval = options.intervalMs ?? MAINTENANCE_INTERVAL_MS;
    if (!Number.isInteger(interval) || interval < 1) {
        throw new TypeError("maintenance interval must be a positive integer");
    }
    const store = options.store.namespace("heimdall", "maintenance");
    const stored = await store.get<Partial<MaintenanceStatusView>>([
        "last-run",
    ]);
    const saved = stored?.value;
    const time = saved?.lastRunAt;
    let state: MaintenanceStatusView = {
        enabled: false,
        running: false,
        lastRunAt: typeof time === "string" && Number.isFinite(Date.parse(time))
            ? time
            : null,
        nextRunAt: null,
        prunedRequests: count(saved?.prunedRequests),
        prunedConversations: count(saved?.prunedConversations),
        prunedAssets: count(saved?.prunedAssets),
        lastError: typeof saved?.lastError === "string"
            ? saved.lastError
            : null,
    };
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: Promise<void> | undefined;
    let changedDuringRun = false;
    const policy = () => ({
        requestRetentionDays: options.settings.get().requestRetentionDays ?? 0,
        chatRetentionDays: options.settings.get().chatRetentionDays ?? 0,
    });
    let previous = policy();
    const clearTimer = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
    };
    const schedule = (immediate = false) => {
        clearTimer();
        if (stopped) return;
        const current = policy();
        const enabled = current.requestRetentionDays > 0 ||
            current.chatRetentionDays > 0;
        const last = state.lastRunAt === null
            ? null
            : Date.parse(state.lastRunAt);
        // Even when both histories are kept forever, abandoned uploads still
        // need bounded lease-aware reclaim. Expose that maintenance schedule.
        const delay = immediate || last === null ? 0 : Math.max(
            0,
            Math.min(interval, last + interval - now().getTime()),
        );
        state = {
            ...state,
            enabled,
            nextRunAt: new Date(now().getTime() + delay).toISOString(),
        };
        timer = setTimeout(() => {
            void run();
        }, delay);
    };
    const run = (): Promise<void> => {
        if (stopped) return Promise.resolve();
        if (active) return active;
        clearTimer();
        state = { ...state, running: true, nextRunAt: null };
        const execute = async () => {
            const result = runRetentionSweep({ ...options, ...policy() });
            state = {
                ...state,
                lastRunAt: now().toISOString(),
                prunedRequests: result.prunedRequests,
                prunedConversations: result.prunedConversations,
                prunedAssets: result.prunedAssets,
                lastError: result.errors.length
                    ? result.errors.join("；")
                    : null,
            };
            try {
                await store.set(["last-run"], {
                    lastRunAt: state.lastRunAt,
                    prunedRequests: state.prunedRequests,
                    prunedConversations: state.prunedConversations,
                    prunedAssets: state.prunedAssets,
                    lastError: state.lastError,
                });
            } catch {
                state = {
                    ...state,
                    lastError: [state.lastError, "清理状态保存失败"].filter(
                        Boolean,
                    ).join("；"),
                };
            }
            const summary =
                `已清理 ${result.prunedRequests} 条请求记录、${result.prunedConversations} 个对话、${result.prunedAssets} 个未引用附件。`;
            if (state.lastError) {
                options.logger?.warn("maintenance", state.lastError, summary);
            } else options.logger?.info("maintenance", summary);
        };
        // Assign before execution starts so a settings observer cannot overlap runs.
        active = Promise.resolve().then(execute).catch(() => {
            state = {
                ...state,
                lastRunAt: now().toISOString(),
                lastError: "数据维护未完成",
            };
            options.logger?.warn("maintenance", "数据维护未完成");
        }).finally(() => {
            active = undefined;
            state = { ...state, running: false };
            schedule(changedDuringRun);
            changedDuringRun = false;
        });
        return active;
    };
    const unsubscribe = options.settings.subscribe(() => {
        const current = policy();
        if (
            current.requestRetentionDays === previous.requestRetentionDays &&
            current.chatRetentionDays === previous.chatRetentionDays
        ) return;
        previous = current;
        state = {
            ...state,
            enabled: current.requestRetentionDays > 0 ||
                current.chatRetentionDays > 0,
        };
        if (active) changedDuringRun = true;
        else schedule(true);
    });
    schedule();
    return {
        snapshot: () => ({ ...state }),
        run,
        async [Symbol.asyncDispose]() {
            stopped = true;
            unsubscribe();
            clearTimer();
            await active;
            state = { ...state, running: false, nextRunAt: null };
        },
    };
}

function count(value: unknown): number {
    return typeof value === "number" && Number.isSafeInteger(value) &&
            value >= 0
        ? value
        : 0;
}
