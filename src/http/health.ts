import type { Context, Handler } from "hono";
import type { ServerEnv } from "./app.ts";

export interface HealthResponse {
    readonly status: "ok";
}

/** Stable liveness response used by local tooling and the admin UI. */
export const healthHandler: Handler<ServerEnv> = (
    context: Context<ServerEnv>,
) => context.json<HealthResponse>({ status: "ok" });
