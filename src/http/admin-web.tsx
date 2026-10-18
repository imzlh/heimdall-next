import { type Context, type Handler, Hono } from "hono";
import { raw } from "hono/html";
import { pluginNavItems } from "@heimdall/admin-contracts/ui.ts";
import type { UiPolicy } from "@heimdall/admin-contracts/ui.ts";
import { EMPTY_UI_CATALOG } from "@heimdall/admin-contracts/ui-catalog.ts";
import type { MountableApp, ServerApp, ServerEnv } from "./app.ts";
import { createAdminAssetRoutes } from "./admin-assets.ts";
import { mountRouteGroup } from "./route-validation.ts";
import { AdminShell } from "../web/components/shell.tsx";
import { type ConsolePage, ConsolePageView } from "../web/pages/console.tsx";
import { createWebSession } from "../web/server/session.ts";
import type { DesktopSessionOptions } from "../web/server/desktop-session.ts";
import { createChatWebSession } from "../web/server/chat-session.ts";
import { loadChatSnapshot } from "../web/server/chat-snapshot.ts";
import {
    createChatExtensionLoader,
    createChatExtensionsRoute,
} from "../web/server/chat-extensions.ts";
import { ChatShell } from "../web/components/chat-shell.tsx";
import { ChatPageView } from "../web/pages/chat.tsx";
import { serializeBoot } from "../web/server/serialize.ts";
export { serializeBoot } from "../web/server/serialize.ts";
import { createUiBridge } from "../web/server/bridge.ts";
import { loadConsoleSnapshot } from "../web/server/snapshot.ts";
import { loadSystemLogSnapshot } from "../web/server/system-log-snapshot.ts";
import { loadJournalSnapshot } from "../web/server/journal-snapshot.ts";
import { createJournalDownload } from "../web/server/journal-download.ts";
import {
    createUiActions,
    type UiActionRegistry,
} from "../web/server/ui-actions.ts";
import {
    createUiCatalogLoader,
    createUiCatalogRoute,
    type UiCatalogOptions,
} from "../web/server/ui-catalog.ts";

export interface AdminWebOptions extends UiCatalogOptions {
    readonly assetsRoot?: string;
    readonly desktopSession?: DesktopSessionOptions;
    readonly policy?: UiPolicy;
    readonly actions?: UiActionRegistry;
    /** Reuse the chat handlers with the browser session, including native WS upgrades. */
    readonly chatRoutes?: MountableApp;
}

