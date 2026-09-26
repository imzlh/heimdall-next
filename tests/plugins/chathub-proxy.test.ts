import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type {
    ApiRequestContext,
    GenerationRequest,
    OperationRequest,
    ResolvedSourceProxy,
    StreamEvent,
} from "@heimdall/contracts";
import { createChatHubSource } from "../../plugins/chathub-source/mod.ts";
import authPlugin, {
    createChatHubAuthPlugin,
} from "../../plugins/chathub-auth/mod.ts";
import { CHATHUB_TOKEN_URL } from "../../plugins/chathub-source/auth.ts";
import { encodeRecord } from "../../plugins/chathub-source/protocol/codec.ts";
import { RECORD_SEPARATOR } from "../../plugins/chathub-source/protocol/constants.ts";
import { MEMORY_OFF_DIRECTIVE } from "../../plugins/chathub-source/tools.ts";
import type { WebSocketLike } from "../../plugins/chathub-source/protocol/types.ts";

const direct: ResolvedSourceProxy = { mode: "direct", selectedBy: "source" };
const proxy: ResolvedSourceProxy = {
    mode: "proxy",
    selectedBy: "source",
    proxy: {
        id: "proxy-a",
        name: "代理 A",
        url: "http://127.0.0.1:8081",
        basicAuth: {
            username: "proxy-user",
            password: "proxy-password-secret",
        },
    },
};
const config = {
    id: "chathub",
    oid: "account-id",
    tid: "tenant-id",
    accessToken: "access-token-secret",
    endpoint: "wss://chathub.invalid/Chathub",
    models: ["test-model"],
};
const input: OperationRequest<GenerationRequest> = {
    version: 1,
    requestId: "chathub-proxy-test",
    operation: "generation.create",
    traits: {},
    payload: {
        model: "test-model",
        messages: [{
            id: "user-1",
            role: "user",
            parts: [{ id: "text-1", type: "text", text: "你好" }],
        }],
    },
};

async function run(
    source: ReturnType<typeof createChatHubSource>,
    signal = new AbortController().signal,
    request = input,
): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (
        const frame of source.execute(request, {
            requestId: request.requestId,
            signal,
            metadata: {},
        })
    ) events.push(frame.event);
    return events;
}

class ScriptedSocket extends EventTarget implements WebSocketLike {
    readyState = 0;
    #sends = 0;
    constructor() {
        super();
        queueMicrotask(() => {
            if (this.readyState !== 0) return;
            this.readyState = 1;
            this.dispatchEvent(new Event("open"));
        });
    }
    send(): void {
        const data = ++this.#sends === 1 ? encodeRecord({}) : encodeRecord({
            type: 2,
            item: { messages: [{ author: "bot", text: "你好" }] },
        }) + encodeRecord({ type: 3 });
        queueMicrotask(() => {
            if (this.readyState !== 1) return;
            this.dispatchEvent(new MessageEvent("message", { data }));
        });
    }
    close(): void {
        this.readyState = 3;
    }
}

/** Observe ownership while retaining native clients and Deno's resource checks. */
function monitorClients() {
    const original = Deno.createHttpClient;
    const clients: {
        client: Deno.HttpClient;
        options: Deno.CreateHttpClientOptions;
        closed: boolean;
    }[] = [];
    Deno.createHttpClient = (options) => {
        const client = original(options);
        const record = { client, options, closed: false };
        const close = client.close.bind(client);
        client.close = () => {
            record.closed = true;
            close();
        };
        clients.push(record);
        return client;
    };
    return {
        clients,
        [Symbol.dispose]() {
            Deno.createHttpClient = original;
            for (const item of clients) {
                if (!item.closed) item.client.close();
            }
        },
    };
}

