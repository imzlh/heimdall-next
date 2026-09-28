import { Hono } from "hono";
import type { Context, Handler } from "hono";
import type { ServerApp, ServerEnv } from "./app.ts";
import {
    assertMediaType,
    CHAT_ASSET_MAX_BYTES,
    ChatAssetError,
    type ChatAssetReferences,
    type ChatAssetService,
} from "../chat/assets.ts";

/** Mounted inside the existing Bearer/cookie Chat boundary, including uploads. */
export function createChatAssetRoutes(
    assets: ChatAssetService,
    chat?: ChatAssetReferences,
): ServerApp {
    const app = new Hono<ServerEnv>();
    app.post(
        "/assets",
        guarded(async (context) => {
            const mediaType =
                context.req.header("content-type")?.split(";")[0]?.trim()
                    .toLowerCase() ?? "";
            assertMediaType(mediaType);
            let name: string | undefined;
            try {
                const encoded = context.req.header("x-file-name");
                if (encoded && encoded.length <= 2048) {
                    name = decodeURIComponent(encoded);
                }
            } catch {
                throw new ChatAssetError(
                    400,
                    "invalid_file_name",
                    "图片文件名无效。",
                );
            }
            const bytes = await readImageBytes(context.req.raw);
            const attachment = await assets.upload(bytes, mediaType, name);
            if (chat) assets.sweep(chat);
            return Response.json({ attachment }, { status: 201 });
        }),
    );
    app.get("/assets/:id", guarded((context) => readAsset(context, assets)));
    app.post(
        "/assets/:id/lease",
        guarded((context) => {
            const attachment = assets.lease(context.req.param("id")!);
            if (chat) assets.sweep(chat);
            return Response.json({ attachment }, { status: 201 });
        }),
    );
    app.delete(
        "/assets/:id/lease",
        guarded((context) => {
            const query = new URL(context.req.url).searchParams;
            if (query.getAll("leaseId").length !== 1) {
                throw new ChatAssetError(
                    400,
                    "invalid_asset_lease",
                    "图片草稿引用无效。",
                );
            }
            const released = assets.releaseLease(
                context.req.param("id")!,
                query.get("leaseId")!,
                chat,
            );
            return Response.json({ released });
        }),
    );
    return app;
}

/** This group has its own capability token and is never mounted in cookie Chat. */
export function createChatAssetLinkRoutes(assets: ChatAssetService): ServerApp {
    const app = new Hono<ServerEnv>();
    app.get(
        "/:id",
        guarded(async (context) => {
            const url = new URL(context.req.url);
            const valid = url.searchParams.getAll("exp").length === 1 &&
                url.searchParams.getAll("sig").length === 1 &&
                await assets.links.verify(
                    context.req.param("id")!,
                    url.searchParams.get("exp"),
                    url.searchParams.get("sig"),
                );
            if (!valid) {
                throw new ChatAssetError(
                    403,
                    "invalid_asset_link",
                    "图片链接无效或已过期。",
                );
            }
            return readAsset(context, assets);
        }),
    );
    return app;
}

function readAsset(
    context: Context<ServerEnv>,
    assets: ChatAssetService,
): Response {
    const asset = assets.get(context.req.param("id")!);
    const data = assets.store.read(asset.id);
    if (!data) {
        throw new ChatAssetError(
            404,
            "asset_not_found",
            "图片不存在或已删除。",
        );
    }
    return new Response(new Uint8Array(data.bytes), {
        headers: {
            "content-type": asset.mediaType,
            "content-length": String(asset.size),
            "content-disposition": "inline",
            "content-security-policy": "default-src 'none'; sandbox",
        },
    });
}

/** Per-handler guards survive the host's explicit-route copying. */
function guarded(
    action: (context: Context<ServerEnv>) => Response | Promise<Response>,
): Handler<ServerEnv> {
    return async (context) => {
        const requestId = context.get("requestId") ||
            context.req.header("x-request-id") || crypto.randomUUID();
        let response: Response;
        try {
            response = await action(context);
        } catch (error) {
            response = Response.json({
                error: error instanceof ChatAssetError
                    ? {
                        code: error.code,
                        message: error.message,
                        request_id: requestId,
                    }
                    : {
                        code: "asset_unavailable",
                        message: "暂时无法读取或保存图片。",
                        request_id: requestId,
                    },
            }, {
                status: error instanceof ChatAssetError ? error.status : 500,
            });
        }
        response.headers.set("cache-control", "no-store");
        response.headers.set("x-content-type-options", "nosniff");
        response.headers.set("referrer-policy", "no-referrer");
        response.headers.set("x-heimdall-request-id", requestId);
        return response;
    };
}

async function readImageBytes(request: Request): Promise<Uint8Array> {
    const length = request.headers.get("content-length");
    if (
        length !== null &&
        (!/^\d+$/.test(length) || Number(length) > CHAT_ASSET_MAX_BYTES)
    ) {
        throw new ChatAssetError(
            413,
            "payload_too_large",
            "每张图片最多 5 MB。",
        );
    }
    if (!request.body) return new Uint8Array();
    const reader = request.body.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];
    try {
        while (true) {
            const item = await reader.read();
            if (item.done) break;
            total += item.value.byteLength;
            if (total > CHAT_ASSET_MAX_BYTES) {
                await reader.cancel();
                throw new ChatAssetError(
                    413,
                    "payload_too_large",
                    "每张图片最多 5 MB。",
                );
            }
            chunks.push(item.value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}
