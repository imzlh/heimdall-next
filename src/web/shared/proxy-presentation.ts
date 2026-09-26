import type {
    ProxyPoolView,
    SourceProxySelection,
    SourceProxySummary,
} from "@heimdall/admin-contracts/proxies.ts";

export interface ProxyPoolEnvelope {
    readonly pool: ProxyPoolView;
    readonly etag: string;
}

export const PROXY_IMPLEMENTATION_NOTE =
    "代理选择由插件读取，是否使用取决于插件实现。";

/** Deliberate projection for SSR and islands; credentials never enter view data. */
export function readProxyPoolView(value: unknown): ProxyPoolView {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("代理池数据格式无效");
    }
    const pool = value as Record<string, unknown>;
    if (
        !Array.isArray(pool.entries) || pool.entries.length > 64 ||
        !(pool.defaultProxyId === null ||
            typeof pool.defaultProxyId === "string")
    ) throw new TypeError("代理池数据格式无效");
    const ids = new Set<string>();
    return {
        defaultProxyId: pool.defaultProxyId,
        entries: pool.entries.map((input: unknown) => {
            if (!input || typeof input !== "object" || Array.isArray(input)) {
                throw new TypeError("代理条目格式无效");
            }
            const entry = input as Record<string, unknown>;
            if (
                typeof entry.id !== "string" ||
                !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(entry.id) ||
                ids.has(entry.id) || typeof entry.name !== "string" ||
                entry.name.length > 80 || typeof entry.url !== "string" ||
                typeof entry.enabled !== "boolean"
            ) throw new TypeError("代理条目格式无效");
            ids.add(entry.id);
            return {
                id: entry.id,
                name: entry.name,
                url: normalizeProxyAddress(entry.url),
                enabled: entry.enabled,
                authConfigured: entry.authConfigured === true,
            };
        }),
    };
}

/** Only a proxy origin is displayable; userinfo/query/path can contain secrets. */
export function normalizeProxyAddress(input: string): string {
    const value = input.trim();
    if (
        value.length > 2048 ||
        !/^(?:http|https|socks5):\/\/[^/?#\\\s@]+\/?$/.test(value)
    ) {
        throw new TypeError(
            "代理地址需为 http、https 或 socks5 地址，认证信息请单独填写。",
        );
    }
    const url = new URL(value);
    if (
        !url.hostname || url.username || url.password || url.search ||
        url.hash ||
        (url.pathname !== "" && url.pathname !== "/") ||
        (url.port !== "" && (!/^\d+$/.test(url.port) || Number(url.port) < 1 ||
            Number(url.port) > 65535))
    ) throw new TypeError("代理地址无效，请只填写协议、主机和端口。");
    return url.href;
}

export function sourceProxyValue(selection?: SourceProxySelection): string {
    return selection?.mode === "proxy"
        ? `proxy:${selection.proxyId}`
        : selection?.mode ?? "inherit";
}

export function sourceProxySelection(value: string): SourceProxySelection {
    if (value === "inherit" || value === "direct") return { mode: value };
    const proxyId = value.slice(6);
    if (
        value.startsWith("proxy:") &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(proxyId)
    ) {
        return { mode: "proxy", proxyId };
    }
    throw new TypeError("代理选择无效");
}

export function sourceProxyLabel(
    selection: SourceProxySelection | undefined,
    pool?: ProxyPoolView | null,
): string {
    if (selection?.mode === "direct") return "直连";
    const inherited = !selection || selection.mode === "inherit";
    if (inherited && !pool) return "继承全局默认";
    const proxyId = inherited ? pool?.defaultProxyId : selection.proxyId;
    if (!proxyId) return "继承全局 · 直连";
    const entry = pool?.entries.find((item) => item.id === proxyId);
    const label = entry
        ? `${entry.name}${entry.enabled ? "" : "（已停用）"}`
        : `${proxyId}（${pool ? "已移除" : "待读取"}）`;
    return inherited ? `继承全局 · ${label}` : `指定代理 · ${label}`;
}

export function sourceProxySummaryLabel(summary?: SourceProxySummary): string {
    if (!summary) return "继承全局默认";
    const prefix = summary.selectedBy === "global" ? "全局默认" : "渠道选择";
    if (summary.mode === "direct") return `${prefix} · 直连`;
    return `${prefix} · ${summary.name || summary.proxyId || "代理"}${
        summary.mode === "unavailable"
            ? summary.reason === "disabled" ? "（已停用）" : "（已移除）"
            : ""
    }`;
}
