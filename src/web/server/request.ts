/** HTTP limits shared by the browser session and its narrow API bridge. */
export class WebRequestError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "WebRequestError";
    }
}

/** A browser may only change the console from its own origin. */
export function assertSameOrigin(request: Request): void {
    const site = request.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin" && site !== "none") {
        throw new WebRequestError(
            403,
            "cross_origin",
            "请从当前后台页面提交操作。",
        );
    }
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== new URL(request.url).origin) {
        throw new WebRequestError(
            403,
            "cross_origin",
            "请从当前后台页面提交操作。",
        );
    }
}

/** Read at most `limit` bytes, including bodies without Content-Length. */
export async function readBoundedBody(
    body: ReadableStream<Uint8Array> | null,
    limit: number,
    contentLength?: string | null,
): Promise<string> {
    if (
        contentLength !== undefined && contentLength !== null &&
        (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)
    ) {
        throw new WebRequestError(
            413,
            "payload_too_large",
            "提交内容超出大小限制。",
        );
    }
    if (body === null) return "";
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let length = 0;
    let result = "";
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > limit) {
                await reader.cancel();
                throw new WebRequestError(
                    413,
                    "payload_too_large",
                    "提交内容超出大小限制。",
                );
            }
            result += decoder.decode(next.value, { stream: true });
        }
        return result + decoder.decode();
    } catch (error) {
        if (error instanceof WebRequestError) throw error;
        throw new WebRequestError(
            400,
            "invalid_body",
            "提交内容必须使用 UTF-8 编码。",
        );
    } finally {
        reader.releaseLock();
    }
}

export function requestError(error: unknown): Response {
    const failure = error instanceof WebRequestError
        ? error
        : new WebRequestError(
            502,
            "management_unavailable",
            "暂时无法访问管理服务。",
        );
    return Response.json({
        error: { code: failure.code, message: failure.message },
    }, {
        status: failure.status,
        headers: { "cache-control": "no-store" },
    });
}
