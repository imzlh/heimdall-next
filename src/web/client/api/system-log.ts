import type {
    SystemLogLevel,
    SystemLogListResponse,
} from "@heimdall/admin-contracts/system-log.ts";
import {
    parseSystemLogList,
    SystemLogDataError,
} from "../../shared/system-log-data.ts";
import { AdminApiError, request } from "./transport.ts";

export interface SystemLogLoadOptions {
    level?: SystemLogLevel | "";
    afterSeq?: number;
    limit?: number;
    signal?: AbortSignal;
}

export async function loadSystemLog(
    options: SystemLogLoadOptions = {},
): Promise<SystemLogListResponse> {
    const query = new URLSearchParams();
    if (options.level) query.set("level", options.level);
    if (options.afterSeq !== undefined) {
        query.set("afterSeq", String(options.afterSeq));
    }
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size ? `?${query}` : "";
    const body = await request(`/api/admin/system-logs${suffix}`, {
        signal: options.signal,
    });
    try {
        return parseSystemLogList(body);
    } catch (error) {
        if (!(error instanceof SystemLogDataError)) throw error;
        throw new AdminApiError(error.message, { code: "invalid_response" });
    }
}
