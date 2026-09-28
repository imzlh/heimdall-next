import { useEffect, useRef, useState } from "hono/jsx/dom";
import type { ConsolePage } from "../shared/page-info.ts";
import type { UiContribution, UiPolicy } from "@heimdall/admin-contracts/ui.ts";
import type { SourceConfigSchema } from "@heimdall/admin-contracts/forms.ts";
import type { ConsoleSnapshot } from "@heimdall/admin-contracts/console.ts";
import {
    EMPTY_UI_CATALOG,
    type UiCatalog,
} from "@heimdall/admin-contracts/ui-catalog.ts";
import type { UiExtensionOptions } from "./extensions/bridge.ts";
import {
    clearAdminToken,
    type DashboardData,
    describeError,
    getAdminToken,
    loadDashboard,
    setAdminToken,
} from "./api/admin.ts";
export interface ConsoleProps {
    initial?: DashboardData;
    initialPanels?: Omit<ConsoleSnapshot, "dashboard">;
    page?: ConsolePage;
    tab?: string;
    contributions?: readonly UiContribution[];
    sourcePluginIds?: Readonly<Record<string, string>>;
    schemas?: Readonly<Record<string, SourceConfigSchema>>;
    presetPages?: Readonly<Record<string, string>>;
    policy?: UiPolicy;
    onAction?: UiExtensionOptions["onAction"];
    authenticated?: boolean;
    onConnect?: (token: string) => Promise<void>;
    onLogout?: () => Promise<void>;
    loadUiCatalog?: () => Promise<UiCatalog>;
}

function emptyDashboard(): DashboardData {
    return {
        health: {},
        models: [],
        status: { sources: [], plugins: [], managed: [], presets: [] },
        authRequired: false,
        errors: { health: "", models: "", status: "", presets: "", source: "" },
    };
}

function savedTheme(): "light" | "dark" {
    try {
        const saved = globalThis.localStorage?.getItem("heimdall.theme");
        if (saved === "light" || saved === "dark") return saved;
    } catch { /* Storage may be unavailable; follow the system preference. */ }
    return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
}

export function useConsoleState(
    {
        initial,
        authenticated = false,
        onConnect,
        onLogout,
        contributions = [],
        schemas = {},
        sourcePluginIds = {},
        presetPages = {},
        loadUiCatalog,
    }: ConsoleProps,
) {
    const [catalog, setCatalog] = useState<UiCatalog>({
        contributions,
        schemas,
        sourcePluginIds,
        presetPages,
    });
    const [dashboard, setDashboard] = useState(initial ?? emptyDashboard());
    const [loading, setLoading] = useState(!initial);
    const [refreshError, setRefreshError] = useState("");
    const [revision, setRevision] = useState(0);
    const [authOpen, setAuthOpen] = useState(false);
    const [authBusy, setAuthBusy] = useState(false);
    const [authError, setAuthError] = useState("");
    const [connected, setConnected] = useState(
        authenticated || Boolean(getAdminToken()),
    );
    const [source, setSource] = useState<
        { id: string; presetId?: string } | null
    >(null);
    const [adding, setAdding] = useState(false);
    const [theme, setTheme] = useState(savedTheme);
    const generation = useRef(0);
    async function refresh(options?: { silent?: boolean }) {
        const current = generation.current = (generation.current ?? 0) + 1;
        // Background polling must not flash the busy state or disable buttons.
        if (!options?.silent) setLoading(true);
        setRefreshError("");
        try {
            const [next, refreshedCatalog] = await Promise.all([
                loadDashboard(),
                loadUiCatalog?.().then(
                    (value) => ({ value, error: "" }),
                    (cause) => ({
                        value: undefined,
                        error: describeError(cause),
                    }),
                ),
            ]);
            if (current === generation.current) {
                setDashboard(next);
                if (next.authRequired) setCatalog(EMPTY_UI_CATALOG);
                else if (refreshedCatalog?.value) {
                    setCatalog(refreshedCatalog.value);
                } else if (refreshedCatalog?.error) {
                    setRefreshError(refreshedCatalog.error);
                }
                setRevision((value) => value + 1);
            }
        } catch (cause) {
            if (current === generation.current) {
                setRefreshError(describeError(cause));
            }
        } finally {
            if (current === generation.current) setLoading(false);
        }
    }

    useEffect(() => {
        if (!initial) void refresh();
        return () => {
            generation.current = (generation.current ?? 0) + 1;
        };
    }, []);

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        try {
            globalThis.localStorage?.setItem("heimdall.theme", theme);
        } catch { /* Optional preference. */ }
    }, [theme]);
    // The original console syncs theme switches across tabs instantly.
    useEffect(() => {
        const onStorage = (event: StorageEvent) => {
            if (
                event.key === "heimdall.theme" &&
                (event.newValue === "light" || event.newValue === "dark")
            ) setTheme(event.newValue);
        };
        globalThis.addEventListener("storage", onStorage);
        return () => globalThis.removeEventListener("storage", onStorage);
    }, []);

    async function connect(token: string) {
        if (authBusy) return;
        setAuthBusy(true);
        setAuthError("");
        try {
            if (onConnect) await onConnect(token);
            else {
                generation.current = (generation.current ?? 0) + 1;
                setAdminToken(token);
                setConnected(Boolean(getAdminToken()));
                const next = await loadDashboard();
                setDashboard(next);
                if (next.authRequired) setCatalog(EMPTY_UI_CATALOG);
                else if (loadUiCatalog) setCatalog(await loadUiCatalog());
                setLoading(false);
                setRevision((value) => value + 1);
                if (next.authRequired) throw new Error("令牌无效或已过期");
            }
            setConnected(true);
            setAuthOpen(false);
        } catch (cause) {
            setAuthError(describeError(cause));
        } finally {
            setAuthBusy(false);
        }
    }

    async function logout() {
        if (authBusy) return;
        setAuthBusy(true);
        setAuthError("");
        try {
            if (onLogout) await onLogout();
            else {
                clearAdminToken();
                setConnected(false);
                setSource(null);
                setAdding(false);
                setDashboard(emptyDashboard());
                setCatalog(EMPTY_UI_CATALOG);
                setAuthOpen(true);
                await refresh();
            }
        } catch (cause) {
            setAuthError(describeError(cause));
            setAuthOpen(true);
        } finally {
            setAuthBusy(false);
        }
    }

    return {
        ...catalog,
        dashboard,
        loading,
        refreshError,
        revision,
        authOpen,
        setAuthOpen,
        authBusy,
        authError,
        connected,
        source,
        setSource,
        adding,
        setAdding,
        theme,
        setTheme,
        refresh,
        connect,
        logout,
    };
}
