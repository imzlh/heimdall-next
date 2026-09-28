import type {
    RequestJournalDetailQuery,
    RequestJournalDetailResponse,
    RequestJournalListResponse,
    RequestJournalQuery,
} from "@heimdall/admin-contracts/journal.ts";
import {
    JournalDataError,
    type JournalExportResult,
    parseJournalDetail,
    parseJournalExport,
    parseJournalList,
} from "../../shared/journal-data.ts";
import { AdminApiError, request } from "./transport.ts";

export interface JournalRequestOptions {
    signal?: AbortSignal;
}

export interface JournalListOptions
    extends
        JournalRequestOptions,
        Omit<RequestJournalQuery, "cursor" | "before"> {
    cursor?: string | null;
}

export type JournalDetailOptions =
    & JournalRequestOptions
    & RequestJournalDetailQuery;
export type JournalListResult = RequestJournalListResponse;
export type JournalDetailResult = RequestJournalDetailResponse;
export type { JournalExportResult };

function validated<T>(parse: () => T): T {
    try {
        return parse();
    } catch (error) {
        if (!(error instanceof JournalDataError)) throw error;
        throw new AdminApiError(error.message, { code: "invalid_response" });
    }
}

export async function loadJournalRequests(
    options: JournalListOptions = {},
): Promise<JournalListResult> {
    const query = new URLSearchParams();
    for (const key of ["status", "q", "cursor", "limit"] as const) {
        if (options[key] !== undefined && options[key] !== null) {
            query.set(key, String(options[key]));
        }
    }
    const suffix = query.size ? `?${query}` : "";
    const body = await request(`/api/admin/requests${suffix}`, {
        signal: options.signal,
    });
    return validated(() => {
        const result = parseJournalList(body);
        if (
            result.nextCursor !== null && result.nextCursor === options.cursor
        ) throw new JournalDataError();
        return result;
    });
}

export async function loadJournalRequest(
    id: string,
    options: JournalDetailOptions = {},
): Promise<JournalDetailResult> {
    const query = new URLSearchParams({ id });
    for (const key of ["afterSeq", "frameLimit"] as const) {
        if (options[key] !== undefined) query.set(key, String(options[key]));
    }
    const body = await request(`/api/admin/requests?${query}`, {
        signal: options.signal,
    });
    return validated(() => parseJournalDetail(body, id, options.afterSeq));
}

export async function exportJournalRequest(
    id: string,
    options: JournalRequestOptions = {},
): Promise<JournalExportResult> {
    const query = new URLSearchParams({ id });
    const body = await request(`/api/admin/requests/export?${query}`, {
        signal: options.signal,
    });
    return validated(() => parseJournalExport(body, id));
}
