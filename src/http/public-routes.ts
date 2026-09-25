import { Hono } from "hono";
import type { MountableApp, ServerApp, ServerEnv } from "./app.ts";
import { assertNoRouteConflicts, mountRouteGroup } from "./route-validation.ts";

export interface ModelsResponse {
    readonly object: "list";
    readonly data: readonly unknown[];
}

export interface PublicRouteOptions {
    /** Optional protocol sub-application mounted at the public root. */
    readonly protocolRoutes?: MountableApp;
    /** Optional manifest-owned routes mounted at the public root. */
    readonly manifestRoutes?: MountableApp;
    /** Supply the model list once the source registry is wired in. */
    readonly models?: () => ModelsResponse | Promise<ModelsResponse>;
}

/**
 * Public `/v1` route group. It is deliberately small so protocol plugins can
 * be mounted through `app.route` without coupling them to the host app.
 */
export function createPublicRoutes(
    options: PublicRouteOptions = {},
): ServerApp {
    const app = new Hono<ServerEnv>();

    app.get("/models", async (context) => {
        const payload = await options.models?.() ?? {
            object: "list" as const,
            data: [],
        };
        if (context.req.header("anthropic-version")?.trim()) {
            return context.json(anthropicModelList(payload));
        }
        return context.json(payload);
    });

    if (options.protocolRoutes !== undefined) {
        mountRouteGroup(app, "/", options.protocolRoutes);
    }
    if (options.manifestRoutes !== undefined) {
        mountRouteGroup(app, "/", options.manifestRoutes);
    }

    assertNoRouteConflicts(app, "public");

    return app;
}

function anthropicModelList(payload: ModelsResponse): {
    data: {
        id: string;
        type: "model";
        display_name: string;
        created_at: string;
    }[];
    has_more: false;
    first_id: string | null;
    last_id: string | null;
} {
    const data = [];
    for (const item of payload.data) {
        if (item === null || typeof item !== "object") continue;
        const id = (item as { id?: unknown }).id;
        if (typeof id !== "string" || id.trim().length === 0) continue;
        data.push({
            id,
            type: "model" as const,
            display_name: id,
            created_at: "1970-01-01T00:00:00Z",
        });
    }
    return {
        data,
        has_more: false,
        first_id: data[0]?.id ?? null,
        last_id: data.at(-1)?.id ?? null,
    };
}
