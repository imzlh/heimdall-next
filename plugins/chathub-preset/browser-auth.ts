import type { SourceProxySelection } from "@heimdall/contracts/proxy.ts";

/** Fixed, cookie-authenticated transport for this trusted preset's login action. */
export interface AuthorizationSession {
    readonly authUrl: string;
    readonly state: string;
}

export interface AuthorizedAccount {
    readonly oid: string;
    readonly tid: string;
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly email: string;
    readonly expiresAt: string;
}

export class AuthorizationError extends Error {}

const MICROSOFT_ORIGIN = "https://login.microsoftonline.com";
const CALLBACK_PATH = "/common/oauth2/nativeclient";

export async function startAuthorization(
    signal: AbortSignal,
    transport: typeof fetch = fetch,
    proxy?: SourceProxySelection,
): Promise<AuthorizationSession> {
    const result = await request({ action: "start" }, signal, transport, proxy);
    const state = field(result, "state", 256);
    const authUrl = field(result, "authUrl", 8192);
    let url: URL;
    try {
        url = new URL(authUrl);
    } catch {
        throw invalidResponse();
    }
    if (
        url.origin !== MICROSOFT_ORIGIN || url.username || url.password ||
        url.hash || url.pathname !== "/common/oauth2/v2.0/authorize" ||
        url.searchParams.get("state") !== state
    ) throw invalidResponse();
    return { authUrl: url.href, state };
}

/** Reject wrong-account/wrong-session callback pastes before consuming PKCE. */
export function validateAuthorizationCallback(
    callback: string,
    state: string,
): string {
    if (!callback.trim() || callback.length > 16_384) {
        throw new AuthorizationError(
            "请粘贴登录完成后地址栏中的完整回调网址。",
        );
    }
    let url: URL;
    try {
        url = new URL(callback.trim());
    } catch {
        throw new AuthorizationError(
            "回调网址不完整，请重新复制浏览器地址栏。",
        );
    }
    if (
        url.origin !== MICROSOFT_ORIGIN || url.pathname !== CALLBACK_PATH ||
        url.username || url.password || url.hash
    ) {
        throw new AuthorizationError(
            "请使用 Microsoft 登录完成后的 nativeclient 回调网址。",
        );
    }
    if (url.searchParams.get("state") !== state) {
        throw new AuthorizationError(
            "这条回调属于其他授权，请使用本次登录的回调网址。",
        );
    }
    if (!url.searchParams.get("code")) {
        throw new AuthorizationError("登录尚未完成，回调网址中没有授权码。");
    }
    return url.href;
}

export async function exchangeAuthorization(
    session: AuthorizationSession,
    callback: string,
    signal: AbortSignal,
    transport: typeof fetch = fetch,
    proxy?: SourceProxySelection,
): Promise<AuthorizedAccount> {
    const result = await request(
        {
            action: "exchange",
            state: session.state,
            callback: validateAuthorizationCallback(callback, session.state),
        },
        signal,
        transport,
        proxy,
    );
    const expiresAt = field(result, "expiresAt", 128);
    if (!Number.isFinite(Date.parse(expiresAt))) throw invalidResponse();
    return {
        oid: field(result, "oid", 256),
        tid: field(result, "tid", 256),
        accessToken: field(result, "accessToken", 65_536),
        refreshToken: field(result, "refreshToken", 65_536, true),
        email: field(result, "email", 1024, true),
        expiresAt,
    };
}

async function request(
    body: Record<string, string>,
    signal: AbortSignal,
    transport: typeof fetch,
    proxy?: SourceProxySelection,
): Promise<Record<string, unknown>> {
    let response: Response;
    try {
        response = await transport("/admin/ui/request", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                path: "/api/admin/plugins/chathub/auth",
                method: "POST",
                body: {
                    ...body,
                    // The host resolves this identity. Proxy credentials stay
                    // on the server and never travel through preset UI.
                    ...(proxy
                        ? {
                            proxy: proxy.mode === "proxy"
                                ? { mode: proxy.mode, proxyId: proxy.proxyId }
                                : { mode: proxy.mode },
                        }
                        : {}),
                },
            }),
        });
    } catch (error) {
        if (signal.aborted) throw error;
        throw new AuthorizationError("无法连接授权服务，请检查网络后重试。");
    }
    if (response.status === 401 || response.status === 403) {
        throw new AuthorizationError("后台登录已失效，请重新登录后台后授权。");
    }
    if (response.status === 404) {
        throw new AuthorizationError(
            "授权插件暂不可用，请确认 ChatHub 授权插件已启用。",
        );
    }
    if (!response.ok) {
        throw new AuthorizationError(
            "授权未完成或已过期，请重新准备授权后登录。",
        );
    }
    let result: unknown;
    try {
        result = await response.json();
    } catch {
        throw invalidResponse();
    }
    if (
        !result || typeof result !== "object" || Array.isArray(result) ||
        (result as Record<string, unknown>).ok !== true
    ) throw invalidResponse();
    return result as Record<string, unknown>;
}

function field(
    result: Record<string, unknown>,
    key: string,
    maximum: number,
    allowEmpty = false,
): string {
    const value = result[key];
    if (
        typeof value !== "string" || value.length > maximum ||
        (!allowEmpty && !value.trim())
    ) throw invalidResponse();
    return value.trim();
}

function invalidResponse(): AuthorizationError {
    // Never reflect provider payloads, callback codes or credentials in errors.
    return new AuthorizationError("授权服务返回的内容不完整，请重新准备授权。");
}
