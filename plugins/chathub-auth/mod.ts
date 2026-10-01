import type { ApiPlugin, PluginManifest } from "@heimdall/contracts";
import {
    completeLogin,
    refreshAccessToken,
    startLogin,
} from "../chathub-source/mod.ts";
import manifest from "./manifest.json" with { type: "json" };
import { SourceProxyError, SourceTransport } from "@heimdall/source-sdk/mod.ts";

/** Mounted only under the host's authenticated management API. */
export function createChatHubAuthPlugin(
    options: { readonly fetch?: typeof fetch } = {},
): ApiPlugin {
    return {
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
                return Response.json({
                    ok: false,
                    error: "请求必须使用 JSON。",
                }, {
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
                if (
                    !input || typeof input !== "object" || Array.isArray(input)
                ) {
                    throw new TypeError("请求无效");
                }
                const selected = context.resolveProxy?.(input.proxy);
                await using transport = new SourceTransport({
                    fetch: options.fetch,
                    getProxy: selected === undefined
                        ? undefined
                        : () => selected,
                    signal: context.signal,
                    secrets: [
                        typeof input.refreshToken === "string"
                            ? input.refreshToken
                            : undefined,
                    ],
                });
                const result = input.action === "start"
                    ? await startLogin()
                    : input.action === "exchange"
                    ? await completeLogin(
                        input,
                        context.signal,
                        transport.fetch,
                        (message) => transport.redact(message),
                    )
                    : input.action === "refresh" &&
                            typeof input.refreshToken === "string"
                    ? await refreshAccessToken(
                        input.refreshToken,
                        context.signal,
                        transport.fetch,
                        (message) => transport.redact(message),
                    )
                    : { ok: false as const, error: "未知的登录操作。" };
                if (!result.ok) result.error = transport.redact(result.error);
                return Response.json(result, {
                    status: result.ok ? 200 : 400,
                    headers,
                });
            } catch (error) {
                return Response.json({
                    ok: false,
                    error: error instanceof SourceProxyError
                        ? "所选代理不可用，请调整代理设置后重试。"
                        : "无法完成登录请求，请检查输入后重试。",
                }, { status: 400, headers });
            }
        },
    };
}

export default createChatHubAuthPlugin();
