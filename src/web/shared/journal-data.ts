import type {
    FrameDto,
    RequestDetailDto,
    RequestStatusDto,
    RequestSummaryDto,
    UsageDto,
} from "@heimdall/admin-contracts";
import type {
    RequestJournalDetailResponse,
    RequestJournalExportResponse,
    RequestJournalListResponse,
} from "@heimdall/admin-contracts/journal.ts";

/** Exports retain additional server metadata, including future diagnostic fields. */
export interface JournalExportResult extends RequestJournalExportResponse {
    [key: string]: unknown;
}

/** Shared SSR/island validation deliberately has no browser transport dependency. */
export class JournalDataError extends Error {
    constructor() {
        super("请求日志返回了无法识别的数据，请刷新重试");
        this.name = "JournalDataError";
    }
}

const statuses: ReadonlySet<string> = new Set([
    "pending",
    "running",
    "completed",
    "error",
    "cancelled",
]);

function invalidResponse(): never {
    throw new JournalDataError();
}

function record(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return invalidResponse();
    }
    return value as Record<string, unknown>;
}

function text(value: unknown, allowEmpty = true): string {
    if (typeof value !== "string" || (!allowEmpty && !value.length)) {
        return invalidResponse();
    }
    return value;
}

function timestamp(value: unknown): string {
    const result = text(value, false);
    if (!Number.isFinite(Date.parse(result))) return invalidResponse();
    return result;
}

function integer(value: unknown, minimum = 0): number {
    if (
        typeof value !== "number" || !Number.isSafeInteger(value) ||
        value < minimum
    ) return invalidResponse();
    return value;
}

function optionalText(
    body: Record<string, unknown>,
    key: string,
): string | undefined {
    return body[key] === undefined ? undefined : text(body[key]);
}

/** List projections intentionally exclude request and response bodies. */
function summary(value: unknown): RequestSummaryDto {
    const body = record(value);
    const status = text(body.status);
    if (!statuses.has(status)) return invalidResponse();
    const requestId = text(body.requestId, false);
    return {
        requestId,
        status: status as RequestStatusDto,
        receivedAt: timestamp(body.receivedAt),
        ...(body.completedAt !== undefined
            ? { completedAt: timestamp(body.completedAt) }
            : {}),
        ...(body.usage !== undefined
            ? {
                usage: body.usage === null
                    ? null
                    : usage(body.usage, requestId),
            }
            : {}),
        ...Object.fromEntries([
            "streamId",
            "operation",
            "model",
            "protocolPluginId",
            "upstreamPluginId",
        ].flatMap((key) => {
            const value = optionalText(body, key);
            return value === undefined ? [] : [[key, value]];
        })),
    };
}

function usage(value: unknown, requestId: string): UsageDto {
    const body = record(value);
    if (body.requestId !== requestId) return invalidResponse();
    return {
        requestId,
        updatedAt: timestamp(body.updatedAt),
        ...Object.fromEntries([
            "inputTokens",
            "outputTokens",
            "reasoningTokens",
            "cachedInputTokens",
            "cacheWriteTokens",
            "totalTokens",
        ].flatMap((key) =>
            body[key] === undefined ? [] : [[key, integer(body[key])]]
        )),
        ...(body.cost !== undefined ? { cost: text(body.cost) } : {}),
        ...(body.currency !== undefined
            ? { currency: text(body.currency) }
            : {}),
    };
}

function detail(value: unknown, requestId: string): RequestDetailDto {
    const body = record(value);
    const row = summary(body);
    if (
        row.requestId !== requestId ||
        !Object.hasOwn(body, "request")
    ) return invalidResponse();
    return {
        ...row,
        request: body.request,
        ...(Object.hasOwn(body, "response") ? { response: body.response } : {}),
        ...(Object.hasOwn(body, "error") ? { error: body.error } : {}),
        ...(body.usage !== undefined
            ? {
                usage: body.usage === null
                    ? null
                    : usage(body.usage, requestId),
            }
            : {}),
    };
}

function frames(
    value: unknown,
    requestId: string,
    afterSeq = -1,
): FrameDto[] {
    if (!Array.isArray(value)) return invalidResponse();
    let previous = afterSeq;
    return value.map((value) => {
        const body = record(value);
        const seq = integer(body.seq);
        if (
            body.requestId !== requestId || seq <= previous ||
            !Object.hasOwn(body, "event")
        ) return invalidResponse();
        previous = seq;
        return {
            version: integer(body.version, 1),
            streamId: text(body.streamId, false),
            requestId,
            seq,
            eventId: text(body.eventId, false),
            timestamp: timestamp(body.timestamp),
            event: body.event,
            ...(body.causationId !== undefined
                ? { causationId: text(body.causationId) }
                : {}),
        };
    });
}

export function parseJournalList(value: unknown): RequestJournalListResponse {
    const body = record(value);
    if (!Array.isArray(body.requests)) return invalidResponse();
    const requests = body.requests.map(summary);
    if (
        new Set(requests.map((row) => row.requestId)).size !== requests.length
    ) {
        return invalidResponse();
    }
    const nextCursor = body.nextCursor === null
        ? null
        : text(body.nextCursor, false);
    if (nextCursor !== null && !requests.length) return invalidResponse();
    return { requests, nextCursor };
}

export function parseJournalDetail(
    value: unknown,
    expectedId: string,
    afterSeq = -1,
): RequestJournalDetailResponse {
    const body = record(value);
    const result = {
        request: detail(body.request, expectedId),
        frames: frames(body.frames, expectedId, afterSeq),
        nextAfterSeq: body.nextAfterSeq === null
            ? null
            : integer(body.nextAfterSeq),
    };
    if (
        result.nextAfterSeq !== null &&
        result.nextAfterSeq !== result.frames.at(-1)?.seq
    ) return invalidResponse();
    return result;
}

export function parseJournalExport(
    value: unknown,
    expectedId: string,
): JournalExportResult {
    const body = record(value);
    detail(body.request, expectedId);
    frames(body.frames, expectedId);
    // Do not project or paginate an export: operators download the complete JSON.
    return body as unknown as JournalExportResult;
}
