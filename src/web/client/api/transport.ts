const ADMIN_TOKEN_KEY = "heimdall.admin.token";

interface AdminApiErrorOptions {
    status?: number;
    code?: string;
    requestId?: string;
    details?: unknown;
}

/** Error returned by the management API, retaining the safe diagnostic fields. */
export class AdminApiError extends Error {
    status: number;
    code: string;
    requestId: string;
    details: unknown;

    constructor(message: string, options: AdminApiErrorOptions = {}) {
        super(message);
        this.name = "AdminApiError";
        this.status = options.status ?? 0;
        this.code = options.code ?? "request_failed";
        this.requestId = options.requestId ?? "";
        this.details = options.details;
    }
}

interface RequestOptions {
    method?: string;
    headers?: HeadersInit;
    body?: BodyInit | null;
    signal?: AbortSignal;
}

interface PerformResult {
    data: unknown;
    etag: string;
    requestId: string;
}

function readStoredToken(): string {
    try {
        return globalThis.sessionStorage?.getItem(ADMIN_TOKEN_KEY) || "";
    } catch {
        return "";
    }
}

let adminToken = readStoredToken();
let adminFetcher: typeof fetch | undefined;

/** The web entry may install its session bridge without changing domain requests. */
export function configureAdminTransport(fetcher?: typeof fetch): void {
    adminFetcher = fetcher;
}

export function getAdminToken(): string {
    return adminToken;
}

/** Keep the bearer token in session storage only; it should not survive a browser restart. */
export function setAdminToken(value: string): string {
    adminToken = String(value ?? "").trim();
    try {
        if (adminToken) {
            globalThis.sessionStorage?.setItem(ADMIN_TOKEN_KEY, adminToken);
        } else {
            globalThis.sessionStorage?.removeItem(ADMIN_TOKEN_KEY);
        }
    } catch {
        // Storage can be disabled by privacy settings; the in-memory token still works.
    }
    return adminToken;
}

export function clearAdminToken(): void {
    setAdminToken("");
}

export function payloadRecord(
    payload: unknown,
): Record<string, unknown> | null {
    if (payload !== null && typeof payload === "object") {
        return payload as Record<string, unknown>;
    }
    return null;
}

export async function performRequest(
    path: string,
    options: RequestOptions = {},
): Promise<PerformResult> {
    const headers = new Headers(options.headers ?? {});
    headers.set("Accept", "application/json");
    if (options.body !== undefined && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }
    if (adminToken && !headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${adminToken}`);
    }

    let response: Response;
    try {
        response = await (adminFetcher ?? globalThis.fetch)(path, {
            ...options,
            headers,
        });
    } catch (error) {
        if (
            options.signal?.aborted ||
            (error instanceof Error && error.name === "AbortError")
        ) throw error;
        throw new AdminApiError(
            error instanceof Error ? error.message : "无法连接到管理服务",
            { code: "network_error" },
        );
    }

    const requestId = response.headers.get("x-heimdall-request-id") || "";
    const contentType = response.headers.get("content-type") || "";
    let payload: unknown = null;
    if (response.status !== 204) {
        if (contentType.includes("application/json")) {
            try {
                payload = await response.json() as unknown;
            } catch (error) {
                if (
                    options.signal?.aborted ||
                    (error instanceof Error && error.name === "AbortError")
                ) throw error;
                payload = null;
            }
        } else {
            const text = await response.text();
            payload = text ? { message: text } : null;
        }
    }

    if (!response.ok) {
        const body = payloadRecord(payload);
        const apiError = payloadRecord(body?.error);
        const message = typeof apiError?.message === "string"
            ? apiError.message
            : `${response.status} ${response.statusText}`.trim();
        throw new AdminApiError(message, {
            status: response.status,
            code: typeof apiError?.code === "string"
                ? apiError.code
                : "request_failed",
            requestId,
            details: payload,
        });
    }

    return {
        data: payload,
        etag: response.headers.get("etag") || "",
        requestId,
    };
}

export async function request<T = unknown>(
    path: string,
    options: RequestOptions = {},
): Promise<T> {
    return (await performRequest(path, options)).data as T;
}

export function describeError(error: unknown): string {
    if (error instanceof AdminApiError) {
        const suffix = error.requestId ? ` · request ${error.requestId}` : "";
        return `${error.message}${suffix}`;
    }
    return error instanceof Error ? error.message : String(error);
}
