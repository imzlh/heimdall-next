import { Hono } from "hono";
import type { Context } from "hono";
import type {
    ApiPlugin,
    PluginManifest,
    PluginRoute,
} from "@heimdall/contracts";
import type { ServerApp, ServerEnv } from "./app.ts";

const requestIdHeader = "x-heimdall-request-id";

/** Methods accepted by Hono's method router and by plugin route manifests. */
const supportedMethods = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
    "TRACE",
    "CONNECT",
] as const;

type SupportedMethod = (typeof supportedMethods)[number];

/** A route invocation after Hono has resolved an explicit static path. */
export interface ManifestRouteInvocation {
    readonly requestId: string;
    readonly request: Request;
    readonly signal: AbortSignal;
    readonly route: PluginRoute;
    readonly manifest: PluginManifest;
    readonly params: Readonly<Record<string, string>>;
}

/** Host-side handler for one manifest-owned route family. */
export type ManifestRouteHandler = (
    invocation: ManifestRouteInvocation,
) => Response | Promise<Response>;

/** A validated manifest together with its host-owned route implementation. */
export interface ManifestRouteTarget {
    readonly manifest: PluginManifest;
    readonly handle: ManifestRouteHandler;
}

export interface ManifestRouteMountOptions {
    /**
     * Remove a public prefix before registering routes in a mounted sub-app.
     * For example, `/v1/chat/completions` with `stripPrefix: "/v1"` becomes
     * `/chat/completions` and can then be mounted under `/v1`.
     */
    readonly stripPrefix?: string;
}

export class ManifestRouteConflictError extends Error {
    override readonly name = "ManifestRouteConflictError";
}

export class ManifestRouteMethodError extends Error {
    override readonly name = "ManifestRouteMethodError";
}

/**
 * Build a Hono sub-application from plugin route declarations.
 *
 * The adapter intentionally knows only the manifest and the route handler.
 * Parsing, kernel execution, and persistence remain outside the HTTP layer.
 */
export function createManifestRoutes(
    targets: readonly ManifestRouteTarget[],
    options: ManifestRouteMountOptions = {},
): ServerApp {
    const app = new Hono<ServerEnv>();
    registerManifestRoutes(app, targets, options);
    return app;
}

/** Register manifest declarations on an existing Hono application. */
export function registerManifestRoutes(
    app: ServerApp,
    targets: readonly ManifestRouteTarget[],
    options: ManifestRouteMountOptions = {},
): void {
    const registered = new Set<string>();
    for (const target of targets) {
        for (const route of target.manifest.routes ?? []) {
            const method = toSupportedMethod(route.method, target.manifest);
            const path = mountedPath(route.path, options.stripPrefix);
            assertStaticManifestPath(path, target.manifest.id);
            const key = `${method}\0${path}`;
            if (registered.has(key)) {
                throw new ManifestRouteConflictError(
                    `duplicate manifest route: ${method} ${path}`,
                );
            }
            registered.add(key);
            app.on(
                method,
                path,
                (context) => invokeManifestRoute(context, target, route),
            );
        }
    }
}

function assertStaticManifestPath(path: string, manifestId: string): void {
    if (path.includes("*") || path.includes(":")) {
        throw new TypeError(
            `manifest route must be a static path in ${manifestId}: ${path}`,
        );
    }
}

/** Adapt an existing contracts-level API plugin to the route target shape. */
export function apiPluginTarget(plugin: ApiPlugin): ManifestRouteTarget {
    return {
        manifest: plugin.manifest,
        handle: (invocation) =>
            plugin.handle({
                requestId: invocation.requestId,
                request: invocation.request,
                signal: invocation.signal,
                route: invocation.route,
            }),
    };
}

async function invokeManifestRoute(
    context: Context<ServerEnv>,
    target: ManifestRouteTarget,
    route: PluginRoute,
): Promise<Response> {
    const requestId = context.get("requestId") ||
        context.req.header("x-request-id")?.trim() || crypto.randomUUID();
    const response = await target.handle({
        requestId,
        request: context.req.raw,
        signal: context.req.raw.signal,
        route,
        manifest: target.manifest,
        // Manifest routes are static by contract. Keep the field for the
        // plugin boundary, but do not derive routing from URL parameters.
        params: Object.freeze({}),
    });
    return withRequestId(response, requestId);
}

function toSupportedMethod(
    value: string,
    manifest: PluginManifest,
): SupportedMethod {
    const method = value.toUpperCase();
    if ((supportedMethods as readonly string[]).includes(method)) {
        return method as SupportedMethod;
    }
    throw new ManifestRouteMethodError(
        `unsupported route method ${value} in ${manifest.id}`,
    );
}

function mountedPath(path: string, stripPrefix: string | undefined): string {
    if (stripPrefix === undefined) return path;
    const prefix = normalizePrefix(stripPrefix);
    if (path === prefix) return "/";
    const prefixWithSlash = `${prefix}/`;
    if (!path.startsWith(prefixWithSlash)) {
        throw new RangeError(
            `route ${path} is outside mount prefix ${stripPrefix}`,
        );
    }
    return path.slice(prefix.length) || "/";
}

function normalizePrefix(value: string): string {
    if (value.length === 0) return "/";
    const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
    if (withLeadingSlash.length > 1 && withLeadingSlash.endsWith("/")) {
        return withLeadingSlash.slice(0, -1);
    }
    return withLeadingSlash;
}

function withRequestId(response: Response, requestId: string): Response {
    if (response.headers.has(requestIdHeader)) return response;
    const headers = new Headers(response.headers);
    headers.set(requestIdHeader, requestId);
    return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
    });
}
