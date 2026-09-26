/** These wire DTOs contain no proxy credentials when returned by the host. */
export interface ProxyEntryView {
    readonly id: string;
    readonly name: string;
    readonly url: string;
    readonly enabled: boolean;
    readonly authConfigured: boolean;
}

export interface ProxyPoolView {
    /** Null means the global outbound preference is a direct connection. */
    readonly defaultProxyId: string | null;
    readonly entries: readonly ProxyEntryView[];
}

export interface ProxyPoolInput {
    readonly defaultProxyId: string | null;
    readonly entries: readonly {
        readonly id: string;
        readonly name: string;
        readonly url: string;
        readonly enabled: boolean;
        /** Omit to keep this ID's stored credentials; null removes them. */
        readonly basicAuth?: {
            readonly username: string;
            readonly password: string;
        } | null;
    }[];
}

/** Host metadata, separate from a source plugin's provider configuration. */
export type SourceProxySelection =
    | { readonly mode: "inherit" }
    | { readonly mode: "direct" }
    | { readonly mode: "proxy"; readonly proxyId: string };

/** Safe for SSR, UI slot contexts and the management API. */
export interface SourceProxySummary {
    readonly mode: "direct" | "proxy" | "unavailable";
    readonly selectedBy: "global" | "source";
    readonly proxyId?: string;
    readonly name?: string;
    readonly reason?: "missing" | "disabled";
}
