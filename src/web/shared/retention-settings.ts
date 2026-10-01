import type { MaintenanceStatusView } from "@heimdall/admin-contracts/console.ts";

export const RETENTION_MAX_DAYS = 3650;
export const ASSET_RETENTION_NOTE =
    "附件随对话引用保留；没有引用且上传租约已到期的附件会自动回收。";

/** Missing values stay absent for older settings responders. */
export function readRetentionDays(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) &&
            value >= 0 && value <= RETENTION_MAX_DAYS
        ? value
        : undefined;
}

export function retentionDaysLabel(days = 0): string {
    return days === 0 ? "永久保留" : `${days} 天`;
}

/** Deliberate projection shared by SSR and islands; no private state is copied. */
export function readMaintenanceStatus(
    value: unknown,
    redact: (value: string) => string = (value) => value,
): MaintenanceStatusView | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const status = value as Record<string, unknown>;
    if (
        typeof status.enabled !== "boolean" ||
        typeof status.running !== "boolean"
    ) return undefined;
    const count = (input: unknown) =>
        typeof input === "number" && Number.isSafeInteger(input) && input >= 0
            ? input
            : 0;
    const timestamp = (input: unknown) =>
        typeof input === "string" && Number.isFinite(Date.parse(input))
            ? new Date(input).toISOString()
            : null;
    return {
        enabled: status.enabled,
        running: status.running,
        lastRunAt: timestamp(status.lastRunAt),
        nextRunAt: timestamp(status.nextRunAt),
        prunedRequests: count(status.prunedRequests),
        prunedConversations: count(status.prunedConversations),
        prunedAssets: count(status.prunedAssets),
        lastError:
            typeof status.lastError === "string" && status.lastError.trim()
                ? redact(status.lastError).slice(0, 512)
                : null,
    };
}
