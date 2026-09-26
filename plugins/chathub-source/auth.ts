/**
 * Browser PKCE login for Microsoft ChatHub (M365 Copilot).
 *
 * Uses the Office web Copilot first-party client with the fixed `nativeclient`
 * redirect, so the operator signs in with a real browser and pastes the final
 * callback URL back into the plugin's config page. The authorization code is
 * exchanged HERE, not in the browser: AAD rejects cross-origin token redemption
 * from a non-SPA redirect (AADSTS9002326), and the sandboxed config iframe has
 * no admin credential anyway.
 *
 * Flow (mirrors M365-Copilot2API's pkce_auth_gateway):
 *   1. `start`    → builds the authorize URL, keeps the PKCE verifier keyed by
 *                    state server-side (single-use, 15 min).
 *   2. `exchange` → state + pasted callback in, access/refresh tokens out,
 *                    with oid/tid/email decoded from the token claims so the
 *                    operator never types them.
 *   3. `refresh`  → renews the access token from the stored refresh token.
 *
 * Operator-fixable problems (bad paste, expired session, AAD consent errors)
 * come back as `{ ok: false, error }` so the config page can show them
 * directly; only transport-level surprises throw and surface as the generic
 * 502 envelope.
 */

const CLIENT_ID = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1";
const AUTHORITY = "https://login.microsoftonline.com/common";
const AUTHORIZE_URL = `${AUTHORITY}/oauth2/v2.0/authorize`;
export const CHATHUB_TOKEN_URL = `${AUTHORITY}/oauth2/v2.0/token`;
const REDIRECT_URI =
    "https://login.microsoftonline.com/common/oauth2/nativeclient";
const SCOPE =
    "openid profile offline_access https://substrate.office.com/sydney/.default";

const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 128;
const TOKEN_FETCH_TIMEOUT_MS = 20_000;
const MAX_ERROR_DETAIL = 300;

interface AuthSession {
    verifier: string;
    expiresAt: number;
}

const sessions = new Map<string, AuthSession>();

function sweepSessions(now = Date.now()): void {
    for (const [state, session] of sessions) {
        if (session.expiresAt <= now) sessions.delete(state);
    }
    while (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
    }
}

function base64UrlEncode(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
        /=+$/,
        "",
    );
}

function base64UrlDecode(text: string): Uint8Array {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - text.length % 4) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Error payload that is safe to show to the operator verbatim. */
export interface ChatHubAuthFailure {
    ok: false;
    error: string;
}

export interface ChatHubAuthStartResult {
    ok: true;
    authUrl: string;
    state: string;
}

export interface ChatHubAuthTokensResult {
    ok: true;
    oid: string;
    tid: string;
    email: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
}

export type ChatHubAuthResult =
    | ChatHubAuthStartResult
    | ChatHubAuthTokensResult
    | ChatHubAuthFailure;

function fail(error: string): ChatHubAuthFailure {
    return { ok: false, error };
}

/** Decode the claims of a JWT without verifying its signature. */
export function decodeJwtClaims(token: string): Record<string, string> {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    try {
        const parsed: unknown = JSON.parse(
            new TextDecoder().decode(base64UrlDecode(parts[1]!)),
        );
        if (!parsed || typeof parsed !== "object") return {};
        const claims: Record<string, string> = {};
        for (
            const [key, value] of Object.entries(
                parsed as Record<string, unknown>,
            )
        ) {
            if (typeof value === "string") claims[key] = value;
            else if (typeof value === "number" && Number.isFinite(value)) {
                claims[key] = String(value);
            }
        }
        return claims;
    } catch {
        return {};
    }
}

/**
 * Pull the authorization code out of what the operator pasted. Accepts the
 * full callback URL, a query-only string, a bare code, and the fragment form.
 * Throws an operator-readable error when no code can be recovered.
 */
