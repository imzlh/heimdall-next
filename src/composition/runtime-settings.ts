import type { ConfigStore } from "@heimdall/storage";
import { StorageConflictError } from "@heimdall/storage";

/** Operator-tunable gate. The proxy key stays on this object and is not returned. */
export interface RuntimeSettings {
    readonly proxyKey: string;
    readonly limitPerMinute: number;
    readonly probeIntervalMs: number;
    /** Model id used to auto-name chat conversations; "" / absent disables it. */
    readonly titleModel?: string;
    /** 0 keeps request history indefinitely. */
    readonly requestRetentionDays?: number;
    /** 0 keeps conversations indefinitely; age is the last activity time. */
    readonly chatRetentionDays?: number;
}

export interface RuntimeSettingsPatch {
    readonly proxyKey?: string;
    readonly limitPerMinute?: number;
    readonly probeIntervalMs?: number;
    readonly titleModel?: string;
    readonly requestRetentionDays?: number;
    readonly chatRetentionDays?: number;
}

export interface PublicRuntimeSettings {
    readonly proxyKeyConfigured: boolean;
    readonly limitPerMinute: number;
    readonly probeIntervalMs: number;
    readonly titleModel: string;
    readonly requestRetentionDays: number;
    readonly chatRetentionDays: number;
}

export interface RuntimeSettingsHandle {
    get(): RuntimeSettings;
    versionstamp(): string;
    replace(next: RuntimeSettings, versionstamp: string): void;
    subscribe(listener: () => void): () => void;
}

interface StoredRuntimeSettings {
    readonly proxyKey?: unknown;
    readonly limitPerMinute?: unknown;
    readonly probeIntervalMs?: unknown;
    readonly titleModel?: unknown;
    readonly requestRetentionDays?: unknown;
    readonly chatRetentionDays?: unknown;
}

const settingsKey = ["runtime"] as const;

export function createRuntimeSettings(
    initial: RuntimeSettings,
): RuntimeSettingsHandle {
    let current = normalizeRuntimeSettings(initial);
    let version = "";
    const listeners = new Set<() => void>();
    return {
        get: () => current,
        versionstamp: () => version,
        replace(next, versionstamp) {
            current = normalizeRuntimeSettings(next);
            version = versionstamp;
            for (const listener of [...listeners]) {
                try {
                    listener();
                } catch { /* Observers cannot undo a saved setting. */ }
            }
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

export function redactRuntimeSettings(
    value: RuntimeSettings,
): PublicRuntimeSettings {
    return {
        proxyKeyConfigured: value.proxyKey.length > 0,
        limitPerMinute: value.limitPerMinute,
        probeIntervalMs: value.probeIntervalMs,
        titleModel: value.titleModel ?? "",
        requestRetentionDays: value.requestRetentionDays ?? 0,
        chatRetentionDays: value.chatRetentionDays ?? 0,
    };
}

export function applyRuntimeSettingsPatch(
    current: RuntimeSettings,
    patch: RuntimeSettingsPatch,
): RuntimeSettings {
    return normalizeRuntimeSettings({
        proxyKey: patch.proxyKey === undefined
            ? current.proxyKey
            : patch.proxyKey,
        limitPerMinute: patch.limitPerMinute === undefined
            ? current.limitPerMinute
            : patch.limitPerMinute,
        probeIntervalMs: patch.probeIntervalMs === undefined
            ? current.probeIntervalMs
            : patch.probeIntervalMs,
        titleModel: patch.titleModel === undefined
            ? current.titleModel
            : patch.titleModel,
        requestRetentionDays: patch.requestRetentionDays ??
            current.requestRetentionDays,
        chatRetentionDays: patch.chatRetentionDays ?? current.chatRetentionDays,
    });
}

/** Stored settings replace the env seed. A missing row leaves the handle as-is. */
export async function hydrateRuntimeSettings(
    store: ConfigStore,
    handle: RuntimeSettingsHandle,
): Promise<void> {
    const stored = await store.namespace("heimdall", "settings").get<
        StoredRuntimeSettings
    >(settingsKey);
    if (stored === null) return;
    handle.replace(
        storedSettings(stored.value, handle.get()),
        stored.versionstamp,
    );
}

export async function saveRuntimeSettings(
    store: ConfigStore,
    handle: RuntimeSettingsHandle,
    patch: RuntimeSettingsPatch,
    expectedVersionstamp?: string,
): Promise<{ settings: PublicRuntimeSettings; versionstamp: string }> {
    const currentVersion = handle.versionstamp();
    if (currentVersion.length > 0 && expectedVersionstamp === undefined) {
        throw new StorageConflictError("settings version is required");
    }
    const next = applyRuntimeSettingsPatch(handle.get(), patch);
    const versionstamp = await store.namespace("heimdall", "settings").set(
        settingsKey,
        next,
        {
            expectedVersionstamp: expectedVersionstamp === undefined
                ? null
                : expectedVersionstamp,
        },
    );
    handle.replace(next, versionstamp);
    return { settings: redactRuntimeSettings(next), versionstamp };
}

export function normalizeRuntimeSettings(
    value: RuntimeSettings,
): RuntimeSettings {
    if (
        !Number.isInteger(value.limitPerMinute) || value.limitPerMinute < 0 ||
        value.limitPerMinute > 100_000
    ) {
        throw new TypeError(
            "limitPerMinute must be an integer from 0 to 100000",
        );
    }
    if (
        !Number.isInteger(value.probeIntervalMs) || value.probeIntervalMs < 0 ||
        value.probeIntervalMs > 86_400_000
    ) {
        throw new TypeError(
            "probeIntervalMs must be an integer from 0 to 86400000",
        );
    }
    const titleModel = (value.titleModel ?? "").trim();
    if (titleModel.length > 200) {
        throw new TypeError("titleModel must be at most 200 characters");
    }
    for (const key of ["requestRetentionDays", "chatRetentionDays"] as const) {
        const days = value[key] ?? 0;
        if (!Number.isInteger(days) || days < 0 || days > 3650) {
            throw new TypeError(`${key} must be an integer from 0 to 3650`);
        }
    }
    return {
        proxyKey: value.proxyKey.trim(),
        limitPerMinute: value.limitPerMinute,
        probeIntervalMs: value.probeIntervalMs,
        titleModel,
        requestRetentionDays: value.requestRetentionDays ?? 0,
        chatRetentionDays: value.chatRetentionDays ?? 0,
    };
}

function storedSettings(
    value: StoredRuntimeSettings,
    seed: RuntimeSettings,
): RuntimeSettings {
    return {
        proxyKey: typeof value.proxyKey === "string" ? value.proxyKey : "",
        limitPerMinute: typeof value.limitPerMinute === "number"
            ? value.limitPerMinute
            : 120,
        probeIntervalMs: typeof value.probeIntervalMs === "number"
            ? value.probeIntervalMs
            : 300_000,
        titleModel: typeof value.titleModel === "string"
            ? value.titleModel
            : "",
        requestRetentionDays: typeof value.requestRetentionDays === "number"
            ? value.requestRetentionDays
            : seed.requestRetentionDays ?? 0,
        chatRetentionDays: typeof value.chatRetentionDays === "number"
            ? value.chatRetentionDays
            : seed.chatRetentionDays ?? 0,
    };
}