Deno.test("ChatHub adopts fresh proxy choices per turn without discarding its warm session", async () => {
    let selection: ResolvedSourceProxy = direct;
    let lookups = 0;
    const sockets: ScriptedSocket[] = [];
    const clients: (Deno.HttpClient | undefined)[] = [];
    const urls: URL[] = [];
    const source = createChatHubSource(config, {
        getProxy: () => {
            lookups++;
            return selection;
        },
        webSocketFactory(url, client) {
            urls.push(new URL(url));
            clients.push(client);
            const socket = new ScriptedSocket();
            sockets.push(socket);
            return socket;
        },
    });
    const conversation = {
        ...input,
        payload: {
            ...input.payload,
            metadata: { conversationId: "stable-session" },
        },
    };
    assertEquals(
        (await run(source, undefined, conversation)).at(-1)?.kind,
        "run.completed",
    );
    selection = proxy;
    const followup: OperationRequest<GenerationRequest> = {
        ...conversation,
        payload: {
            ...conversation.payload,
            messages: [
                ...conversation.payload.messages,
                {
                    id: "assistant-1",
                    role: "assistant",
                    parts: [{ id: "answer-1", type: "text", text: "你好" }],
                },
                {
                    id: "user-2",
                    role: "user",
                    parts: [{ id: "text-2", type: "text", text: "继续" }],
                },
            ],
        },
    };
    assertEquals(
        (await run(source, undefined, followup)).at(-1)?.kind,
        "run.completed",
    );
    assertEquals(lookups, 2);
    // Custom factories own their networking. HTTP proxy and direct requests
    // use SDK dispatchers, so they have no native Deno client to inherit.
    assertEquals(clients, [undefined, undefined]);
    assert(sockets.every((socket) => socket.readyState === 3));
    assertEquals(
        urls[0]!.searchParams.get("ConversationId"),
        urls[1]!.searchParams.get("ConversationId"),
    );
    assertEquals(
        urls[0]!.searchParams.get("X-SessionId"),
        urls[1]!.searchParams.get("X-SessionId"),
    );
    assert(
        urls[0]!.searchParams.get("chatsessionid") !==
            urls[1]!.searchParams.get("chatsessionid"),
    );
});

Deno.test("ChatHub without the host hook keeps the caller-owned client", async () => {
    using monitored = monitorClients();
    const client = Deno.createHttpClient({});
    let received: Deno.HttpClient | undefined;
    const source = createChatHubSource(config, {
        httpClient: client,
        webSocketFactory(_url, httpClient) {
            received = httpClient;
            return new ScriptedSocket();
        },
    });
    assertEquals((await run(source)).at(-1)?.kind, "run.completed");
    assertEquals(received, client);
    assertEquals(monitored.clients.length, 1);
    assertEquals(monitored.clients[0]!.closed, false);
});

Deno.test("ChatHub unavailable selection fails before opening a socket", async () => {
    let sockets = 0;
    const source = createChatHubSource(config, {
        getProxy: () => ({
            mode: "unavailable",
            selectedBy: "source",
            proxyId: "removed",
            reason: "missing",
        }),
        webSocketFactory() {
            sockets++;
            return new ScriptedSocket();
        },
    });
    const failure = (await run(source)).at(-1);
    assertEquals(failure?.kind, "run.error");
    assert(failure?.kind === "run.error");
    assertEquals(failure.error.code, "proxy_unavailable");
    assertEquals(sockets, 0);
});

Deno.test("ChatHub redacts proxy credentials before truncating websocket errors", async () => {
    const password = proxy.proxy.basicAuth!.password;
    const source = createChatHubSource(config, {
        getProxy: () => proxy,
        webSocketFactory() {
            throw new Error("x".repeat(506) + password);
        },
    });
    const failure = (await run(source)).at(-1);
    assert(failure?.kind === "run.error");
    assertEquals(failure.error.message, "x".repeat(506) + "[redac");
    assertEquals(failure.error.message.includes(password.slice(0, 6)), false);
});

Deno.test("ChatHub treats empty websocket TypeErrors as upstream connection failures", async () => {
    const source = createChatHubSource(config, {
        webSocketFactory() {
            const socket = new ScriptedSocket();
            queueMicrotask(() =>
                socket.dispatchEvent(
                    new ErrorEvent("error", { error: new TypeError() }),
                )
            );
            return socket;
        },
    });
    const failure = (await run(source)).at(-1);
    assert(failure?.kind === "run.error");
    assertEquals(failure.error.code, "upstream_error");
    assertEquals(failure.error.retryable, true);
    assertEquals(failure.error.message, "ChatHub WebSocket error");
});

