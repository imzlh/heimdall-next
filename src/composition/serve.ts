import { openSqliteChatStore } from "../storage/sqlite-chat.ts";
import { openSqliteChatAssetStore } from "../storage/sqlite-assets.ts";
import { ChatAssetService } from "../chat/assets.ts";
import { openSqliteRequestStore } from "../storage/sqlite-requests.ts";
import { DenoKvConfigStore } from "../storage/deno-kv.ts";
import { loadBuiltinComposition } from "./builtins.ts";
import { apiPluginTarget } from "../http/manifest-routes.ts";
import { loadRuntimeUiContributions } from "./ui-contributions.ts";
import { loadSourceSchemas } from "./source-schemas.ts";
import { loadUiPolicy } from "./ui-policy.ts";
import { loadPresetPages, withBuiltinPresetPages } from "./preset-pages.ts";
import type { UiActionRegistry } from "../web/server/ui-actions.ts";
import { createServer } from "./server.ts";
import { createRequestLifecycle } from "./request-lifecycle.ts";
import { createRuntimeSettings } from "./runtime-settings.ts";
import { startBackgroundTasks } from "./background-tasks.ts";
import {
    type RetentionRuntime,
    startRetentionMaintenance,
} from "./retention-runtime.ts";
import {
    readServerEnvironment,
    type ServerEnvironment,
} from "./runtime-env.ts";
import { log, systemLog } from "../observability/system-log.ts";

export interface ServeOptions {
    readonly environment?: ServerEnvironment;
    /** Allows a supervisor to stop the process without sending OS signals. */
    readonly signal?: AbortSignal;
    readonly onListen?: (address: Deno.NetAddr) => void;
    readonly adminUiActions?: UiActionRegistry;
}

/** Own durable resources, background work, and the HTTP server for one run. */
export async function serve(options: ServeOptions = {}): Promise<void> {
    const environment = options.environment ?? readServerEnvironment();
    // Scrub the admin token from any event text before it reaches the buffer.
    systemLog.addSecret(environment.adminAuthToken);
    // Register each resource immediately so partial startup also unwinds.
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
        gateway: { settings: () => runtimeSettings.get() },
        accessLog: environment.httpLog,
        chat: {
            store: chat,
            assets: chatAssets,
            tools: builtins.toolPlugins,
            titleModel: () => runtimeSettings.get().titleModel || undefined,
        },
    });
    const server = Deno.serve({
        hostname: environment.hostname,
        port: environment.port,
        signal: options.signal,
        onListen: (address) => {
            log.info(
                "startup",
                `网关已启动，监听 ${address.hostname}:${address.port}`,
            );
            options.onListen?.(address);
        },
    }, (request, info) => app.fetch(request, info));
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = () => {
        if (shutdownPromise === undefined) {
            log.info("shutdown", "收到停止信号，正在关闭网关。");
        }
        return shutdownPromise ??= server.shutdown();
    };
    resources.defer(shutdown);
    resources.use(listenForShutdown(shutdown));
    resources.use(startBackgroundTasks(
        builtins.sources,
        runtimeSettings,
        log,
    ));

    await server.finished;
}

function listenForShutdown(shutdown: () => Promise<void>): Disposable {
    using listeners = new DisposableStack();
    // Deno only supports SIGINT/SIGBREAK on Windows.
    const signals: Deno.Signal[] = Deno.build.os === "windows"
        ? ["SIGINT"]
        : ["SIGINT", "SIGTERM"];
    const handleSignal = () => {
        // The process also awaits server.finished and cleanup awaits shutdown.
        void shutdown().catch(() => undefined);
    };
    for (const signal of signals) {
        Deno.addSignalListener(signal, handleSignal);
        listeners.defer(() => Deno.removeSignalListener(signal, handleSignal));
    }
    return listeners.move();
}
