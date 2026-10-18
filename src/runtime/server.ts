import { openSqliteChatStore } from "../storage/sqlite-chat.ts";
import { openSqliteChatAssetStore } from "../storage/sqlite-assets.ts";
import { ChatAssetService } from "../chat/assets.ts";
import { openSqliteRequestStore } from "../storage/sqlite-requests.ts";
import { DenoKvConfigStore } from "../storage/deno-kv.ts";
import { loadBuiltinComposition } from "../composition/builtins.ts";
import { apiPluginTarget } from "../http/manifest-routes.ts";
import { loadRuntimeUiContributions } from "../composition/ui-contributions.ts";
import { loadSourceSchemas } from "../composition/source-schemas.ts";
import { loadUiPolicy } from "../composition/ui-policy.ts";
import {
    loadPresetPages,
    withBuiltinPresetPages,
} from "../composition/preset-pages.ts";
import type { UiActionRegistry } from "../web/server/ui-actions.ts";
import { createServer, type ServerOptions } from "../composition/server.ts";
import { createRequestLifecycle } from "../composition/request-lifecycle.ts";
import { createRuntimeSettings } from "../composition/runtime-settings.ts";
import { startBackgroundTasks } from "../composition/background-tasks.ts";
import {
    type RetentionRuntime,
    startRetentionMaintenance,
} from "../composition/retention-runtime.ts";
import {
    readServerEnvironment,
    type ServerEnvironment,
} from "../composition/runtime-env.ts";
import { log, systemLog } from "../observability/system-log.ts";

export interface RuntimeOptions {
    readonly environment?: ServerEnvironment;
    /** Override the environment's listen address for an embedding host. */
    readonly hostname?: string;
    /** Zero asks the OS for an available port. */
    readonly port?: number;
    /** Abort immediately, including any open HTTP connections. */
    readonly signal?: AbortSignal;
    /** Called once storage, plugins, and the HTTP listener are ready. */
    readonly onListen?: (address: Deno.NetAddr) => void;
    readonly adminUiActions?: UiActionRegistry;
    /** Native host bootstrap and origin policy; requires loopback and admin auth. */
    readonly desktopSession?: ServerOptions["desktopSession"];
    /** Grace period for active requests before close aborts them; default 5000. */
    readonly shutdownTimeoutMs?: number;
}

/** An owned application instance. Both close and finished include resource cleanup. */
export interface RunningRuntime extends AsyncDisposable {
    readonly address: Deno.NetAddr;
    /** HTTP origin with the actual bound port, including when port was zero. */
    readonly url: string;
    readonly finished: Promise<void>;
    close(): Promise<void>;
}

/**
 * Start one application without taking over the process or registering signals.
 * Importing this module never opens storage or listens on a port.
 */