Deno.test("ChatHub abort closes a connecting socket", async () => {
    const abort = new AbortController();
    const socket = new class extends EventTarget implements WebSocketLike {
        readyState = 0;
        send() {}
        close() {
            this.readyState = 3;
        }
    }();
    const source = createChatHubSource(config, {
        getProxy: () => proxy,
        webSocketFactory() {
            queueMicrotask(() => abort.abort());
            return socket;
        },
    });
    assertEquals(
        (await run(source, abort.signal)).at(-1)?.kind,
        "run.cancelled",
    );
    assertEquals(socket.readyState, 3);
});

Deno.test("ChatHub catches a synchronous abort during socket creation", async () => {
    const abort = new AbortController();
    const socket = new ScriptedSocket();
    const source = createChatHubSource(config, {
        getProxy: () => proxy,
        webSocketFactory() {
            abort.abort();
            return socket;
        },
    });
    assertEquals(
        (await run(source, abort.signal)).at(-1)?.kind,
        "run.cancelled",
    );
    assertEquals(socket.readyState, 3);
});

Deno.test("ChatHub renewal owns its transport and survives another caller abort", async () => {
    const started = Promise.withResolvers<void>();
    const renewed = Promise.withResolvers<Response>();
    const abort = new AbortController();
    let refreshCalls = 0;
    let refreshSignal: AbortSignal | undefined;
    const fetchTokens: typeof fetch = (url, init) => {
        assertEquals(url, CHATHUB_TOKEN_URL);
        refreshCalls++;
        refreshSignal = init?.signal ?? undefined;
        started.resolve();
        return renewed.promise;
    };
    const source = createChatHubSource({
        ...config,
        refreshToken: "refresh-token-secret",
        expiresAt: "2020-01-01T00:00:00Z",
    }, {
        getProxy: () => proxy,
        fetch: fetchTokens,
        webSocketFactory: () => new ScriptedSocket(),
    });
    const first = run(source, abort.signal);
    await started.promise;
    const second = run(source);
    abort.abort();
    assertEquals((await first).at(-1)?.kind, "run.cancelled");
    assertEquals(refreshSignal?.aborted, false);
    renewed.resolve(Response.json({
        access_token: "header." +
            btoa(
                JSON.stringify({
                    oid: config.oid,
                    tid: config.tid,
                    exp: 4_000_000_000,
                }),
            ) + ".signature",
        refresh_token: "new-refresh-token",
    }));
    assertEquals((await second).at(-1)?.kind, "run.completed");
    assertEquals(refreshCalls, 1);
    assertEquals(refreshSignal?.aborted, true);
});

function authContext(
    body: Record<string, unknown>,
    resolveProxy: ApiRequestContext["resolveProxy"] = () => proxy,
): ApiRequestContext {
    return {
        requestId: "auth-proxy-test",
        route: authPlugin.manifest.routes![0]!,
        signal: new AbortController().signal,
        request: new Request("http://localhost/admin/plugins/chathub/auth", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        }),
        resolveProxy,
    };
}

Deno.test("ChatHub authorization exchange and refresh adopt the selected proxy", async () => {
    const requests: {
        signal: AbortSignal | undefined;
        form: URLSearchParams;
    }[] = [];
    const token = "header." + btoa(JSON.stringify({
        oid: config.oid,
        tid: config.tid,
        exp: 4_000_000_000,
    })) + ".signature";
    const plugin = createChatHubAuthPlugin({
        fetch: (url, init) => {
            assertEquals(url, CHATHUB_TOKEN_URL);
            assertEquals(init?.redirect, "error");
            requests.push({
                signal: init?.signal ?? undefined,
                form: new URLSearchParams(String(init?.body)),
            });
            return Promise.resolve(Response.json({ access_token: token }));
        },
    });
    const start = await plugin.handle(authContext({ action: "start" }));
    const login = await start.json();
    assertEquals(requests.length, 0);
    for (const action of ["exchange", "refresh"]) {
        const choice = { mode: "proxy", proxyId: "proxy-a" } as const;
        const response = await plugin.handle(authContext({
            action,
            proxy: choice,
            state: login.state,
            callback: "one-time-code",
            refreshToken: "refresh-token-secret",
        }, (selection) => {
            assertEquals(selection, choice);
            return proxy;
        }));
        assertEquals(response.status, 200);
        assertEquals((await response.json()).accessToken, token);
    }
    assertEquals(
        requests.map((request) => request.form.get("grant_type")),
        [
            "authorization_code",
            "refresh_token",
        ],
    );
    assert(requests.every((request) => request.signal?.aborted));
});

