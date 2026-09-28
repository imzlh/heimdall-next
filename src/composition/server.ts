import { createServerApp, type ServerAppOptions } from "../http/app.ts";
import type { ModelsResponse } from "../http/public-routes.ts";
import { createProtocolRoutes } from "../http/protocol-routes.ts";
import { createChatRoutes } from "../http/chat-routes.ts";
import { createChatAssetLinkRoutes } from "../http/chat-asset-routes.ts";
import type { ChatAssetService } from "../chat/assets.ts";
import type { ChatStore } from "@heimdall/storage";
import type { ChatToolProvider } from "../chat/tools/toolset.ts";
import type { InferenceSource, ProtocolPlugin } from "@heimdall/contracts";
import {
    createKernelRuntime,
    type KernelRuntime,
    type LifecyclePort,
    type MiddlewareRegistry,
    ProtocolRegistry,
    SourceRegistry,
} from "@heimdall/kernel";

export interface ServerOptions extends ServerAppOptions {
    /** Protocol plugins assembled by the host. Defaults to none. */
    readonly protocols?: readonly ProtocolPlugin[];
    /** Upstream sources assembled by the host. Defaults to none. */
    readonly sources?: readonly InferenceSource[];
    /** Reuse a live registry so management writes affect execution immediately. */
    readonly sourceRegistry?: SourceRegistry;
    /** Live global HIP middleware assembled by the host. */
    readonly middleware?: MiddlewareRegistry;
    /** Optional pre-assembled kernel for embedding applications. */
    readonly kernel?: KernelRuntime;
    /**
     * Records HIP lifecycle events. Ignored when `kernel` is already assembled,
     * because that kernel owns its own lifecycle port.
     */
    readonly lifecycle?: LifecyclePort;
    /** Chat history. Generation uses the same kernel as `/v1`. */
    readonly chat?: {
        readonly store: ChatStore;
        readonly assets?: ChatAssetService;
        /** Tool capabilities supplied by the embedding composition. */
        readonly tools?: ChatToolProvider;
        /** Cheap model id for auto-titling; undefined falls back to the chat model. */
        readonly titleModel?: () => string | undefined;
    };
}

/** Compose a Hono application without starting a process or opening storage. */
export function createServer(options: ServerOptions = {}) {
    const {
        protocols = [],
        sources = [],
        sourceRegistry: injectedSourceRegistry,
        middleware,
        kernel,
        lifecycle,
        chat,
        ...httpOptions
    } = options;
    if (httpOptions.publicRoutes !== undefined) {
        return createServerApp(httpOptions);
    }
    const protocolRegistry = new ProtocolRegistry();
    for (const plugin of protocols) protocolRegistry.register(plugin);
    const sourceRegistry = injectedSourceRegistry ?? new SourceRegistry();
    for (const source of sources) {
        if (injectedSourceRegistry?.get(source.id) !== undefined) continue;
        sourceRegistry.register(source);
    }
    const runtime = kernel ?? createKernelRuntime({
        sources: sourceRegistry,
        middleware,
        lifecycle,
    });

    return createServerApp({
        ...httpOptions,
        models: httpOptions.models ?? (() => modelsResponse(sourceRegistry)),
        protocolRoutes: httpOptions.protocolRoutes ?? createProtocolRoutes({
            protocols: protocolRegistry.list(),
            runtime,
        }),
        chatAssetLinkRoutes: chat?.assets
            ? createChatAssetLinkRoutes(chat.assets)
            : httpOptions.chatAssetLinkRoutes,
        chatRoutes: chat === undefined
            ? httpOptions.chatRoutes
            : createChatRoutes({
                runtime,
                store: chat.store,
                assets: chat.assets,
                tools: chat.tools,
                titleModel: chat.titleModel,
            }),
    });
}

function modelsResponse(sources: SourceRegistry): ModelsResponse {
    return {
        object: "list",
        data: sources.listModels().map(({ id }) => ({
            id,
            object: "model" as const,
            created: 0,
            owned_by: "heimdall",
        })),
    };
}