export function extractAuthorizationCode(callback: string): string {
    const text = callback.trim().replace(/^["']+|["']+$/g, "");
    if (!text) throw new Error("回调内容为空");
    // A bare authorization code contains none of the URL markers.
    if (
        !text.includes("://") && !text.includes("code=") && !text.includes("&")
    ) return text;

    let candidate = text;
    if (candidate.startsWith("?")) candidate = REDIRECT_URI + candidate;
    else if (/^code=/i.test(candidate)) {
        candidate = `${REDIRECT_URI}?${candidate}`;
    }

    let url: URL;
    try {
        url = new URL(candidate);
    } catch {
        throw new Error("无法解析回调地址，请复制浏览器地址栏里的完整网址");
    }

    const readError = url.searchParams.get("error");
    if (readError && !url.searchParams.has("code")) {
        const description = url.searchParams.get("error_description") ?? "";
        throw new Error(
            `登录没有完成：${
                truncate(`${readError} ${description}`.trim(), MAX_ERROR_DETAIL)
            }`,
        );
    }

    if (!url.searchParams.has("code") && url.hash) {
        const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
        const code = fragment.get("code");
        if (code) return code;
    }

    const code = url.searchParams.get("code");
    if (!code) {
        throw new Error(
            "回调地址里没有 code= 参数：请复制出现 oauth2/nativeclient?code=… 时的完整网址" +
                "（它有时会在跳转到 wrongplace 前一闪而过）",
        );
    }
    return code;
}

function buildAuthUrl(state: string, challenge: string): string {
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        response_mode: "query",
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "select_account",
    });
    return `${AUTHORIZE_URL}?${params}`;
}

class TokenEndpointError extends Error {}

interface TokenResponse {
    accessToken: string;
    refreshToken: string;
    idToken: string;
    expiresIn: number;
}

/** Injected SDK routing or a legacy caller-owned native client. */
export type ChatHubAuthTransport = typeof fetch | Deno.HttpClient;

async function requestTokens(
    form: Record<string, string>,
    signal?: AbortSignal,
    transport?: ChatHubAuthTransport,
    redact: (message: string) => string = (message) => message,
): Promise<TokenResponse> {
    const timeout = AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS);
    const effectiveSignal = signal
        ? typeof AbortSignal.any === "function"
            ? AbortSignal.any([signal, timeout])
            : timeout
        : timeout;

    let response: Response;
    try {
        const fetchTokens = typeof transport === "function" ? transport : fetch;
        response = await fetchTokens(CHATHUB_TOKEN_URL, {
            method: "POST",
            // A public-client PKCE exchange must not carry an Origin header, or
            // AAD answers AADSTS9002326 — server-side fetch never adds one.
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                accept: "application/json",
            },
            body: new URLSearchParams(form),
            signal: effectiveSignal,
            ...(typeof transport === "function" ? {} : { client: transport }),
            redirect: "error",
        });
    } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(
            "无法连接 Microsoft 令牌端点，请检查服务器到 login.microsoftonline.com 的网络",
        );
    }

    let body: Record<string, unknown>;
    try {
        body = await response.json() as Record<string, unknown>;
    } catch {
        throw new Error(
            `Microsoft 令牌端点返回了无法解析的响应（HTTP ${response.status}）`,
        );
    }

    if (typeof body.error === "string" && body.error) {
        const description = typeof body.error_description === "string"
            ? body.error_description
            : "";
        throw new TokenEndpointError(
            truncate(
                redact(`${body.error} ${description}`.trim()),
                MAX_ERROR_DETAIL,
            ),
        );
    }
    if (
        !response.ok || typeof body.access_token !== "string" ||
        !body.access_token
    ) {
        throw new Error(`Microsoft 令牌端点返回 HTTP ${response.status}`);
    }
    return {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === "string"
            ? body.refresh_token
            : "",
        idToken: typeof body.id_token === "string" ? body.id_token : "",
        expiresIn: typeof body.expires_in === "number" ? body.expires_in : 3600,
    };
}

/**
 * The audience for the m365.cloud.microsoft server-action API (RefreshNavPane,
 * DeleteConversation). It is a different resource from the substrate/sydney
 * wire the chat itself uses, so it needs its own token minted from the same AAD
 * refresh token (the app is FOCI-eligible, so one refresh token serves both).
 */
const CLOUD_SCOPE = "https://m365.cloud.microsoft/v2/.default";

/**
 * Mint an access token for the m365.cloud.microsoft server-action API from the
 * channel's stored refresh token. Returns "" on any failure — cloud cleanup is
 * best-effort and must never throw into the request or sweep path.
 */
export async function requestCloudAccessToken(
    refreshToken: string,
    signal?: AbortSignal,
    transport?: ChatHubAuthTransport,
    redact?: (message: string) => string,
): Promise<string> {
    const token = refreshToken.trim();
    if (!token) return "";
    try {
        const tokens = await requestTokens(
            {
                client_id: CLIENT_ID,
                grant_type: "refresh_token",
                refresh_token: token,
                scope: CLOUD_SCOPE,
            },
            signal,
            transport,
            redact,
        );
        return tokens.accessToken;
    } catch {
        return "";
    }
}