Deno.test("ChatHub OAuth errors redact proxy secrets before diagnostic truncation", async () => {
    const password = proxy.proxy.basicAuth!.password;
    const plugin = createChatHubAuthPlugin({
        fetch: () =>
            Promise.resolve(Response.json({
                error: "invalid_grant",
                error_description: "x".repeat(275) + password,
            }, { status: 400 })),
    });
    const response = await plugin.handle(authContext({
        action: "refresh",
        refreshToken: "refresh-token-secret",
    }));
    assertEquals(response.status, 400);
    const result = await response.json();
    assertStringIncludes(result.error, "invalid_grant");
    assertEquals(result.error.includes(password.slice(0, 6)), false);
    assertStringIncludes(result.error, "[redacted]");
});

Deno.test("ChatHub direct WebSocket completes on loopback", async () => {
    let received = 0;
    const closed = Promise.withResolvers<void>();
    const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        (request) => {
            received++;
            const { response, socket } = Deno.upgradeWebSocket(request);
            let handshake = false;
            socket.onmessage = () => {
                if (!handshake) {
                    handshake = true;
                    socket.send(encodeRecord({}));
                } else {
                    socket.send(
                        encodeRecord({
                            type: 2,
                            item: {
                                messages: [{
                                    author: "bot",
                                    text: "local answer",
                                }],
                            },
                        }) + encodeRecord({ type: 3 }),
                    );
                }
            };
            socket.onclose = () => closed.resolve();
            return response;
        },
    );
    try {
        const source = createChatHubSource({
            ...config,
            endpoint: `ws://127.0.0.1:${server.addr.port}/Chathub`,
        }, { getProxy: () => direct });
        const events = await run(source, AbortSignal.timeout(2000));
        assertEquals(events.at(-1)?.kind, "run.completed");
        assertEquals(received, 1);
        assert(
            events.some((event) =>
                event.kind === "part.delta" && event.delta === "local answer"
            ),
        );
        await closed.promise;
    } finally {
        await server.shutdown();
    }
});

Deno.test("ChatHub direct WSS retains TLS and ignores the process proxy", async () => {
    const fixtures = new URL("../fixtures/source-transport/", import.meta.url);
    const certPath = new URL("localhost-cert.pem", fixtures);
    const [cert, key] = await Promise.all([
        Deno.readTextFile(certPath),
        Deno.readTextFile(new URL("localhost-key.pem", fixtures)),
    ]);
    let received = 0;
    const sockets = new Set<WebSocket>();
    const server = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        cert,
        key,
        onListen() {},
    }, (request) => {
        received++;
        const { response, socket } = Deno.upgradeWebSocket(request);
        sockets.add(socket);
        let handshake = false;
        socket.onmessage = () => {
            if (!handshake) {
                handshake = true;
                socket.send(encodeRecord({}));
            } else {
                socket.send(
                    encodeRecord({
                        type: 2,
                        item: {
                            messages: [{ author: "bot", text: "TLS answer" }],
                        },
                    }) + encodeRecord({ type: 3 }),
                );
            }
        };
        socket.onclose = () => sockets.delete(socket);
        return response;
    });
    try {
        const sourceModule =
            new URL("../../plugins/chathub-source/mod.ts", import.meta.url)
                .href;
        const sourceConfig = {
            ...config,
            endpoint: `wss://127.0.0.1:${server.addr.port}/Chathub`,
        };
        const script = `
            import { createChatHubSource } from ${JSON.stringify(sourceModule)};
            const source = createChatHubSource(${
            JSON.stringify(sourceConfig)
        }, {
                getProxy: () => ({ mode: "direct", selectedBy: "source" }),
            });
            const events = [];
            for await (const frame of source.execute(${JSON.stringify(input)}, {
                requestId: "tls-test", signal: AbortSignal.timeout(5000), metadata: {},
            })) events.push(frame.event);
            console.log(JSON.stringify(events));
        `;
        const certFile = decodeURIComponent(certPath.pathname).replace(
            /^\/([A-Za-z]:\/)/,
            "$1",
        );
        const result = await new Deno.Command(Deno.execPath(), {
            args: ["eval", "--quiet", "--cached-only", script],
            env: {
                DENO_CERT: certFile,
                NODE_EXTRA_CA_CERTS: certFile,
                HTTP_PROXY: "http://127.0.0.1:65534",
                HTTPS_PROXY: "http://127.0.0.1:65534",
                ALL_PROXY: "http://127.0.0.1:65534",
                NO_PROXY: "",
            },
            stdout: "piped",
            stderr: "piped",
        }).output();
        assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
        const events = JSON.parse(
            new TextDecoder().decode(result.stdout),
        ) as StreamEvent[];
        assertEquals(
            events.at(-1)?.kind,
            "run.completed",
            new TextDecoder().decode(result.stderr) + JSON.stringify(events),
        );
        assert(
            events.some((event) =>
                event.kind === "part.delta" && event.delta === "TLS answer"
            ),
        );
        assertEquals(received, 1);
    } finally {
        for (const socket of sockets) socket.close();
        await server.shutdown();
    }
});

