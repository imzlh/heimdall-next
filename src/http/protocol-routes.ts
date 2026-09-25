import { Hono } from "hono";
import type { Context } from "hono";
import type {
    OperationRequest,
    PluginRoute,
    ProtocolPlugin,
    RequestContext,
} from "@heimdall/contracts";
import type { KernelRuntime } from "@heimdall/kernel";
import type { ServerApp, ServerEnv } from "./app.ts";

/** Methods accepted by Hono and by protocol plugin route manifests. */
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

export interface ProtocolRoutesOptions {
    readonly protocols: readonly ProtocolPlugin[];
    readonly runtime: KernelRuntime;
}

export class ProtocolRouteConflictError extends Error {
    override readonly name = "ProtocolRouteConflictError";
}

/**
 * Mounts protocol plugins using the exact paths declared in their manifests.
 * Each plugin owns dialect matching, parsing, and serialization.
 */
export function createProtocolRoutes(
    options: ProtocolRoutesOptions,
): ServerApp {
    const app = new Hono<ServerEnv>();
    const registered = new Set<string>();
    for (const plugin of options.protocols) {
        for (const route of plugin.manifest.routes ?? []) {
            const method = toSupportedMethod(route.method, plugin.manifest.id);
            const path = mountedPath(route.path, "/v1");
            assertStaticProtocolPath(path, plugin.manifest.id);
            const key = `${method}\0${path}`;
            if (registered.has(key)) {
                throw new ProtocolRouteConflictError(
                    `duplicate protocol route: ${method} ${path}`,
                );
            }
            registered.add(key);
            app.on(method, path, async (context) => {
                const response = await dispatch(
                    context,
                    options,
                    plugin,
                    route,
                );
                return response ?? context.notFound();
            });
        }
    }
    return app;
}

function assertStaticProtocolPath(path: string, pluginId: string): void {
    if (path.includes("*") || path.includes(":")) {
        throw new TypeError(
            `protocol route must be a static path in ${pluginId}: ${path}`,
        );
    }
}

function toSupportedMethod(value: string, pluginId: string): SupportedMethod {
    const method = value.toUpperCase();
    if ((supportedMethods as readonly string[]).includes(method)) {
        return method as SupportedMethod;
    }
    throw new TypeError(`unsupported route method ${value} in ${pluginId}`);
}

function mountedPath(path: string, prefix: string): string {
    if (path === prefix) return "/";
    const prefixWithSlash = `${prefix}/`;
    if (!path.startsWith(prefixWithSlash)) {
        throw new RangeError(
            `protocol route ${path} is outside mount prefix ${prefix}`,
        );
    }
    return path.slice(prefix.length) || "/";
}

async function dispatch(
    context: Context<ServerEnv>,
    options: ProtocolRoutesOptions,
    plugin: ProtocolPlugin,
    route: PluginRoute,
): Promise<Response | undefined> {
    const request = context.req.raw;
    const requestId = context.get("requestId") ||
        request.headers.get("x-request-id")?.trim() || crypto.randomUUID();

    const pluginContext: RequestContext = {
        requestId,
        request,
        signal: request.signal,
        route,
        metadata: {},
    };

    let operation: OperationRequest;
    try {
        operation = await plugin.parse(pluginContext);
    } catch (error) {
        return withRequestId(
            protocolErrorResponse(plugin, pluginContext, error),
            requestId,
        );
    }

    try {
        const lifecycle = options.runtime.createLifecycle(
            operation,
            request.signal,
            { streamId: `run:${requestId}` },
        );
        const execution = await options.runtime.run(operation, lifecycle, {
            requestContext: pluginContext,
        });
        return withRequestId(
            await plugin.serialize(
                pluginContext,
                execution.request,
                execution.frames,
            ),
            requestId,
        );
    } catch (error) {
        return withRequestId(
            protocolErrorResponse(plugin, pluginContext, error),
            requestId,
        );
    }
}

function protocolErrorResponse(
    plugin: ProtocolPlugin,
    context: RequestContext,
    error: unknown,
): Response {
    const protocolError = error as {
        readonly status?: unknown;
        readonly code?: unknown;
    };
    const status = Number.isInteger(protocolError.status)
        ? protocolError.status as number
        : error instanceof Error && error.name === "SourceUnavailableError"
        ? 503
        : 500;
    const message = error instanceof Error &&
            error.name === "SourceUnavailableError"
        ? "no configured upstream source supports this operation"
        : error instanceof Error
        ? error.message
        : "protocol failure";
    const code = typeof protocolError.code === "string"
        ? protocolError.code
        : error instanceof Error && error.name === "SourceUnavailableError"
        ? "upstream_unavailable"
        : "internal_error";
    if (plugin.serializeError !== undefined) {
        return plugin.serializeError(context, {
            status,
            code,
            message,
        });
    }
    return Response.json({
        error: { message, type: code, code },
    }, { status });
}

function withRequestId(response: Response, requestId: string): Response {
    if (response.headers.get("x-heimdall-request-id") === requestId) {
        return response;
    }
    const headers = new Headers(response.headers);
    headers.set("x-heimdall-request-id", requestId);
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}
