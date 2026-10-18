import type { Context } from "hono";
import { readBoundedBody, requestError, WebRequestError } from "./request.ts";

/** Credentials owned by a host that binds its HTTP listener to loopback only. */
export interface DesktopSessionOptions {
    /** A getter allows an ephemeral listener to publish its assigned port. */
    readonly origin: string | (() => string);
    /** Rotate the getter's value before opening a replacement native window. */
    readonly bootstrapToken: string | (() => string);
}

const BOOTSTRAP_SECONDS = 5 * 60;

export function validateDesktopSession(
    options: DesktopSessionOptions,
    adminAuthToken: string | undefined,
): void {
    if (!adminAuthToken?.trim()) {
        throw new TypeError("desktop sessions require an admin bearer token");
    }
    desktopBootstrapToken(options, adminAuthToken);
    // Deferred origins are validated on every request after the listener starts.
    if (typeof options.origin === "string") desktopOrigin(options);
}

function desktopBootstrapToken(
    options: DesktopSessionOptions,
    adminAuthToken: string,
): string {
    const token = typeof options.bootstrapToken === "function"
        ? options.bootstrapToken()
        : options.bootstrapToken;
    if (
        !/^[A-Za-z0-9_-]{32,256}$/.test(token) ||
        token === adminAuthToken.trim()
    ) {
        throw new TypeError(
            "desktop bootstrap requires a separate random token of 32–256 characters",
        );
    }
    return token;
}

export function desktopOrigin(options: DesktopSessionOptions): string {
    const value = typeof options.origin === "function"
        ? options.origin()
        : options.origin;
    const url = new URL(value);
    if (
        url.protocol !== "http:" ||
        !["127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.origin !== value || url.username || url.password
    ) {
        throw new TypeError(
            "desktop origin must be an exact HTTP loopback origin",
        );
    }
    return url.origin;
}

/** Pin the listener identity; never trust forwarded host or origin headers. */
export function assertDesktopRequest(
    request: Request,
    options: DesktopSessionOptions,
): void {
    const expected = desktopOrigin(options);
    const host = request.headers.get("host");
    const origin = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    if (
        new URL(request.url).origin !== expected ||
        (host !== null && host !== new URL(expected).host) ||
        (origin !== null && origin !== expected) ||
        (site !== null && site !== "same-origin" && site !== "none")
    ) {
        throw new WebRequestError(
            403,
            "desktop_origin_required",
            "请从当前桌面窗口访问本机服务。",
        );
    }
}

/** The secret is consumed before signing, including when exchanges race. */
export function createDesktopBootstrap(
    options: DesktopSessionOptions,
    issueSession: (context: Context) => Promise<void>,
    now: () => number,
    adminAuthToken: string,
): {
    document: (context: Context) => Response;
    exchange: (context: Context) => Promise<Response>;
} {
    let activeToken = desktopBootstrapToken(options, adminAuthToken);
    let expiresAt = now() + BOOTSTRAP_SECONDS * 1000;
    let consumed = false;
    const retiredTokens = new Set<string>();
    const refresh = (): string => {
        const token = desktopBootstrapToken(options, adminAuthToken);
        if (token !== activeToken) {
            retiredTokens.add(activeToken);
            activeToken = token;
            expiresAt = now() + BOOTSTRAP_SECONDS * 1000;
            consumed = retiredTokens.has(token);
        }
        return activeToken;
    };
    return {
        document(context) {
            try {
                assertDesktopRequest(context.req.raw, options);
                // A fresh window starts its exchange deadline on navigation.
                refresh();
                return desktopBootstrapDocument(context);
            } catch (error) {
                return requestError(error);
            }
        },
        async exchange(context) {
            try {
                assertDesktopRequest(context.req.raw, options);
                if (context.req.header("origin") !== desktopOrigin(options)) {
                    throw new WebRequestError(
                        403,
                        "desktop_origin_required",
                        "请从当前桌面窗口完成启动。",
                    );
                }
                if (
                    context.req.header("content-type")?.split(";")[0]?.trim()
                        .toLowerCase() !== "application/x-www-form-urlencoded"
                ) {
                    throw new WebRequestError(
                        415,
                        "invalid_content_type",
                        "启动请求无效。",
                    );
                }
                const expectedToken = refresh();
                const body = await readBoundedBody(
                    context.req.raw.body,
                    1024,
                    context.req.header("content-length"),
                );
                const tokens = new URLSearchParams(body).getAll("token");
                const valid = tokens.length === 1 &&
                    await equalToken(tokens[0]!, expectedToken);
                if (
                    refresh() !== expectedToken || consumed ||
                    now() >= expiresAt || !valid
                ) {
                    throw new WebRequestError(
                        401,
                        "desktop_bootstrap_expired",
                        "桌面启动凭证已失效，请重新启动应用。",
                    );
                }
                consumed = true;
                await issueSession(context);
                context.header("cache-control", "no-store");
                context.header("referrer-policy", "no-referrer");
                return context.body(null, 204);
            } catch (error) {
                return requestError(error);
            }
        },
    };
}

/** The fragment never reaches HTTP logs and is cleared before the exchange. */
export function desktopBootstrapDocument(context: Context): Response {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    context.header("cache-control", "no-store");
    context.header("referrer-policy", "no-referrer");
    context.header("x-content-type-options", "nosniff");
    context.header(
        "content-security-policy",
        `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    return context.html(
        `<!doctype html><html lang="zh" data-desktop="true"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>启动 Heimdall</title></head><body><main><h1>Heimdall</h1><p id="status" role="status">正在连接本机工作空间…</p></main><script nonce="${nonce}">
(async () => {
    const tokens = new URLSearchParams(location.hash.slice(1)).getAll("token");
    history.replaceState(null, "", "/admin/desktop/bootstrap");
    try {
        if (tokens.length !== 1 || !tokens[0]) throw new Error("missing token");
        const response = await fetch("/admin/desktop/bootstrap", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: tokens[0] }),
        });
        if (!response.ok) throw new Error("exchange failed");
        location.replace("/admin/chat");
    } catch {
        document.getElementById("status").textContent = "无法连接桌面会话，请关闭窗口并重新启动 Heimdall。";
    }
})();
</script></body></html>`,
    );
}

/** Fixed-size digests avoid comparisons that stop at the first differing byte. */
export async function equalToken(
    supplied: string,
    expected: string,
): Promise<boolean> {
    const encoder = new TextEncoder();
    const [left, right] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
        crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    ]);
    const a = new Uint8Array(left);
    const b = new Uint8Array(right);
    let difference = 0;
    for (let index = 0; index < a.length; index++) {
        difference |= a[index]! ^ b[index]!;
    }
    return difference === 0;
}
