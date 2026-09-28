import type { Handler } from "hono";
import type { MountableApp, ServerApp, ServerEnv } from "./app.ts";

const explicitHttpMethods = [
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

/** Mount a host-supplied Hono group at the composition boundary. */
export function mountRouteGroup(
    app: ServerApp,
    prefix: string,
    group: MountableApp,
    middleware?: Handler<ServerEnv>,
): void {
    // Copy the already-declared routes one by one. Hono's `route()` helper is
    // convenient, but it creates a mounted prefix matcher internally. The
    // server contract requires every public path to be present as an explicit
    // route, so the composition boundary must preserve the child route list
    // rather than ask Hono to synthesize a prefix route.
    for (const route of group.routes) {
        const path = joinRoutePath(prefix, route.path);
        if (route.method === "ALL") {
            for (const method of explicitHttpMethods) {
                if (middleware === undefined) {
                    app.on(method, path, route.handler as never);
                } else {
                    app.on(
                        method,
                        path,
                        middleware as never,
                        route.handler as never,
                    );
                }
            }
            continue;
        }
        if (middleware === undefined) {
            app.on(route.method as never, path, route.handler as never);
        } else {
            app.on(
                route.method as never,
                path,
                middleware as never,
                route.handler as never,
            );
        }
    }
}

/** Reject exact method/path duplicates before Hono can hide one by order. */
export function assertNoRouteConflicts(
    app: MountableApp,
    owner: string,
): void {
    const seen = new Set<string>();
    for (const route of app.routes) {
        if (hasForbiddenRoutePattern(route.path, owner)) {
            throw new TypeError(
                `${owner} route must be explicitly registered: ${route.path}`,
            );
        }
        const method = route.method.toUpperCase();
        const key = `${method}\0${route.path}`;
        if (seen.has(key)) {
            throw new TypeError(
                `${owner} route conflict: ${method} ${route.path}`,
            );
        }
        seen.add(key);
    }
}

function hasForbiddenRoutePattern(path: string, owner: string): boolean {
    // Host-owned resource endpoints have narrowly enumerated parameter routes.
    // Plugins still require exact manifest paths.
    if (owner === "admin" && path === "/plugin/:id") return false;
    if (owner === "chat" && path === "/assets/:id") return false;
    if (owner === "chat" && path === "/assets/:id/lease") return false;
    if (owner === "admin-ui" && path === "/admin/chat/api/assets/:id") {
        return false;
    }
    if (owner === "admin-ui" && path === "/admin/chat/api/assets/:id/lease") {
        return false;
    }
    if (owner === "chat-asset-links" && path === "/:id") return false;
    return path.includes("*") || path.includes(":") ||
        ["(", ")", "[", "]", "{", "}", "+", "?"].some((token) =>
            path.includes(token)
        );
}

function joinRoutePath(prefix: string, path: string): string {
    if (path === "/") return prefix;
    if (prefix === "/") return path;
    return `${prefix}${path.startsWith("/") ? path : `/${path}`}`;
}
