import type {
    ResolvedSourceProxy,
    SourceProxySelection,
} from "@heimdall/contracts";
import type { ProxyPoolInput, ProxyPoolView } from "@heimdall/admin-contracts";
import type { ConfigStore } from "@heimdall/storage";
import { StorageConflictError } from "@heimdall/storage";

export interface ProxyPoolSnapshot {
    readonly pool: ProxyPoolView;
    readonly versionstamp: string;
}

export interface ProxyPoolHandle {
    view(): ProxyPoolSnapshot;
    save(
        input: ProxyPoolInput,
        expectedVersionstamp?: string,
    ): Promise<ProxyPoolSnapshot>;
    resolve(selection?: SourceProxySelection): ResolvedSourceProxy;
    /** New choices must reference an existing, enabled entry. */
    validateSelection(input: unknown): SourceProxySelection;
}

interface ProxyEntry {
    readonly id: string;
    readonly name: string;
    readonly url: string;
    readonly enabled: boolean;
    readonly basicAuth?: {
        readonly username: string;
        readonly password: string;
    };
}

interface ProxyPool {
    readonly defaultProxyId: string | null;
    readonly entries: readonly ProxyEntry[];
}

const poolKey = ["pool"] as const;
const emptyPool: ProxyPool = { defaultProxyId: null, entries: [] };
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const encoder = new TextEncoder();

/**
 * Owns configuration and choice resolution only. Actual network transports
 * remain in source plugins, which can read a new snapshot on every operation.
 */
export async function createProxyPool(
    store: ConfigStore,
): Promise<ProxyPoolHandle> {
    const namespace = store.namespace("heimdall", "proxy-pool");
    let stored;
    try {
        stored = await namespace.get<unknown>(poolKey);
    } catch {
        throw new Error("proxy pool storage is unavailable");
    }
    let current = emptyPool;
    let versionstamp = "";
    if (stored !== null) {
        try {
            current = normalizePool(stored.value, emptyPool);
        } catch {
            throw new TypeError("stored proxy pool is invalid");
        }
        versionstamp = stored.versionstamp;
    }

    function view(): ProxyPoolSnapshot {
        return {
            pool: {
                defaultProxyId: current.defaultProxyId,
                entries: current.entries.map((entry) => ({
                    id: entry.id,
                    name: entry.name,
                    url: entry.url,
                    enabled: entry.enabled,
                    authConfigured: entry.basicAuth !== undefined,
                })),
            },
            versionstamp,
        };
    }

    return {
        view,
        async save(input, expectedVersionstamp) {
            if (
                (expectedVersionstamp ?? "") !== versionstamp ||
                (versionstamp !== "" && expectedVersionstamp === undefined)
            ) {
                throw new StorageConflictError("proxy pool version changed");
            }
            // Copy and merge before the first await; callers never retain a
            // mutable reference into persisted or active configuration.
            const next = normalizePool(input, current);
            let nextVersion: string;
            try {
                nextVersion = await namespace.set(poolKey, next, {
                    expectedVersionstamp: versionstamp === ""
                        ? null
                        : versionstamp,
                });
            } catch (error) {
                if (error instanceof StorageConflictError) {
                    throw new StorageConflictError(
                        "proxy pool version changed",
                    );
                }
                throw new Error("proxy pool could not be saved");
            }
            current = next;
            versionstamp = nextVersion;
            return view();
        },
        resolve(selection) {
            const choice = parseSourceProxySelection(selection);
            const selectedBy = choice.mode === "inherit" ? "global" : "source";
            const proxyId = choice.mode === "inherit"
                ? current.defaultProxyId
                : choice.mode === "proxy"
                ? choice.proxyId
                : null;
            if (proxyId === null) return { mode: "direct", selectedBy };
            const entry = current.entries.find((entry) => entry.id === proxyId);
            if (!entry || !entry.enabled) {
                return {
                    mode: "unavailable",
                    selectedBy,
                    proxyId,
                    reason: entry ? "disabled" : "missing",
                };
            }
            return {
                mode: "proxy",
                selectedBy,
                proxy: {
                    id: entry.id,
                    name: entry.name,
                    url: entry.url,
                    ...(entry.basicAuth
                        ? { basicAuth: { ...entry.basicAuth } }
                        : {}),
                },
            };
        },
        validateSelection(input) {
            const selection = parseSourceProxySelection(input);
            if (selection.mode === "proxy") {
                const entry = current.entries.find((entry) =>
                    entry.id === selection.proxyId
                );
                if (!entry || !entry.enabled) {
                    throw new TypeError("selected proxy is unavailable");
                }
            }
            return selection;
        },
    };
}

