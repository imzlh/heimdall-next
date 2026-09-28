import type { Context } from "hono";
import type { RequestListOptions, RequestStatus } from "@heimdall/storage";
import type { ServerEnv } from "./app.ts";

const STATUSES = new Set<RequestStatus>([
    "pending",
    "running",
    "completed",
    "error",
    "cancelled",
]);

type RequestCursor = NonNullable<RequestListOptions["cursor"]>;

export function queryId(
    context: Context<ServerEnv>,
    required = false,
): string | undefined {
    const id = queryValue(context, "id");
    if (id === undefined && !required) return undefined;
    assertId(id ?? "");
    return id;
}

export function queryStatus(
    context: Context<ServerEnv>,
): RequestStatus | undefined {
    const value = queryValue(context, "status");
    if (value === undefined || value.length === 0) return undefined;
    if (!STATUSES.has(value as RequestStatus)) {
        throw invalid("status is not a known request status");
    }
    return value as RequestStatus;
}

export function querySearch(context: Context<ServerEnv>): string | undefined {
    const value = queryValue(context, "q");
    if (value === undefined || value.length === 0) return undefined;
    if (value.length > 200 || hasControls(value)) {
        throw invalid("q must contain at most 200 printable characters");
    }
    return value;
}

export function queryCursor(
    context: Context<ServerEnv>,
): RequestCursor | undefined {
    const raw = queryValue(context, "cursor");
    if (raw === undefined) return undefined;
    if (raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
        throw invalid("cursor is invalid");
    }
    try {
        const bytes = Uint8Array.from(
            atob(raw.replaceAll("-", "+").replaceAll("_", "/")),
            (value) => value.charCodeAt(0),
        );
        const value: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        if (
            !Array.isArray(value) || value.length !== 3 || value[0] !== 1 ||
            typeof value[1] !== "string" || typeof value[2] !== "string"
        ) throw invalid("cursor is invalid");
        validTimestamp(value[1], "cursor");
        assertId(value[2]);
        const cursor = { receivedAt: value[1], requestId: value[2] };
        if (encodeCursor(cursor) !== raw) throw invalid("cursor is invalid");
        return cursor;
    } catch {
        throw invalid("cursor is invalid");
    }
}

export function encodeCursor(cursor: RequestCursor): string {
    const bytes = new TextEncoder().encode(
        JSON.stringify([1, cursor.receivedAt, cursor.requestId]),
    );
    return btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function queryTimestamp(
    context: Context<ServerEnv>,
    name: string,
): string | undefined {
    const value = queryValue(context, name);
    if (value === undefined) return undefined;
    return validTimestamp(value, name);
}

export function queryLimit(
    context: Context<ServerEnv>,
    name: string,
    fallback: number,
    max: number,
): number {
    const raw = queryValue(context, name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value)) {
        throw invalid(`${name} must be a positive integer`);
    }
    // Keep the original operator API's cap for otherwise valid limits.
    return Math.min(value, max);
}

export function queryAfterSeq(context: Context<ServerEnv>): number {
    const raw = queryValue(context, "afterSeq");
    if (raw === undefined) return -1;
    const value = Number(raw);
    if (!/^(?:-1|0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(value)) {
        throw invalid(
            "afterSeq must be an integer greater than or equal to -1",
        );
    }
    return value;
}

function validTimestamp(value: string, name: string): string {
    const match =
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
            .exec(value);
    const parsed = Date.parse(value);
    if (match === null || !Number.isFinite(parsed)) {
        throw invalid(`${name} must be an ISO-8601 timestamp`);
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (
        month < 1 || month > 12 || day < 1 || day > days[month - 1]! ||
        Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59
    ) throw invalid(`${name} must be an ISO-8601 timestamp`);
    return new Date(parsed).toISOString();
}

function assertId(id: string): void {
    if (
        id.trim().length === 0 || id.length > 200 ||
        /[\/\\]/.test(id) || hasControls(id)
    ) throw invalid("request id is invalid");
}

function queryValue(
    context: Context<ServerEnv>,
    name: string,
): string | undefined {
    const values = context.req.queries(name);
    if (values !== undefined && values.length > 1) {
        throw invalid(`${name} must be provided only once`);
    }
    return values?.[0]?.trim();
}

function hasControls(value: string): boolean {
    return Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
    });
}

function invalid(message: string): Error {
    return Object.assign(new Error(message), {
        name: "JournalRouteError",
        status: 400,
        code: "invalid_request",
    });
}
