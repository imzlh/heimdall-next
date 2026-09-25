import type { ApiPlugin, PluginManifest } from "@heimdall/contracts";
import {
    completeLogin,
    refreshAccessToken,
    startLogin,
} from "../chathub-source/mod.ts";
import manifest from "./manifest.json" with { type: "json" };

/** Mounted only under the host's authenticated management API. */
const plugin: ApiPlugin = {
    manifest: manifest as PluginManifest,
    async handle(context) {
        const headers = {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
        };
        if (
            context.request.headers.get("content-type")?.split(";")[0]
                ?.trim() !== "application/json"
        ) {
            return Response.json({ ok: false, error: "请求必须使用 JSON。" }, {
                status: 415,
                headers,
            });
        }
        try {
            const reader = context.request.body?.getReader();
            if (!reader) throw new TypeError("请求为空");
            const chunks: Uint8Array[] = [];
            let length = 0;
            try {
                while (true) {
                    const item = await reader.read();
                    if (item.done) break;
                    length += item.value.byteLength;
                    if (length > 65_536) {
                        await reader.cancel();
                        return Response.json(
                            { ok: false, error: "请求过大。" },
                            { status: 413, headers },
                        );
                    }
                    chunks.push(item.value);
                }
            } finally {
                reader.releaseLock();
            }
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
            }
            const input = JSON.parse(new TextDecoder().decode(bytes));
            if (!input || typeof input !== "object" || Array.isArray(input)) {
                throw new TypeError("请求无效");
            }
            const result = input.action === "start"
                ? await startLogin()
                : input.action === "exchange"
                ? await completeLogin(input, context.signal)
                : input.action === "refresh" &&
                        typeof input.refreshToken === "string"
                ? await refreshAccessToken(input.refreshToken, context.signal)
                : { ok: false, error: "未知的登录操作。" };
            return Response.json(result, {
                status: result.ok ? 200 : 400,
                headers,
            });
        } catch {
            return Response.json({
                ok: false,
                error: "无法完成登录请求，请检查输入后重试。",
            }, { status: 400, headers });
        }
    },
};
export default plugin;