/** Parse persisted choices without discarding deleted or disabled references. */
export function parseSourceProxySelection(
    input: unknown,
): SourceProxySelection {
    if (input === undefined) return { mode: "inherit" };
    try {
        const value = record(input, ["mode", "proxyId"]);
        if (value.mode === "inherit" || value.mode === "direct") {
            if (Object.hasOwn(value, "proxyId")) throw new TypeError();
            return { mode: value.mode };
        }
        if (value.mode === "proxy") {
            return { mode: "proxy", proxyId: validId(value.proxyId) };
        }
    } catch { /* Do not expose arbitrary input or accessor errors. */ }
    throw new TypeError("invalid source proxy selection");
}

function normalizePool(input: unknown, previous: ProxyPool): ProxyPool {
    try {
        const value = record(input, ["defaultProxyId", "entries"]);
        if (!Array.isArray(value.entries) || value.entries.length > 64) {
            throw new TypeError();
        }
        const entries: ProxyEntry[] = [];
        const ids = new Set<string>();
        for (let index = 0; index < value.entries.length; index++) {
            const item = Object.getOwnPropertyDescriptor(value.entries, index);
            if (!item || !("value" in item)) throw new TypeError();
            const entry = record(item.value, [
                "id",
                "name",
                "url",
                "enabled",
                "basicAuth",
            ]);
            const id = validId(entry.id);
            if (ids.has(id)) throw new TypeError();
            ids.add(id);
            const name = validString(entry.name, 80).trim();
            if (!name || typeof entry.enabled !== "boolean") {
                throw new TypeError();
            }
            const url = normalizeUrl(entry.url);
            let basicAuth = previous.entries.find((entry) => entry.id === id)
                ?.basicAuth;
            if (entry.basicAuth === null) basicAuth = undefined;
            else if (entry.basicAuth !== undefined) {
                const auth = record(entry.basicAuth, ["username", "password"]);
                basicAuth = {
                    username: validString(auth.username, 256),
                    password: validString(auth.password, 1_024, true),
                };
            }
            entries.push({
                id,
                name,
                url,
                enabled: entry.enabled,
                ...(basicAuth ? { basicAuth: { ...basicAuth } } : {}),
            });
        }
        const defaultProxyId = value.defaultProxyId === null
            ? null
            : validId(value.defaultProxyId);
        if (
            defaultProxyId !== null &&
            !entries.some((entry) =>
                entry.id === defaultProxyId && entry.enabled
            )
        ) {
            throw new TypeError();
        }
        const result = { defaultProxyId, entries };
        // Leave headroom beneath Deno KV's per-value limit, also for UTF-8 names.
        if (encoder.encode(JSON.stringify(result)).byteLength > 48 * 1_024) {
            throw new TypeError();
        }
        return result;
    } catch {
        throw new TypeError("invalid proxy pool configuration");
    }
}

function record(
    input: unknown,
    fields: readonly string[],
): Record<string, unknown> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new TypeError();
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError();
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const field of Reflect.ownKeys(input)) {
        if (typeof field !== "string" || !fields.includes(field)) {
            throw new TypeError();
        }
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (!descriptor || !("value" in descriptor)) throw new TypeError();
        result[field] = descriptor.value;
    }
    return result;
}

function validString(value: unknown, maximum: number, empty = false): string {
    if (
        typeof value !== "string" || value.length > maximum ||
        (!empty && value.length === 0) ||
        [...value].some((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127;
        })
    ) throw new TypeError();
    return value;
}

function validId(value: unknown): string {
    if (typeof value !== "string" || !idPattern.test(value)) {
        throw new TypeError();
    }
    return value;
}

function normalizeUrl(input: unknown): string {
    const value = validString(input, 2_048);
    // Validate the original authority before URL normalization can erase a
    // path, backslash, empty userinfo, query delimiter or fragment delimiter.
    if (!/^(?:http|https|socks5):\/\/[^/?#\\\s@]+\/?$/.test(value)) {
        throw new TypeError();
    }
    const url = new URL(value);
    if (
        !url.hostname || url.username || url.password || url.search ||
        url.hash ||
        (url.pathname !== "" && url.pathname !== "/") ||
        (url.port !== "" &&
            (!/^\d+$/.test(url.port) || Number(url.port) < 1 ||
                Number(url.port) > 65_535))
    ) throw new TypeError();
    return url.href;
}