export async function startRuntime(
    options: RuntimeOptions = {},
): Promise<RunningRuntime> {
    options.signal?.throwIfAborted();
    const environment = options.environment ?? readServerEnvironment();
    const hostname = options.hostname ?? environment.hostname;
    const port = options.port ?? environment.port;
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new RangeError("runtime port must be an integer from 0 to 65535");
    }
    if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 0) {
        throw new RangeError(
            "shutdownTimeoutMs must be a non-negative integer",
        );
    }
    if (options.desktopSession !== undefined) {
        if (hostname !== "127.0.0.1" && hostname !== "::1") {
            throw new TypeError(
                "desktop sessions must bind to a loopback address",
            );
        }
        if (!environment.adminAuthToken?.trim()) {
            throw new TypeError("desktop sessions require an admin auth token");
        }
    }
    // Scrub the admin token from any event text before it reaches the buffer.
    systemLog.addSecret(environment.adminAuthToken);
    const bootstrapToken = options.desktopSession?.bootstrapToken;
    systemLog.addSecret(
        typeof bootstrapToken === "function"
            ? bootstrapToken()
            : bootstrapToken,
    );
    // Move ownership only once startup succeeds; partial startup also unwinds.
    await using resources = new AsyncDisposableStack();
    const kv = await Deno.openKv(environment.kvPath);
    resources.defer(() => kv.close());
    const requests = openSqliteRequestStore(environment.requestsPath, {
        recoverInterrupted: true,
    });
    resources.defer(() => requests.close());
    if (requests.recoveredRequests > 0) {
        log.warn(
            "startup",
            `已将上次进程中断遗留的 ${requests.recoveredRequests} 条请求标记为失败。`,
        );
    }
    const chat = openSqliteChatStore(environment.chatPath);
    resources.defer(() => chat.close());
    const assetStore = openSqliteChatAssetStore(
        environment.chatAssetsPath ?? `${environment.chatPath}.assets.sqlite`,
    );
    resources.defer(() => assetStore.close());
    const chatAssets = new ChatAssetService(assetStore, {
        publicBaseUrl: environment.publicBaseUrl,
    });
    await chatAssets.migrateHistory(chat);
    chatAssets.sweep(chat);
    if (chatAssets.quarantinedAttachments > 0) {
        log.warn(
            "chat-assets",
            `已隔离 ${chatAssets.quarantinedAttachments} 条损坏的旧版图片附件；原始数据保存在 Chat 数据库的 legacy_attachment_quarantine 表。`,
        );
    }

    const runtimeSettings = createRuntimeSettings({
        ...environment.runtimeSettings,
        requestRetentionDays:
            environment.runtimeSettings.requestRetentionDays ??
                environment.retentionDays,
    });
    const configStore = new DenoKvConfigStore(kv);
    const maintenance: { current?: RetentionRuntime } = {};
    const builtins = await loadBuiltinComposition({
        configStore,
        runtimeSettings,
        maintenanceStatus: () => maintenance.current?.snapshot(),
    });
    resources.defer(() => builtins.close());
    maintenance.current = resources.use(
        await startRetentionMaintenance({
            store: configStore,
            settings: runtimeSettings,
            requests,
            chat,
            assets: chatAssets,
            logger: log,
        }),
    );
    const adminUiPolicy = withBuiltinPresetPages(
        await loadUiPolicy(
            environment.adminUiPolicyPath,
        ),
    );

    const app = createServer({
        protocols: builtins.protocols,
        adminManifestTargets: builtins.apis.map(apiPluginTarget),
        sourceRegistry: builtins.sources,
        middleware: builtins.middleware,
        sourceMiddleware: builtins.sourceMiddleware,
        lifecycle: createRequestLifecycle(requests),
        requestJournal: requests,
        systemLog,
        statsTimeZone: environment.timeZone,
        adminCatalog: builtins.catalog,
        adminManagement: builtins.management,
        adminAuthToken: environment.adminAuthToken,
        adminAssetsRoot: environment.adminAssetsRoot,
        adminUiContributions: () =>
            loadRuntimeUiContributions(builtins.pluginHost),
        adminUiSourcePlugins: builtins.sourcePluginIds,
        adminUiSchemas: loadSourceSchemas,
        adminUiPolicy,
        adminPresetPages: () => loadPresetPages(adminUiPolicy),
        adminUiActions: options.adminUiActions,
        desktopSession: options.desktopSession,
        gateway: { settings: () => runtimeSettings.get() },
        accessLog: environment.httpLog,
        chat: {
            store: chat,
            assets: chatAssets,
            tools: builtins.toolPlugins,
            titleModel: () => runtimeSettings.get().titleModel || undefined,
        },
    });
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    let draining = false;
    const activeRequests = new Set<Promise<void>>();
    const server = Deno.serve({
        hostname,
        port,
        signal: options.signal
            ? AbortSignal.any([controller.signal, options.signal])
            : controller.signal,
        onListen: () => {},
    }, (request, info) => {
        if (draining) {
            return new Response("The application is shutting down.", {
                status: 503,
                headers: { connection: "close" },
            });
        }
        // completed covers streamed response bodies as well as the handler.
        const completed = info.completed.catch(() => undefined);
        activeRequests.add(completed);
        void completed.then(() => activeRequests.delete(completed));
        return app.fetch(request, info);
    });
    let stopped = false;
    void server.finished.then(
        () => {
            stopped = true;
        },
        () => {
            stopped = true;
        },
    );
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
        if (shutdownPromise !== undefined) return shutdownPromise;
        if (stopped) return Promise.resolve();
        draining = true;
        log.info("shutdown", "正在关闭网关。");
        return shutdownPromise = (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                if (activeRequests.size > 0) {
                    await Promise.race([
                        Promise.all(activeRequests),
                        new Promise<void>((resolve) => {
                            timer = setTimeout(resolve, shutdownTimeoutMs);
                        }),
                    ]);
                }
            } finally {
                clearTimeout(timer);
                // Keep abort as the single HTTP close operation. Calling it
                // after Deno's graceful shutdown can access an already closed
                // listener while an incomplete request is still draining.
                controller.abort();
                await server.finished;
            }
        })();
    };
    resources.defer(shutdown);
    resources.use(startBackgroundTasks(
        builtins.sources,
        runtimeSettings,
        log,
    ));

    const address = Object.freeze({ ...server.addr });
    const url = runtimeUrl(address);
    log.info("startup", `网关已启动，监听 ${url}`);
    options.onListen?.(address);

    const ownedResources = resources.move();
    const finished = server.finished.finally(() =>
        ownedResources.disposeAsync()
    );
    // A host may await finished only when its native window exits. Keep failures
    // observable there without reporting an unhandled rejection in the meantime.
    void finished.catch(() => undefined);
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
        return closePromise ??= (async () => {
            try {
                await shutdown();
            } finally {
                await finished;
            }
        })();
    };
    return { address, url, finished, close, [Symbol.asyncDispose]: close };
}

function runtimeUrl(address: Deno.NetAddr): string {
    // Wildcard addresses describe a bind, but are not useful navigation targets.
    const hostname = address.hostname === "0.0.0.0"
        ? "127.0.0.1"
        : address.hostname === "::"
        ? "[::1]"
        : address.hostname.includes(":")
        ? `[${address.hostname}]`
        : address.hostname;
    return `http://${hostname}:${address.port}`;
}
