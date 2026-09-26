import type {
    UiAction,
    UiContext,
    UiContribution,
} from "@heimdall/admin-contracts/ui.ts";

/** Browser adapter for the cookie-only web session; API credentials stay server-side. */
export const sessionFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const rawUrl = request ? request.url : String(input);
    const url = new URL(rawUrl, globalThis.location.origin);
    if (url.origin !== globalThis.location.origin) {
        throw new Error("管理请求必须同源");
    }
    if (url.pathname === "/health") return await fetch(input, init);
    if (!url.pathname.startsWith("/api/admin/")) {
        throw new Error("管理请求地址无效");
    }
    const headers = new Headers(init?.headers ?? request?.headers);
    const forwarded: Record<string, string> = {};
    for (const name of ["if-match", "x-request-id"]) {
        const value = headers.get(name);
        if (value !== null) forwarded[name] = value;
    }
    const method = init?.method ?? request?.method ?? "GET";
    const signal = init?.signal ?? request?.signal;
    let bodyText: string | undefined;
    if (init?.body !== undefined && init.body !== null) {
        if (typeof init.body !== "string") {
            throw new Error("管理请求必须使用 JSON");
        }
        bodyText = init.body;
    } else if (request) {
        const text = await request.text();
        bodyText = text.length > 0 ? text : undefined;
    }
    // The host assigns one trace to the outer request and its nested API call.
    // Lift an explicitly supplied trace to that HTTP boundary as well.
    const bridgeHeaders = new Headers({ "content-type": "application/json" });
    const requestId = headers.get("x-request-id");
    if (requestId !== null) bridgeHeaders.set("x-request-id", requestId);
    return await fetch("/admin/ui/request", {
        method: "POST",
        credentials: "same-origin",
        signal,
        headers: bridgeHeaders,
        body: JSON.stringify({
            path: url.pathname + url.search,
            method,
            headers: forwarded,
            ...(bodyText !== undefined ? { body: JSON.parse(bodyText) } : {}),
        }),
    });
};

export async function login(token: string): Promise<void> {
    const response = await fetch("/admin/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
    });
    if (!response.ok) {
        throw new Error(
            response.status === 401 ? "管理令牌无效" : "暂时无法连接管理工作区",
        );
    }
    globalThis.location.assign("/admin");
}

export async function logout(): Promise<void> {
    const response = await fetch("/admin/logout", {
        method: "POST",
        credentials: "same-origin",
    });
    if (!response.ok) throw new Error("退出失败，请重试");
    globalThis.location.assign("/admin");
}

export async function sendUiAction(
    contribution: UiContribution,
    action: UiAction,
    context: UiContext,
): Promise<void> {
    const response = await fetch("/admin/ui/action", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            contributionId: `${contribution.pluginId}:${contribution.id}`,
            action,
            theme: context.theme,
            ...(context.sourceId ? { sourceId: context.sourceId } : {}),
        }),
    });
    if (!response.ok) throw new Error("插件动作执行失败，请刷新后重试。");
}
