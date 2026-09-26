/** Host-owned outbound proxy choice. Providers decide whether to use it. */
export type SourceProxySelection =
    | { readonly mode: "inherit" }
    | { readonly mode: "direct" }
    | { readonly mode: "proxy"; readonly proxyId: string };

/**
 * A fresh, JSON-serializable snapshot for a source plugin. Credentials belong
 * only at this trusted execution boundary, never in operator or UI context DTOs.
 * The host does not intercept plugin network traffic or enforce this choice.
 */
export type ResolvedSourceProxy =
    | { readonly mode: "direct"; readonly selectedBy: "global" | "source" }
    | {
        readonly mode: "proxy";
        readonly selectedBy: "global" | "source";
        readonly proxy: {
            readonly id: string;
            readonly name: string;
            readonly url: string;
            readonly basicAuth?: {
                readonly username: string;
                readonly password: string;
            };
        };
    }
    | {
        readonly mode: "unavailable";
        readonly selectedBy: "global" | "source";
        readonly proxyId: string;
        readonly reason: "missing" | "disabled";
    };
