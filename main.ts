export {
    createServer,
    type ServerOptions,
} from "@heimdall/core/composition/server.ts";
export {
    readPort,
    readRateLimit,
} from "@heimdall/core/composition/runtime-env.ts";
export {
    type RunningRuntime,
    type RuntimeOptions,
    startRuntime,
} from "@heimdall/core/runtime/server.ts";

if (import.meta.main) {
    const { serve } = await import("@heimdall/core/composition/serve.ts");
    await serve();
}
