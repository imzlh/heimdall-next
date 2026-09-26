import type {
    CanonicalError,
    JsonValue,
    ResolvedSourceProxy,
} from "@heimdall/contracts";
import {
    Agent,
    type Dispatcher,
    fetch as directFetch,
    ProxyAgent,
    WebSocket as DirectWebSocket,
} from "undici";
import { rootCertificates } from "node:tls";

/** The optional SDK is used by willing plugins; the kernel does not call it. */
export interface SourceTransportOptions {
    readonly getProxy?: () => ResolvedSourceProxy;
    readonly fetch?: typeof fetch;
    /** Legacy plugin-owned client, used only without a host preference. */
    readonly client?: Deno.HttpClient;
    readonly secrets?: readonly (string | undefined)[];
    readonly signal?: AbortSignal;
}

export class SourceProxyError extends Error {
    override readonly name = "SourceProxyError";
    readonly code = "proxy_unavailable";
    readonly retryable = false;
    readonly status = 503;
}

/**
 * One operation owns one client. A saved host selection is a hint until a plugin
 * opts into this helper (or implements its own transport). Missing selections
 * never fall back to a different route here.
 */
export class SourceTransport implements Disposable, AsyncDisposable {
    readonly selection: ResolvedSourceProxy | undefined;
    readonly fetch: typeof fetch;
    readonly #secrets: readonly string[];
    readonly #signal: AbortSignal | undefined;
    readonly #abort = new AbortController();
    readonly #clients = new Map<string, Deno.HttpClient>();
    readonly #fallbackClient: Deno.HttpClient | undefined;
    readonly #sockets = new Set<SourceWebSocket>();
    #directAgent: Dispatcher | undefined;
    #closing: Promise<void> | undefined;
    #closed = false;