/** Web presentation depends on the management DTO boundary, never on storage. */
export function createAdminWebRoutes(options: AdminWebOptions): ServerApp {
    const app = new Hono<ServerEnv>();
    const session = createWebSession(options);
    if (session.desktopBootstrap && session.desktopBootstrapDocument) {
        app.get("/admin/desktop/bootstrap", session.desktopBootstrapDocument);
        app.post("/admin/desktop/bootstrap", session.desktopBootstrap);
    }
    const catalog = createUiCatalogLoader(options);
    const chatExtensions = createChatExtensionLoader({
        ...options,
        contributions: catalog.contributions,
    });
    app.get(
        "/admin/chat/ui",
        createChatExtensionsRoute(session, chatExtensions),
    );
    app.post(
        "/admin/ui/action",
        createUiActions({
            session,
            policy: options.policy,
            actions: options.actions,
            sourcePlugins: catalog.sourcePlugins,
            contributions: catalog.contributions,
        }),
    );
    app.post("/admin/session", session.login);
    app.post("/admin/logout", session.logout);
    app.post("/admin/ui/request", createUiBridge({ ...options, session }));
    app.get(
        "/admin/ui/requests/export",
        createJournalDownload({ ...options, session }),
    );
    app.get("/admin/ui/catalog", createUiCatalogRoute(session, catalog.load));
    app.get(
        "/chat",
        (context) =>
            context.redirect(
                `/admin/chat${new URL(context.req.url).search}`,
                303,
            ),
    );
    app.get(
        "/admin/chat/",
        (context) =>
            context.redirect(
                `/admin/chat${new URL(context.req.url).search}`,
                308,
            ),
    );
    app.get("/admin/chat", async (context) => {
        const initial = await loadChatSnapshot({
            ...options,
            authorized: await session.authorized(context),
            available: options.chatRoutes !== undefined,
            origin: new URL(context.req.url).origin,
            conversationId: context.req.query("id"),
            selectedModel: context.req.query("model"),
        });
        if (initial.authenticated && initial.available) {
            try {
                initial.extensions = await chatExtensions(initial.tools ?? []);
            } catch {
                initial.error = [
                    initial.error,
                    "插件能力暂不可用，可稍后刷新。",
                ].filter(Boolean).join(" ");
            }
        }
        documentHeaders(context);
        return context.html(
            "<!doctype html>" + (<ChatShell
                desktop={options.desktopSession !== undefined}
                scripts={
                    <>
                        <script id="heimdall-chat-boot" type="application/json">
                            {raw(serializeBoot(initial))}
                        </script>
                        <script type="module" src="/admin/assets/chat.js">
                        </script>
                    </>
                }
            >
                <div id="heimdall-chat">
                    <ChatPageView initial={initial} />
                </div>
            </ChatShell>).toString(),
        );
    });
    if (options.chatRoutes !== undefined) {
        const chat = new Hono<ServerEnv>();
        // Keep one registered handler per exact route for conflict auditing.
        for (const route of options.chatRoutes.routes) {
            chat.on(
                route.method,
                route.path,
                createChatWebSession(
                    session,
                    route.handler as Handler<ServerEnv>,
                ),
            );
        }
        mountRouteGroup(
            app,
            "/admin/chat/api",
            chat,
        );
    }
    app.get("/admin/", (context) => context.redirect("/admin", 308));
    app.get("/", (context) => context.redirect("/admin", 303));
    for (const path of ["/admin"]) {
        app.get(path, async (context) => {
            const authorized = await session.authorized(context);
            const view = context.req.query("view") ?? "overview";
            const snapshot = await loadConsoleSnapshot({
                ...options,
                authorized,
                origin: new URL(context.req.url).origin,
                includeActivity: ![
                    "channels",
                    "settings",
                    "plugin",
                    "logs",
                    "requests",
                ].includes(view),
            });
            if (view === "logs" || view === "requests") {
                const url = new URL(context.req.url);
                const logOptions = {
                    ...options,
                    authorized,
                    origin: url.origin,
                };
                if (view === "requests") {
                    snapshot.journal = await loadJournalSnapshot(
                        logOptions,
                        url.searchParams,
                    );
                } else {
                    snapshot.systemLog = await loadSystemLogSnapshot(
                        logOptions,
                        url.searchParams,
                    );
                }
            }
            const { contributions, schemas, sourcePluginIds, presetPages } =
                authorized
                    ? await catalog.load(
                        snapshot.dashboard.status.plugins,
                        snapshot.dashboard.status.presets,
                    )
                    : EMPTY_UI_CATALOG;
            const page: ConsolePage =
                view === "channels" || view === "settings" ||
                    view === "plugin" || view === "logs" || view === "requests"
                    ? view
                    : "overview";
            const tab = context.req.query("tab");
            if (
                page === "plugin" &&
                !contributions.some((item) =>
                    item.slot === "nav.tab" &&
                    `${item.pluginId}:${item.id}` === tab
                )
            ) {
                return context.notFound();
            }
            const nav = [
                { id: "overview", label: "总览", href: "/admin" },
                { id: "channels", label: "渠道", href: "/admin?view=channels" },
                { id: "logs", label: "日志", href: "/admin?view=logs" },
                { id: "settings", label: "设置", href: "/admin?view=settings" },
                { id: "chat", label: "对话", href: "/admin/chat" },
                ...pluginNavItems(contributions),
            ];
            const boot = {
                initial: snapshot.dashboard,
                initialPanels: {
                    requests: snapshot.requests,
                    journal: snapshot.journal,
                    systemLog: snapshot.systemLog,
                    stats: snapshot.stats,
                    usage: snapshot.usage,
                    settings: snapshot.settings,
                    proxies: snapshot.proxies,
                    errors: snapshot.errors,
                },
                page,
                tab,
                contributions,
                policy: options.policy,
                sourcePluginIds,
                schemas,
                presetPages,
                authenticated: authorized,
                desktop: options.desktopSession !== undefined,
            };
            documentHeaders(context);
            return context.html(
                "<!doctype html>" +
                    (<AdminShell
                        desktop={options.desktopSession !== undefined}
                        title="Heimdall · 运维控制台"
                        nav={nav}
                        active={page === "plugin"
                            ? tab ?? "plugin"
                            : page === "requests"
                            ? "overview"
                            : page}
                        scripts={
                            <>
                                <script
                                    id="heimdall-boot"
                                    type="application/json"
                                >
                                    {raw(serializeBoot(boot))}
                                </script>
                                <script
                                    type="module"
                                    src="/admin/assets/console.js"
                                >
                                </script>
                            </>
                        }
                    >
                        <div id="heimdall-console">
                            <ConsolePageView
                                desktop={options.desktopSession !== undefined}
                                snapshot={snapshot}
                                page={page}
                                tab={tab}
                                contributions={contributions}
                                policy={options.policy}
                                sourcePluginIds={sourcePluginIds}
                            />
                        </div>
                    </AdminShell>).toString(),
            );
        });
    }
    mountRouteGroup(
        app,
        "/",
        createAdminAssetRoutes(options.assetsRoot, options.policy),
    );
    return app;
}

function documentHeaders(context: Context<ServerEnv>): void {
    context.header("cache-control", "no-store");
    context.header("referrer-policy", "same-origin");
    context.header("x-content-type-options", "nosniff");
    context.header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
}
