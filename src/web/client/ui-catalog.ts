import {
    parseUiCatalog,
    UI_CATALOG_LIMITS,
    type UiCatalog,
} from "@heimdall/admin-contracts/ui-catalog.ts";

/** Refresh only JSON metadata through the cookie-authenticated web boundary. */
export async function loadUiCatalog(): Promise<UiCatalog> {
    const response = await fetch("/admin/ui/catalog", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
            response.status === 401
                ? "后台会话已过期，请重新登录。"
                : "插件目录刷新失败，请重试。",
        );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("插件目录响应为空。");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    let length = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > UI_CATALOG_LIMITS.bytes) {
                await reader.cancel();
                throw new Error("插件目录超出大小限制。");
            }
            text += decoder.decode(chunk.value, { stream: true });
        }
        return parseUiCatalog(JSON.parse(text + decoder.decode()));
    } finally {
        reader.releaseLock();
    }
}