Deno.test("ChatHub proxied WebSocket sends CONNECT through the selected proxy and aborts its handshake", async () => {
    const server = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const abort = new AbortController();
    let request = "";
    const incoming = (async () => {
        try {
            using connection = await server.accept();
            const bytes = new Uint8Array(8192);
            while (!request.includes("\r\n\r\n")) {
                const size = await connection.read(bytes);
                if (size === null) break;
                request += new TextDecoder().decode(bytes.subarray(0, size));
            }
            abort.abort();
        } catch (error) {
            if (!(error instanceof Deno.errors.BadResource)) throw error;
        }
    })();
    try {
        const source = createChatHubSource({
            ...config,
            endpoint: "wss://127.0.0.1:65534/Chathub",
        }, {
            getProxy: () => ({
                ...proxy,
                proxy: {
                    ...proxy.proxy,
                    url: `http://127.0.0.1:${server.addr.port}`,
                },
            }),
        });
        const events = await run(
            source,
            AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]),
        );
        assertStringIncludes(request, "CONNECT 127.0.0.1:65534 HTTP/1.1");
        assertStringIncludes(
            request.toLowerCase(),
            ("proxy-authorization: Basic " +
                btoa(
                    `${proxy.proxy.basicAuth!.username}:${
                        proxy.proxy.basicAuth!.password
                    }`,
                )).toLowerCase(),
        );
        assertEquals(events.at(-1)?.kind, "run.cancelled");
    } finally {
        server.close();
        await incoming;
    }
});

Deno.test("ChatHub disables memory per turn and instructs the model to ignore it", async () => {
    let chatUrl: URL | undefined;
    let chatText: string | undefined;
    const source = createChatHubSource(config, {
        getProxy: () => direct,
        webSocketFactory(url) {
            chatUrl = new URL(url);
            const socket = new class extends EventTarget
                implements WebSocketLike {
                readyState = 0;
                #sends = 0;
                constructor() {
                    super();
                    queueMicrotask(() => {
                        this.readyState = 1;
                        this.dispatchEvent(new Event("open"));
                    });
                }
                send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
                    if (++this.#sends === 1) {
                        queueMicrotask(() =>
                            this.dispatchEvent(
                                new MessageEvent("message", {
                                    data: encodeRecord({}),
                                }),
                            )
                        );
                        return;
                    }
                    // Pull the chat frame's user message text out of the payload.
                    for (const record of String(data).split(RECORD_SEPARATOR)) {
                        if (!record) continue;
                        const frame = JSON.parse(record);
                        if (frame.target === "chat") {
                            chatText = frame.arguments?.[0]?.message?.text;
                        }
                    }
                    queueMicrotask(() =>
                        this.dispatchEvent(
                            new MessageEvent("message", {
                                data: encodeRecord({
                                    type: 2,
                                    item: {
                                        messages: [{
                                            author: "bot",
                                            text: "ok",
                                        }],
                                    },
                                }) + encodeRecord({ type: 3 }),
                            }),
                        )
                    );
                }
                close() {
                    this.readyState = 3;
                }
            }();
            return socket;
        },
    });
    const events = await run(source);
    assertEquals(events.at(-1)?.kind, "run.completed");
    // Session-level memory block rides the connection URL.
    assertEquals(chatUrl?.searchParams.get("disableMemory"), "1");
    // The turn text leads with the memory-off directive.
    assert(chatText !== undefined, "chat frame carried no user text");
    assertStringIncludes(chatText, MEMORY_OFF_DIRECTIVE);
});
