import type {
    ProxyEntryView,
    ProxyPoolInput,
    ProxyPoolView,
} from "@heimdall/admin-contracts/proxies.ts";
import { normalizeProxyAddress } from "../shared/proxy-presentation.ts";

export interface ProxyEntryDraft extends ProxyEntryView {
    readonly authMode: "keep" | "replace" | "clear";
    readonly username: string;
    readonly password: string;
}

export interface ProxyPoolDraft {
    readonly defaultProxyId: string | null;
    readonly entries: readonly ProxyEntryDraft[];
}

function hasControlCharacter(value: string): boolean {
    return [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
    });
}

export function proxyPoolDraft(pool: ProxyPoolView): ProxyPoolDraft {
    return {
        defaultProxyId: pool.defaultProxyId,
        entries: pool.entries.map((entry) => ({
            ...entry,
            authMode: "keep",
            username: "",
            password: "",
        })),
    };
}

export function proxyPoolInput(draft: ProxyPoolDraft): ProxyPoolInput {
    if (draft.entries.length > 64) {
        throw new TypeError("代理池最多可保存 64 个代理。");
    }
    const ids = new Set<string>();
    const entries = draft.entries.map((entry, index) => {
        const label = entry.name.trim() || `第 ${index + 1} 个代理`;
        if (
            !entry.name.trim() || entry.name.trim().length > 80 ||
            hasControlCharacter(entry.name)
        ) {
            throw new TypeError(`${label}：名称需为 1 至 80 个字符。`);
        }
        if (
            ids.has(entry.id) ||
            !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(entry.id)
        ) throw new TypeError("代理标识重复或无效。");
        ids.add(entry.id);
        let url: string;
        try {
            url = normalizeProxyAddress(entry.url);
        } catch {
            throw new TypeError(
                `${label}：请填写 http、https 或 socks5 的主机地址与端口，认证信息单独填写。`,
            );
        }
        if (
            entry.authMode === "replace" && (
                !entry.username || entry.username.length > 256 ||
                entry.password.length > 1024 ||
                hasControlCharacter(entry.username + entry.password)
            )
        ) throw new TypeError(`${label}：请填写有效的认证用户名与密码。`);
        return {
            id: entry.id,
            name: entry.name.trim(),
            url,
            enabled: entry.enabled,
            ...(entry.authMode === "replace"
                ? {
                    basicAuth: {
                        username: entry.username,
                        password: entry.password,
                    },
                }
                : entry.authMode === "clear"
                ? { basicAuth: null }
                : {}),
        };
    });
    if (
        draft.defaultProxyId &&
        !entries.some((entry) =>
            entry.id === draft.defaultProxyId && entry.enabled
        )
    ) {
        throw new TypeError("全局默认需选择启用中的代理，或选择直连。");
    }
    return { defaultProxyId: draft.defaultProxyId, entries };
}

function changed(entry: ProxyEntryDraft, base: ProxyEntryView): boolean {
    return entry.name !== base.name || entry.url !== base.url ||
        entry.enabled !== base.enabled || entry.authMode !== "keep";
}

/** A conflict refresh updates untouched fields while retaining local edits. */
export function mergeProxyPoolDraft(
    base: ProxyPoolView,
    local: ProxyPoolDraft,
    latest: ProxyPoolView,
): ProxyPoolDraft {
    const entries: ProxyEntryDraft[] = [];
    for (const entry of local.entries) {
        const before = base.entries.find((item) => item.id === entry.id);
        const remote = latest.entries.find((item) => item.id === entry.id);
        if (!remote) {
            if (!before || changed(entry, before)) {
                entries.push({ ...entry, authConfigured: false });
            }
            continue;
        }
        entries.push({
            ...entry,
            name: before && entry.name === before.name
                ? remote.name
                : entry.name,
            url: before && entry.url === before.url ? remote.url : entry.url,
            enabled: before && entry.enabled === before.enabled
                ? remote.enabled
                : entry.enabled,
            authConfigured: remote.authConfigured,
        });
    }
    for (const remote of latest.entries) {
        if (
            !base.entries.some((entry) => entry.id === remote.id) &&
            !entries.some((entry) => entry.id === remote.id)
        ) {
            entries.push({
                ...remote,
                authMode: "keep",
                username: "",
                password: "",
            });
        }
    }
    return {
        defaultProxyId: local.defaultProxyId === base.defaultProxyId
            ? latest.defaultProxyId
            : local.defaultProxyId,
        entries,
    };
}

export function proxyPoolDirty(
    base: ProxyPoolView,
    local: ProxyPoolDraft,
): boolean {
    return local.defaultProxyId !== base.defaultProxyId ||
        local.entries.length !== base.entries.length ||
        local.entries.some((entry) => {
            const before = base.entries.find((item) => item.id === entry.id);
            return !before || changed(entry, before);
        });
}
