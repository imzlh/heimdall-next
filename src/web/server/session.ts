import type { Context } from "hono";
import {
    assertSameOrigin,
    readBoundedBody,
    WebRequestError,
} from "./request.ts";

const COOKIE_NAME = "heimdall_admin_session";
const SESSION_SECONDS = 8 * 60 * 60;
const MAX_LOGIN_BYTES = 16_384;

export interface WebSessionOptions {
    readonly adminAuthToken?: string;
    /** Defaults to a process-local random secret; restarting expires sessions. */
    readonly signingSecret?: string;
    readonly now?: () => number;
}

export interface WebSession {
    authorized(context: Context): Promise<boolean>;
    login(context: Context): Promise<Response>;
    logout(context: Context): Response;
}

/** The web session never changes bearer authentication on management routes. */
export function createWebSession(options: WebSessionOptions = {}): WebSession {
    const expected = options.adminAuthToken?.trim();
    const secret = options.signingSecret ??
        `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const signingKey = crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
    );
    const now = options.now ?? Date.now;
    const authorized = async (context: Context): Promise<boolean> => {
        if (expected === undefined) return true;
        if (expected.length === 0) return false;
        const authorization = context.req.header("authorization") ?? "";
        if (
            authorization.startsWith("Bearer ") &&
            await equalToken(authorization.slice(7).trim(), expected)
        ) return true;
        try {
            const value = cookieValue(context.req.header("cookie"));
            if (value === undefined) return false;
            const match = /^(v1\.(\d+)\.[0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/
                .exec(value);
            if (match === null) return false;
            const expires = Number(match[2]);
            const valid = await crypto.subtle.verify(
                "HMAC",
                await signingKey,
                decodeSignature(match[3]!),
                new TextEncoder().encode(match[1]!),
            );
            return valid && Number.isSafeInteger(expires) && expires > now() &&
                expires <= now() + SESSION_SECONDS * 1000;
        } catch {
            return false;
        }
    };

    return {
        authorized,
        async login(context) {
            try {
                assertSameOrigin(context.req.raw);
                const contentType = context.req.header("content-type")
                    ?.split(";")[0]?.trim().toLowerCase();
                if (contentType !== "application/x-www-form-urlencoded") {
                    throw new WebRequestError(
                        415,
                        "invalid_content_type",
                        "请通过登录表单提交管理令牌。",
                    );
                }
                const body = await readBoundedBody(
                    context.req.raw.body,
                    MAX_LOGIN_BYTES,
                    context.req.header("content-length"),
                );
                const params = new URLSearchParams(body);
                const tokens = params.getAll("token");
                if (tokens.length > 1) {
                    throw new WebRequestError(
                        400,
                        "invalid_request",
                        "管理令牌只能提交一次。",
                    );
                }
                const token = (tokens[0] ?? "").trim();
                if (
                    expected !== undefined &&
                    (expected.length === 0 ||
                        !await equalToken(token, expected))
                ) {
                    throw new WebRequestError(
                        401,
                        "unauthorized",
                        "管理令牌无效，请重新输入。",
                    );
                }
                const value = `v1.${
                    now() + SESSION_SECONDS * 1000
                }.${crypto.randomUUID()}`;
                const signature = await crypto.subtle.sign(
                    "HMAC",
                    await signingKey,
                    new TextEncoder().encode(value),
                );
                const encoded = btoa(
                    String.fromCharCode(...new Uint8Array(signature)),
                )
                    .replaceAll("+", "-").replaceAll("/", "_").replace(
                        /=+$/,
                        "",
                    );
                setSessionCookie(
                    context,
                    `${value}.${encoded}`,
                    SESSION_SECONDS,
                );
                context.header("cache-control", "no-store");
                return context.redirect(
                    params.get("returnTo") === "/admin/chat"
                        ? "/admin/chat"
                        : "/admin",
                    303,
                );
            } catch (error) {
                return loginError(error);
            }
        },
        logout(context) {
            try {
                assertSameOrigin(context.req.raw);
                setSessionCookie(context, "", 0);
                context.header("cache-control", "no-store");
                return context.redirect("/admin", 303);
            } catch (error) {
                return loginError(error);
            }
        },
    };
}

function cookieValue(header: string | undefined): string | undefined {
    if (header === undefined) return undefined;
    const matches = header.split(";").map((part) => part.trim())
        .filter((part) => part.startsWith(`${COOKIE_NAME}=`));
    if (matches.length !== 1) return undefined;
    const value = matches[0]!.slice(COOKIE_NAME.length + 1);
    return value.length <= 256 ? value : undefined;
}

function decodeSignature(value: string): Uint8Array<ArrayBuffer> {
    const decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=");
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function setSessionCookie(
    context: Context,
    value: string,
    maxAge: number,
): void {
    const secure = new URL(context.req.url).protocol === "https:"
        ? "; Secure"
        : "";
    context.header(
        "set-cookie",
        `${COOKIE_NAME}=${value}; Path=/admin; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`,
    );
}

/** Fixed-size digests keep token comparison independent of a matching prefix. */
async function equalToken(
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

function loginError(error: unknown): Response {
    const failure = error instanceof WebRequestError
        ? error
        : new WebRequestError(
            500,
            "session_unavailable",
            "暂时无法创建登录会话。",
        );
    // Messages are host-owned constants. Never echo the submitted credentials.
    return new Response(
        `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录后台</title><body><main><h1>无法完成登录</h1><p>${failure.message}</p><a href="/admin">返回后台</a></main></body></html>`,
        {
            status: failure.status,
            headers: {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
                "content-security-policy":
                    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
                "x-content-type-options": "nosniff",
            },
        },
    );
}
