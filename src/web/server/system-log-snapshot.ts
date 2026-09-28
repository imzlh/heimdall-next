import type { SystemLogSnapshot } from "@heimdall/admin-contracts/console.ts";
import type { SystemLogLevel } from "@heimdall/admin-contracts/system-log.ts";
import { SYSTEM_LOG_LEVELS } from "@heimdall/admin-contracts/system-log.ts";
import { parseSystemLogList } from "../shared/system-log-data.ts";
import type { ConsoleSnapshotOptions } from "./snapshot.ts";
import { readBoundedBody } from "./request.ts";

/** SSR view of the system-log tab, using the same DTOs as the island. */
export async function loadSystemLogSnapshot(
    options: ConsoleSnapshotOptions,
    query: URLSearchParams,
): Promise<SystemLogSnapshot> {
    const requested = query.get("logLevel")?.trim() || undefined;
    const level = SYSTEM_LOG_LEVELS.includes(requested as SystemLogLevel)
        ? requested as SystemLogLevel
        : undefined;
    const empty: SystemLogSnapshot = {
        entries: [],
        nextAfterSeq: 0,
        dropped: 0,
        capacity: 0,
        error: "",
        level,
    };
    if (!options.authorized) return empty;

    const params = new URLSearchParams({ limit: "100" });
    if (level) params.set("level", level);
    const headers = new Headers({ accept: "application/json" });
    if (options.adminAuthToken !== undefined) {
        headers.set("authorization", `Bearer ${options.adminAuthToken.trim()}`);
    }
    try {
        const response = await options.dispatch(
            new Request(
                new URL(
                    `/api/admin/system-logs?${params}`,
                    options.origin ?? "http://localhost",
                ),
                { headers, redirect: "manual" },
            ),
        );
        if (!response.ok) {
            await response.body?.cancel();
            return { ...empty, error: `读取失败（HTTP ${response.status}）` };
        }
        const body = await readBoundedBody(
            response.body,
            4_194_304,
            response.headers.get("content-length"),
        );
        const result = parseSystemLogList(
            redact(JSON.parse(body), options.adminAuthToken?.trim()),
        );
        return {
            entries: result.entries,
            nextAfterSeq: result.nextAfterSeq,
            dropped: result.dropped,
            capacity: result.capacity,
            error: "",
            level,
        };
    } catch {
        return { ...empty, error: "暂时无法读取系统日志，请重试。" };
    }
}

function redact(value: unknown, secret: string | undefined): unknown {
    if (!secret) return value;
    if (typeof value === "string") return value.replaceAll(secret, "[已隐藏]");
    if (Array.isArray(value)) {
        return value.map((entry) => redact(entry, secret));
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [
                key,
                redact(entry, secret),
            ]),
        );
    }
    return value;
}
