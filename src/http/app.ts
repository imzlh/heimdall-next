import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { RequestStore } from "@heimdall/storage";
import {
    type AdminCatalogOptions,
    type AdminManagementOptions,
    createAdminRoutes,
} from "./admin-routes.ts";
import { createGatewayMiddleware, type GatewayOptions } from "./gateway.ts";
import { createChatAuthMiddleware } from "./chat-auth.ts";
import { createAccessLog } from "./access-log.ts";
import { errorHandler, notFoundHandler } from "./error-handler.ts";
import { healthHandler } from "./health.ts";
import {
    createManifestRoutes,
    type ManifestRouteTarget,
} from "./manifest-routes.ts";
import { createPublicRoutes } from "./public-routes.ts";
import { assertNoRouteConflicts, mountRouteGroup } from "./route-validation.ts";
import type { ModelsResponse } from "./public-routes.ts";
import type { UiPolicy } from "@heimdall/admin-contracts/ui.ts";
import { createAdminWebRoutes } from "./admin-web.tsx";
import type { UiActionRegistry } from "../web/server/ui-actions.ts";
import type { UiCatalogOptions } from "../web/server/ui-catalog.ts";

/** Values attached to a request while it crosses the HTTP boundary. */
export type ServerEnv = {
    Variables: {
        requestId: string;
        /**
         * The management target a proxy/bridge endpoint dispatched to (e.g.
         * `GET /api/admin/status`). When set, the access log shows it in place
         * of the opaque bridge method and path (`POST /admin/ui/request`).
         */
        accessLogTarget?: string;
    };
};

/** Hono application type shared by every mounted route group. */
export type ServerApp = Hono<ServerEnv>;

/**
 * A route group supplied by an embedding host may not know about the server's
 * request-id variable map. The runtime shape is still a Hono application; the
 * mount helper narrows it at the one framework boundary where the groups join.
 */
export type MountableApp = ServerApp | Hono;

export interface ServerAppOptions {
    /** A complete public route group mounted below `/v1`. */
    readonly publicRoutes?: MountableApp;
    /** A protocol router mounted below `/v1` for compatibility. */
    readonly protocolRoutes?: MountableApp;
    /** A manifest route group whose paths are relative to `/v1`. */
    readonly manifestRoutes?: MountableApp;
    /** Manifest targets that should be adapted and mounted below `/v1`. */
    readonly manifestTargets?: readonly ManifestRouteTarget[];
    /** Optional model provider for the default public route group. */
    readonly models?: () => ModelsResponse | Promise<ModelsResponse>;
    /** A management manifest route group whose paths are relative to `/admin`. */
    readonly adminManifestRoutes?: MountableApp;
    /** Management manifest targets that should be adapted below `/admin`. */
    readonly adminManifestTargets?: readonly ManifestRouteTarget[];
    /** A management router mounted below `/admin`. */
    readonly adminRoutes?: MountableApp;
    /** Read-only catalog providers for the built-in management routes. */
    readonly adminCatalog?: AdminCatalogOptions;
    /** Optional state-changing management capabilities. */
    readonly adminManagement?: AdminManagementOptions;
    /** Require this bearer token for management API requests when set. */
    readonly adminAuthToken?: string;
    /** Override the server-rendered operator UI when embedding the service. */
    readonly adminUiRoutes?: MountableApp;
    /** Self-hosted browser assets produced by `deno task build:web`. */
    readonly adminAssetsRoot?: string;
    /** Declarative UI extensions registered by the host. */
    readonly adminUiContributions?: UiCatalogOptions["contributions"];
    /** Host allowlist for executable plugin UI. Schema is the default. */
    readonly adminUiPolicy?: UiPolicy;
    readonly adminUiActions?: UiActionRegistry;
    readonly adminUiSchemas?: UiCatalogOptions["schemas"];
    readonly adminUiSourcePlugins?: UiCatalogOptions["sourcePlugins"];
    readonly adminPresetPages?:
        import("./admin-web.tsx").AdminWebOptions["presetPages"];
    /**
     * Request journal for the built-in admin routes. Ignored when `adminRoutes`
     * replaces that group, because the replacement owns the management surface.
     */
    readonly requestJournal?: RequestStore;
    /** In-memory system event log surfaced by the built-in admin routes. */
    readonly systemLog?: import("../observability/system-log.ts").SystemLog;
    /** IANA zone defining natural days in usage statistics; the process zone by default. */
    readonly statsTimeZone?: string;
    /** Proxy key and per-peer limit for `/v1`. Omitted means the gate is off. */
    readonly gateway?: GatewayOptions;
    /** Local chat history and generation. Not part of the proxy-key gate. */
    readonly chatRoutes?: MountableApp;
    /** Independently signed, expiring reads for upstream image fetches. */
    readonly chatAssetLinkRoutes?: MountableApp;
    /** Print a Gin-style line per HTTP request to the console. Off by default. */
    readonly accessLog?: boolean;
}

/**
 * Build the transport boundary without constructing the kernel or loading any
 * plugins. Composition owns those dependencies and may provide route groups
 * when it is ready to expose them.
 */