    constructor(options: SourceTransportOptions = {}) {
        options.signal?.throwIfAborted();
        this.selection = options.getProxy?.();
        this.#fallbackClient = options.client;
        this.#signal = options.signal;
        if (this.selection?.mode === "unavailable") {
            throw new SourceProxyError(
                this.selection.reason === "disabled"
                    ? "Selected proxy is disabled"
                    : "Selected proxy no longer exists",
            );
        }
        const credentials = this.selection?.mode === "proxy"
            ? this.selection.proxy.basicAuth
            : undefined;
        this.#secrets = secretVariants([
            ...options.secrets ?? [],
            credentials?.username,
            credentials?.password,
            credentials
                ? `${base64(`${credentials.username}:${credentials.password}`)}`
                : undefined,
        ]);
        const fetchImpl = options.fetch ?? fetch;
        this.fetch = async (input, init) => {
            if (this.#closed) {
                throw new Error("Source transport is closed");
            }
            const requestSignal = init?.signal ??
                (input instanceof Request ? input.signal : undefined);
            const signal = AbortSignal.any([
                this.#abort.signal,
                ...this.#signal ? [this.#signal] : [],
                ...requestSignal ? [requestSignal] : [],
            ]);
            const redirect = (init?.redirect ??
                    (input instanceof Request ? input.redirect : undefined)) ===
                    "manual"
                ? "manual"
                : "error";
            if (
                this.#usesDispatcher() &&
                options.fetch === undefined
            ) {
                // Dedicated Agents preserve TLS, explicit routing and proxy
                // credential boundaries without changing process defaults.
                const request = new Request(input, {
                    ...init,
                    signal,
                    redirect,
                });
                const response = await directFetch(request.url, {
                    dispatcher: this.#agent(),
                    method: request.method,
                    headers: [...request.headers],
                    body: request.body,
                    duplex: "half",
                    signal,
                    redirect,
                });
                return responseForDeno(response as unknown as Response, signal);
            }
            const client = this.#clientFor(
                input instanceof Request ? input.url : input,
            );
            // Without the host hook, leave routing and redirect policy to the
            // existing fetch implementation. Operation ownership still applies.
            if (client === undefined) {
                return await fetchImpl(input, { ...init, signal });
            }
            return await fetchImpl(input, {
                ...init,
                client,
                redirect,
                signal,
            });
        };
        this.#signal?.addEventListener("abort", this.close, { once: true });
    }

    /**
     * Native clients exist for SOCKS and legacy plugin overrides. HTTP(S)
     * proxy and direct routing use fetch()/webSocket() to preserve TLS and
     * keep proxy authorization out of the upstream's encrypted request.
     */
    #clientFor(input: string | URL): Deno.HttpClient | undefined {
        if (this.#closed) throw new Error("Source transport is closed");
        if (this.selection === undefined) return this.#fallbackClient;
        const url = new URL(input);
        if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
            throw new TypeError(
                "Source transport requires an HTTP or WebSocket URL",
            );
        }
        const selection = this.selection;
        if (this.#usesDispatcher()) return undefined;
        if (selection.mode === "unavailable") {
            throw new SourceProxyError("Selected proxy is unavailable");
        }
        if (selection.mode !== "proxy") return undefined;
        const key = "proxy";
        const existing = this.#clients.get(key);
        if (existing) return existing;
        try {
            const client = Deno.createHttpClient({
                proxy: {
                    url: selection.proxy.url,
                    ...(selection.proxy.basicAuth
                        ? { basicAuth: selection.proxy.basicAuth }
                        : {}),
                },
                poolMaxIdlePerHost: 0,
            });
            this.#clients.set(key, client);
            return client;
        } catch {
            // Native errors may embed connection URLs or proxy credentials.
            throw new SourceProxyError(
                "Selected proxy transport could not be created",
            );
        }
    }

    #usesDispatcher(): boolean {
        return this.selection?.mode === "direct" ||
            (this.selection?.mode === "proxy" &&
                new URL(this.selection.proxy.url).protocol !== "socks5:" &&
                new URL(this.selection.proxy.url).protocol !== "socks5h:");
    }

    #agent(): Dispatcher {
        if (this.#closed) throw new Error("Source transport is closed");
        if (this.#directAgent) return this.#directAgent;
        // Deno's node:tls does not automatically load the Deno trust bundle.
        // Keep explicit deployment CAs additive and certificate checks enabled.
        const caPath = Deno.env.get("DENO_CERT") ??
            Deno.env.get("NODE_EXTRA_CA_CERTS");
        const tls = caPath
            ? { ca: [...rootCertificates, Deno.readTextFileSync(caPath)] }
            : {};
        if (this.selection?.mode === "proxy") {
            const credentials = this.selection.proxy.basicAuth;
            return this.#directAgent = new ProxyAgent({
                uri: this.selection.proxy.url,
                proxyTunnel: false,
                requestTls: tls,
                proxyTls: tls,
                ...(credentials
                    ? {
                        token: `Basic ${
                            base64(
                                `${credentials.username}:${credentials.password}`,
                            )
                        }`,
                    }
                    : {}),
            });
        }
        return this.#directAgent = new Agent({ connect: tls });
    }

    webSocket(url: string): SourceWebSocket {
        if (this.#closed) throw new Error("Source transport is closed");
        const socket: SourceWebSocket = this.#usesDispatcher()
            ? new DirectWebSocket(url, { dispatcher: this.#agent() })
            : new NativeWebSocket(url, { client: this.#clientFor(url) });
        this.#sockets.add(socket);
        socket.addEventListener("close", () => this.#sockets.delete(socket), {
            once: true,
        });
        return socket;
    }

    /** Safe provider diagnostics, including nested details and encoded secrets. */
    redactError(error: CanonicalError): CanonicalError {
        return {
            ...error,
            code: this.redact(error.code),
            message: this.redact(error.message),
            ...(error.providerCode === undefined ? {} : {
                providerCode: this.redact(error.providerCode),
            }),
            ...(error.details === undefined ? {} : {
                details: redactJson(
                    error.details,
                    (value) => this.redact(value),
                ),
            }),
        };
    }

    redact(value: string): string {
        for (const secret of this.#secrets) {
            value = value.replaceAll(secret, "[redacted]");
        }
        return value;
    }

    readonly close = (): Promise<void> => {
        if (this.#closed) return this.#closing ?? Promise.resolve();
        this.#closed = true;
        this.#signal?.removeEventListener("abort", this.close);
        this.#abort.abort();
        for (const socket of this.#sockets) {
            if (socket.readyState <= 1) socket.close(1000, "transport closed");
        }
        this.#sockets.clear();
        for (const client of this.#clients.values()) client.close();
        this.#clients.clear();
        return this.#closing = this.#directAgent?.destroy() ??
            Promise.resolve();
    };

    [Symbol.dispose](): void {
        void this.close();
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }
}

/** DOM-compatible socket surface shared by native Deno and direct Undici. */
export interface SourceWebSocket extends EventTarget {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}

const NativeWebSocket = WebSocket as unknown as {
    new (url: string, options: { client?: Deno.HttpClient }): WebSocket;
};

/** Bridge Undici's response lifetime to Deno's native Web Streams and signals. */
function responseForDeno(response: Response, signal: AbortSignal): Response {
    if (!response.body) return response;
    const reader = response.body.getReader();
    let finished = false;
    let onAbort: () => void;
    const detach = () => {
        finished = true;
        signal.removeEventListener("abort", onAbort);
    };
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            onAbort = () => {
                if (finished) return;
                detach();
                controller.error(signal.reason);
                void reader.cancel(signal.reason).catch(() => {});
            };
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
        },
        async pull(controller) {
            if (finished) return;
            try {
                const result = await reader.read();
                if (finished) return;
                if (result.done) {
                    detach();
                    controller.close();
                    reader.releaseLock();
                } else controller.enqueue(result.value);
            } catch (error) {
                if (!finished) {
                    detach();
                    controller.error(error);
                }
            }
        },
        cancel(reason) {
            detach();
            return reader.cancel(reason);
        },
    });
    const result = new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
    Object.defineProperties(result, {
        url: { value: response.url },
        redirected: { value: response.redirected },
        type: { value: response.type },
    });
    return result;
}

function secretVariants(values: readonly (string | undefined)[]): string[] {
    const secrets = new Set<string>();
    for (const value of values) {
        if (!value) continue;
        secrets.add(value);
        secrets.add(encodeURIComponent(value));
    }
    return [...secrets].sort((left, right) => right.length - left.length);
}

function base64(value: string): string {
    let binary = "";
    for (const byte of new TextEncoder().encode(value)) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function redactJson(
    value: JsonValue,
    redact: (value: string) => string,
): JsonValue {
    if (typeof value === "string") return redact(value);
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
        return value.map((item) => redactJson(item, redact));
    }
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
            redact(key),
            redactJson(item, redact),
        ]),
    );
}