function accountFromTokens(
    tokens: TokenResponse,
): ChatHubAuthTokensResult | ChatHubAuthFailure {
    const claims = {
        ...decodeJwtClaims(tokens.idToken),
        ...decodeJwtClaims(tokens.accessToken),
    };
    const oid = claims.oid || claims.sub || "";
    const tid = claims.tid || claims.tenant_id || "";
    if (!oid || !tid) {
        return fail(
            "令牌里缺少 oid/tid 声明，请确认登录的是 Microsoft 工作或学校账号",
        );
    }
    const email = claims.unique_name || claims.upn ||
        claims.preferred_username || claims.email ||
        "";
    const expSeconds = Number(claims.exp);
    const expiresMs = Number.isFinite(expSeconds) && expSeconds > 0
        ? expSeconds * 1000
        : Date.now() + tokens.expiresIn * 1000;
    return {
        ok: true,
        oid,
        tid,
        email,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: new Date(expiresMs).toISOString(),
    };
}

export async function startLogin(): Promise<ChatHubAuthStartResult> {
    sweepSessions();
    const verifier = base64UrlEncode(
        crypto.getRandomValues(new Uint8Array(48)),
    );
    const challenge = base64UrlEncode(
        new Uint8Array(
            await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(verifier),
            ),
        ),
    );
    const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
    sessions.set(state, { verifier, expiresAt: Date.now() + SESSION_TTL_MS });
    return { ok: true, authUrl: buildAuthUrl(state, challenge), state };
}

function readString(input: Record<string, unknown>, key: string): string {
    const value = input[key];
    return typeof value === "string" ? value : "";
}

export async function completeLogin(
    input: Record<string, unknown>,
    signal?: AbortSignal,
    transport?: ChatHubAuthTransport,
    redact?: (message: string) => string,
): Promise<ChatHubAuthTokensResult | ChatHubAuthFailure> {
    const state = readString(input, "state");
    const callback = readString(input, "callback");
    if (!state) return fail("登录会话丢失，请重新点击「登录 Microsoft 账号」");
    if (!callback.trim()) {
        return fail("请先粘贴登录完成后浏览器地址栏里的回调网址");
    }

    sweepSessions();
    const session = sessions.get(state);
    if (!session || session.expiresAt <= Date.now()) {
        sessions.delete(state);
        return fail(
            "登录会话不存在或已过期，请重新点击「登录 Microsoft 账号」",
        );
    }
    // Single-use: a second paste with the same session must not reuse the verifier.
    sessions.delete(state);

    let code: string;
    try {
        code = extractAuthorizationCode(callback);
    } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }

    let tokens: TokenResponse;
    try {
        tokens = await requestTokens(
            {
                client_id: CLIENT_ID,
                grant_type: "authorization_code",
                code,
                redirect_uri: REDIRECT_URI,
                code_verifier: session.verifier,
                scope: SCOPE,
            },
            signal,
            transport,
            redact,
        );
    } catch (error) {
        if (signal?.aborted) throw error;
        return fail(
            error instanceof Error
                ? `换取令牌失败：${error.message}`
                : `换取令牌失败：${String(error)}`,
        );
    }
    return accountFromTokens(tokens);
}

/**
 * Renew an access token from a refresh token. Shared by the `refresh`
 * capability action (operator-triggered) and the ChatHub data plane, which
 * calls it directly when it detects the channel's access token is expiring.
 */
export async function refreshAccessToken(
    refreshToken: string,
    signal?: AbortSignal,
    transport?: ChatHubAuthTransport,
    redact?: (message: string) => string,
): Promise<ChatHubAuthTokensResult | ChatHubAuthFailure> {
    // Send the trimmed value, not the raw stored one: a refresh token pasted into
    // .env or a config field often carries a trailing newline or stray spaces, and
    // URLSearchParams would percent-encode that whitespace into the token
    // (%0A/%20). AAD then rejects the grant as malformed (AADSTS9002313
    // invalid_grant) even though the token itself is still good.
    const token = refreshToken.trim();
    if (!token) return fail("没有已保存的刷新令牌，请重新执行一键登录");

    let tokens: TokenResponse;
    try {
        tokens = await requestTokens(
            {
                client_id: CLIENT_ID,
                grant_type: "refresh_token",
                refresh_token: token,
                scope: SCOPE,
            },
            signal,
            transport,
            redact,
        );
    } catch (error) {
        if (signal?.aborted) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        // A genuinely dead refresh token (revoked, or past its max lifetime) can
        // only be recovered by signing in again, so say so instead of leaving the
        // operator to decode the AAD trace.
        if (/invalid_grant|AADSTS/i.test(detail)) {
            return fail(
                `续期失败，刷新令牌已失效，请重新执行一键登录授权：${detail}`,
            );
        }
        return fail(`续期失败：${detail}`);
    }
    return accountFromTokens(tokens);
}