export function createServerApp(options: ServerAppOptions = {}): ServerApp {
    const app = new Hono<ServerEnv>();

    // Outermost so it also records 404s and errors; it never reads the body.
    if (options.accessLog) app.use("*", createAccessLog());

    app.onError(errorHandler);
    app.notFound(notFoundHandler);

    app.get("/health", requestIdMiddleware, healthHandler);

    if (
        options.publicRoutes !== undefined &&
        options.protocolRoutes !== undefined
    ) {
        throw new TypeError(
            "provide publicRoutes or protocolRoutes, not both",
        );
    }
    if (
        options.manifestRoutes !== undefined &&
        options.manifestTargets !== undefined
    ) {
        throw new TypeError(
            "provide manifestRoutes or manifestTargets, not both",
        );
    }
    if (
        options.adminManifestRoutes !== undefined &&
        options.adminManifestTargets !== undefined
    ) {
        throw new TypeError(
            "provide adminManifestRoutes or adminManifestTargets, not both",
        );
    }
    if (
        options.publicRoutes !== undefined &&
        (options.manifestRoutes !== undefined ||
            options.manifestTargets !== undefined)
    ) {
        throw new TypeError(
            "provide publicRoutes or public route manifest options, not both",
        );
    }
    if (
        options.adminRoutes !== undefined &&
        (options.adminManifestRoutes !== undefined ||
            options.adminManifestTargets !== undefined)
    ) {
        throw new TypeError(
            "provide adminRoutes or admin manifest route options, not both",
        );
    }

    const publicManifestRoutes = options.manifestRoutes ??
        (options.manifestTargets === undefined
            ? undefined
            : createManifestRoutes(options.manifestTargets, {
                stripPrefix: "/v1",
            }));
    const publicRoutes = options.publicRoutes ?? createPublicRoutes({
        protocolRoutes: options.protocolRoutes,
        manifestRoutes: publicManifestRoutes,
        models: options.models,
    });
    assertNoRouteConflicts(publicRoutes, "public");
    mountRouteGroup(
        app,
        "/v1",
        publicRoutes,
        options.gateway === undefined
            ? requestIdMiddleware
            : composePublicMiddleware(options.gateway),
    );

    const adminManifestRoutes = options.adminManifestRoutes ??
        (options.adminManifestTargets === undefined
            ? undefined
            : createManifestRoutes(options.adminManifestTargets, {
                stripPrefix: "/admin",
            }));
    const adminRoutes = options.adminRoutes ?? createAdminRoutes({
        models: options.models,
        manifestRoutes: adminManifestRoutes,
        catalog: options.adminCatalog,
        management: options.adminManagement,
        requestJournal: options.requestJournal,
        systemLog: options.systemLog,
        statsTimeZone: options.statsTimeZone,
    });
    assertNoRouteConflicts(adminRoutes, "admin");
    const adminMiddleware = options.adminAuthToken === undefined
        ? requestIdMiddleware
        : composeAdminMiddleware(options.adminAuthToken);
    mountRouteGroup(app, "/admin", adminRoutes, adminMiddleware);
    // Both existing management prefixes remain stable for external clients.
    mountRouteGroup(app, "/api/admin", adminRoutes, adminMiddleware);

    if (options.chatAssetLinkRoutes !== undefined) {
        assertNoRouteConflicts(options.chatAssetLinkRoutes, "chat-asset-links");
        mountRouteGroup(
            app,
            "/api/chat/asset-links",
            options.chatAssetLinkRoutes,
            requestIdMiddleware,
        );
    }

    if (options.chatRoutes !== undefined) {
        assertNoRouteConflicts(options.chatRoutes, "chat");
        const chatAuth = createChatAuthMiddleware(options.adminAuthToken);
        mountRouteGroup(
            app,
            "/api/chat",
            options.chatRoutes,
            async (context, next) => {
                await requestIdMiddleware(context, async () => {
                    const response = await chatAuth(context, next);
                    if (response instanceof Response) context.res = response;
                });
            },
        );
    }

    const webRoutes = options.adminUiRoutes ?? createAdminWebRoutes({
        assetsRoot: options.adminAssetsRoot,
        adminAuthToken: options.adminAuthToken,
        contributions: options.adminUiContributions,
        policy: options.adminUiPolicy,
        actions: options.adminUiActions,
        schemas: options.adminUiSchemas,
        sourcePlugins: options.adminUiSourcePlugins,
        presetPages: options.adminPresetPages,
        chatRoutes: options.chatRoutes,
        dispatch: (request) => Promise.resolve(app.fetch(request)),
    });
    assertNoRouteConflicts(webRoutes, "admin-ui");
    mountRouteGroup(app, "/", webRoutes, requestIdMiddleware);

    return app;
}

const requestIdMiddleware: MiddlewareHandler<ServerEnv> = async (
    context,
    next,
) => {
    const supplied = context.req.header("x-request-id")?.trim();
    const requestId = supplied && supplied.length > 0
        ? supplied
        : crypto.randomUUID();
    context.set("requestId", requestId);
    context.header("x-heimdall-request-id", requestId);
    await next();
    // Route/plugin responses never replace the host trace. Internal bridge
    // dispatches inherit this ID rather than installing their own response ID.
    context.header("x-heimdall-request-id", requestId);
};

function composePublicMiddleware(
    gateway: GatewayOptions,
): MiddlewareHandler<ServerEnv> {
    const guard = createGatewayMiddleware(gateway);
    return async (context, next) => {
        await requestIdMiddleware(context, async () => {
            await guard(context, next);
        });
    };
}

function composeAdminMiddleware(token: string): MiddlewareHandler<ServerEnv> {
    const expected = token.trim();
    return async (context, next) => {
        await requestIdMiddleware(context, async () => {
            const authorization = context.req.header("authorization") ?? "";
            const supplied = authorization.startsWith("Bearer ")
                ? authorization.slice("Bearer ".length).trim()
                : "";
            if (supplied !== expected || expected.length === 0) {
                const requestId = context.get("requestId");
                context.header("x-heimdall-request-id", requestId);
                context.res = Response.json({
                    error: {
                        code: "unauthorized",
                        message: "admin bearer token required",
                        request_id: requestId,
                    },
                }, {
                    status: 401,
                    headers: { "x-heimdall-request-id": requestId },
                });
                return;
            }
            await next();
        });
    };
}
