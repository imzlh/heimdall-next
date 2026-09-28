import type { JournalSnapshot } from "@heimdall/admin-contracts/console.ts";
import type { RequestStatusDto } from "@heimdall/admin-contracts";
import {
    parseJournalDetail,
    parseJournalList,
} from "../shared/journal-data.ts";
import type { ConsoleSnapshotOptions } from "./snapshot.ts";
import { readBoundedBody } from "./request.ts";

const STATUSES: readonly string[] = [
    "pending",
    "running",
    "completed",
    "error",
    "cancelled",
];

/** The page follows the same management DTOs and authorization as the island. */
export async function loadJournalSnapshot(
    options: ConsoleSnapshotOptions,
    query: URLSearchParams,
): Promise<JournalSnapshot> {
    const q = query.get("q")?.trim() ?? "";
    const status = query.get("status")?.trim() || undefined;
    const cursor = query.get("cursor") || null;
    const selectedId = query.get("id")?.trim() || undefined;
    const snapshot: JournalSnapshot = {
        requests: [],
        nextCursor: null,
        error: "",
        q,
        cursor,
        selectedId,
        status: STATUSES.includes(status ?? "")
            ? status as RequestStatusDto
            : undefined,
    };
    if (!options.authorized) {
        return { requests: [], nextCursor: null, error: "" };
    }
    if (
        ["q", "status", "cursor"].some((key) => query.getAll(key).length > 1) ||
        q.length > 200 || hasControls(q) ||
        (status && !STATUSES.includes(status)) ||
        (cursor !== null &&
            (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)))
    ) {
        return { ...snapshot, error: "筛选条件无效，请修改后重试。" };
    }
    const read = async (params: URLSearchParams): Promise<unknown> => {
        const headers = new Headers({ accept: "application/json" });
        if (options.adminAuthToken !== undefined) {
            headers.set(
                "authorization",
                `Bearer ${options.adminAuthToken.trim()}`,
            );
        }
        const response = await options.dispatch(
            new Request(
                new URL(
                    `/api/admin/requests?${params}`,
                    options.origin ?? "http://localhost",
                ),
                { headers, redirect: "manual" },
            ),
        );
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`读取失败（HTTP ${response.status}）`);
        }
        try {
            const body = await readBoundedBody(
                response.body,
                4_194_304,
                response.headers.get("content-length"),
            );
            const data: unknown = JSON.parse(body);
            return redact(data, options.adminAuthToken?.trim());
        } catch (error) {
            await response.body?.cancel().catch(() => {});
            throw error;
        }
    };
    const filters = new URLSearchParams({ limit: "30" });
    if (q) filters.set("q", q);
    if (status) filters.set("status", status);
    if (cursor) filters.set("cursor", cursor);
    await Promise.all([
        (async () => {
            try {
                const result = parseJournalList(await read(filters));
                snapshot.requests = result.requests;
                snapshot.nextCursor = result.nextCursor;
            } catch (error) {
                snapshot.error = message(error);
            }
        })(),
        (async () => {
            if (!selectedId) return;
            if (
                query.getAll("id").length > 1 ||
                selectedId.length > 200 ||
                /[\\/]/.test(selectedId) || hasControls(selectedId)
            ) {
                snapshot.detailError = "请求 ID 无效。";
                return;
            }
            const params = new URLSearchParams({
                id: selectedId,
                frameLimit: "50",
            });
            const afterSeq = query.get("afterSeq");
            if (
                query.getAll("afterSeq").length > 1 ||
                (afterSeq !== null && (
                    !/^(?:-1|0|[1-9][0-9]*)$/.test(afterSeq) ||
                    !Number.isSafeInteger(Number(afterSeq))
                ))
            ) {
                snapshot.detailError = "事件帧位置无效。";
                return;
            }
            if (afterSeq !== null) params.set("afterSeq", afterSeq);
            try {
                snapshot.detail = parseJournalDetail(
                    await read(params),
                    selectedId,
                    afterSeq === null ? -1 : Number(afterSeq),
                );
            } catch (error) {
                snapshot.detailError = message(error);
            }
        })(),
    ]);
    return snapshot;
}

function hasControls(value: string): boolean {
    return Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
    });
}

function message(error: unknown): string {
    return error instanceof Error &&
            /^读取失败（HTTP \d+）$/.test(error.message)
        ? error.message
        : "暂时无法读取请求日志，请重试。";
}

function redact(value: unknown, secret: string | undefined): unknown {
    if (!secret) return value;
    if (typeof value === "string") return value.replaceAll(secret, "[已隐藏]");
    if (Array.isArray(value)) {
        return value.map((entry) => redact(entry, secret));
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map((
                [key, entry],
            ) => [key.replaceAll(secret, "[已隐藏]"), redact(entry, secret)]),
        );
    }
    return value;
}
