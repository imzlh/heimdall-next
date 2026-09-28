import { Hono } from "hono";
import type { AdminRouteContext } from "./admin-routes.ts";
import type { ServerEnv } from "./app.ts";
import { PluginLifecycleError, PluginVerificationError } from "@heimdall/plugin-host";
import { StorageConflictError } from "@heimdall/storage";

export type InstallPluginHandler = (context: AdminRouteContext, input: unknown) => Promise<unknown>;

/** Mounted inside the authenticated admin route group, including the UI session bridge. */
export function createPluginPackageRoutes(install: InstallPluginHandler): Hono<ServerEnv> {
    const app = new Hono<ServerEnv>();
    app.post("/plugin-package", async (context) => {
        const requestId = context.get("requestId") || crypto.randomUUID();
        try {
            const input = await readPackage(context.req.raw);
            const plugin = await install({ request: context.req.raw, requestId }, input);
            return context.json({ plugin }, 201);
        } catch (error) {
            const status = error instanceof PackageInputError ? error.status
                : error instanceof TypeError || error instanceof PluginVerificationError ? 400
                : error instanceof StorageConflictError || error instanceof PluginLifecycleError ? 409 : 500;
            return context.json({ error: {
                code: status === 413 ? "payload_too_large" : status === 409 ? "plugin_conflict" : status === 500 ? "plugin_install_failed" : "invalid_plugin_package",
                message: status === 500 ? "插件安装失败，请检查存储状态" : error instanceof Error ? error.message : "插件包无效",
                request_id: requestId,
            } }, status);
        }
    });
    return app;
}

class PackageInputError extends Error {
    constructor(readonly status: 400 | 413, message: string) { super(message); }
}

async function readPackage(request: Request): Promise<unknown> {
    const maxBytes = 2 * 1024 * 1024;
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new PackageInputError(400, "请上传 JSON 插件包");
    if (Number(request.headers.get("content-length")) > maxBytes) throw new PackageInputError(413, "插件包不能超过 2 MiB");
    const reader = request.body?.getReader();
    if (reader === undefined) throw new PackageInputError(400, "插件包不能为空");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
        while (true) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (size > maxBytes) { await reader.cancel(); throw new PackageInputError(413, "插件包不能超过 2 MiB"); }
            chunks.push(item.value);
        }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new PackageInputError(400, "插件包必须是有效 UTF-8 JSON"); }
}
