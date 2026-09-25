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
import { createChatWebSession } from "../web/server/chat-session.ts";
import { loadChatSnapshot } from "../web/server/chat-snapshot.ts";
import { ChatShell } from "../web/components/chat-shell.tsx";
import { ChatPageView } from "../web/pages/chat.tsx";
import { serializeBoot } from "../web/server/serialize.ts";
export { serializeBoot } from "../web/server/serialize.ts";
import { createUiBridge } from "../web/server/bridge.ts";
import { loadConsoleSnapshot } from "../web/server/snapshot.ts";
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
    readonly policy?: UiPolicy;
    readonly actions?: UiActionRegistry;
    /** Reuse the chat handlers with the browser session, including native WS upgrades. */
    readonly chatRoutes?: MountableApp;
}

/** Web presentation depends on the management DTO boundary, never on storage. */
export function createAdminWebRoutes(options: AdminWebOptions): ServerApp {
    const app = new Hono<ServerEnv>();
    const session = createWebSession(options);
    const catalog = createUiCatalogLoader(options);
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
        documentHeaders(context);
        return context.html(
            "<!doctype html>" + (<ChatShell
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
            const snapshot = await loadConsoleSnapshot({
                ...options,
                authorized,
                origin: new URL(context.req.url).origin,
            });
            const { contributions, schemas, sourcePluginIds, presetPages } =
                authorized
                    ? await catalog.load(
                        snapshot.dashboard.status.plugins,
                        snapshot.dashboard.status.presets,
                    )
                    : EMPTY_UI_CATALOG;
            const view = context.req.query("view") ?? "overview";
            const page: ConsolePage =
                view === "channels" || view === "settings" || view === "plugin"
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
                { id: "settings", label: "设置", href: "/admin?view=settings" },
                { id: "chat", label: "对话", href: "/admin/chat" },
                ...pluginNavItems(contributions),
            ];
            const boot = {
                initial: snapshot.dashboard,
                initialPanels: {
                    requests: snapshot.requests,
                    usage: snapshot.usage,
                    settings: snapshot.settings,
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
            };
            documentHeaders(context);
            return context.html(
                "<!doctype html>" +
                    (<AdminShell
                        title="Heimdall · 运维控制台"
                        nav={nav}
                        active={page === "plugin" ? tab ?? "plugin" : page}
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
