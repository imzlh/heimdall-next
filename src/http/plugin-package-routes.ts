import { Hono } from "hono";
import type { AdminRouteContext } from "./admin-routes.ts";
import type { ServerEnv } from "./app.ts";
import {
    PluginLifecycleError,
    PluginVerificationError,
} from "@heimdall/plugin-host";
import { StorageConflictError } from "@heimdall/storage";

export type InstallPluginHandler = (
    context: AdminRouteContext,
    input: unknown,
) => Promise<unknown>;

export type UpgradePluginHandler = (
    context: AdminRouteContext,
    pluginId: string,
    input: unknown,
    revision: string,
) => Promise<unknown>;

export type RollbackPluginHandler = (
    context: AdminRouteContext,
    pluginId: string,
    revision: string,
) => Promise<unknown>;

/** Mounted inside the authenticated admin route group, including the UI session bridge. */
export function createPluginPackageRoutes(
    install: InstallPluginHandler | undefined,
    upgrade?: UpgradePluginHandler,
    rollback?: RollbackPluginHandler,
): Hono<ServerEnv> {
    const app = new Hono<ServerEnv>();
    for (const action of ["install", "upgrade", "rollback"] as const) {
        if (
            action === "install" && !install ||
            action === "upgrade" && !upgrade ||
            action === "rollback" && !rollback
        ) continue;
        app.on(
            action === "upgrade" ? "PATCH" : "POST",
            action === "rollback" ? "/plugin-rollback" : "/plugin-package",
            async (context) => {
                const requestId = context.get("requestId") ||
                    crypto.randomUUID();
                try {
                    const input = await readPackage(
                        context.req.raw,
                        action === "upgrade" ? 4096 : 0,
                    );
                    const adminContext = {
                        request: context.req.raw,
                        requestId,
                    };
                    let plugin: unknown;
                    if (action === "install") {
                        plugin = await install!(adminContext, input);
                    } else {
                        if (
                            !input || typeof input !== "object" ||
                            Array.isArray(input)
                        ) {
                            throw new TypeError("插件操作必须是 JSON 对象");
                        }
                        const body = input as Record<string, unknown>;
                        if (
                            action === "upgrade" &&
                            new TextEncoder().encode(
                                    JSON.stringify(body.package) ?? "",
                                ).byteLength > 2 * 1024 * 1024
                        ) {
                            throw new PackageInputError(
                                413,
                                "插件包不能超过 2 MiB",
                            );
                        }
                        if (
                            typeof body.pluginId !== "string" ||
                            !body.pluginId || body.pluginId.length > 128 ||
                            typeof body.revision !== "string" ||
                            !body.revision || body.revision.length > 256
                        ) {
                            throw new TypeError(
                                "插件 ID 和当前 revision 必填，请刷新后重试",
                            );
                        }
                        plugin = action === "upgrade"
                            ? await upgrade!(
                                adminContext,
                                body.pluginId,
                                body.package,
                                body.revision,
                            )
                            : await rollback!(
                                adminContext,
                                body.pluginId,
                                body.revision,
                            );
                    }
                    return context.json(
                        { plugin },
                        action === "install" ? 201 : 200,
                    );
                } catch (error) {
                    const status = error instanceof PackageInputError
                        ? error.status
                        : error instanceof TypeError ||
                                error instanceof PluginVerificationError
                        ? 400
                        : error instanceof StorageConflictError ||
                                error instanceof PluginLifecycleError
                        ? 409
                        : 500;
                    return context.json({
                        error: {
                            code: status === 413
                                ? "payload_too_large"
                                : status === 409
                                ? "plugin_conflict"
                                : status === 500
                                ? `plugin_${action}_failed`
                                : "invalid_plugin_package",
                            message: status === 500
                                ? "插件操作失败，请检查插件与存储状态"
                                : error instanceof Error
                                ? error.message
                                : "插件包无效",
                            request_id: requestId,
                        },
                    }, status);
                }
            },
        );
    }
    return app;
}

class PackageInputError extends Error {
    constructor(readonly status: 400 | 413, message: string) {
        super(message);
    }
}

async function readPackage(
    request: Request,
    envelopeBytes = 0,
): Promise<unknown> {
    const maxBytes = 2 * 1024 * 1024 + envelopeBytes;
    if (
        request.headers.get("content-type")?.split(";")[0]?.trim()
            .toLowerCase() !== "application/json"
    ) throw new PackageInputError(400, "请上传 JSON 插件包");
    if (Number(request.headers.get("content-length")) > maxBytes) {
        throw new PackageInputError(413, "插件包不能超过 2 MiB");
    }
    const reader = request.body?.getReader();
    if (reader === undefined) {
        throw new PackageInputError(400, "插件包不能为空");
    }
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
        while (true) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (size > maxBytes) {
                await reader.cancel();
                throw new PackageInputError(413, "插件包不能超过 2 MiB");
            }
            chunks.push(item.value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    try {
        return JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
    } catch {
        throw new PackageInputError(400, "插件包必须是有效 UTF-8 JSON");
    }
}
