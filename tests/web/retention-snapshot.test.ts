import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import {
    configureAdminTransport,
    loadRuntimeSettings,
    saveRuntimeSettings,
} from "@heimdall/core/web/client/api/admin.ts";
import { ConsolePageView } from "@heimdall/core/web/pages/console.tsx";
import { loadConsoleSnapshot } from "@heimdall/core/web/server/snapshot.ts";

const response = {
    settings: {
        proxyKeyConfigured: true,
        proxyKey: "private-proxy-key",
        limitPerMinute: 120,
        probeIntervalMs: 300_000,
        titleModel: "",
        requestRetentionDays: 30,
        chatRetentionDays: 0,
    },
    maintenance: {
        enabled: true,
        running: false,
        lastRunAt: "2026-09-29T00:00:00.000Z",
        nextRunAt: "2026-09-29T01:00:00.000Z",
        prunedRequests: 12,
        prunedConversations: 3,
        prunedAssets: 5,
        lastError: null,
        internal: "private-worker-state",
    },
};

Deno.test("settings SSR includes policies and maintenance without JavaScript, and projects only public state into boot data", async () => {
    const snapshot = await loadConsoleSnapshot({
        authorized: true,
        adminAuthToken: "private-admin-token",
        includeActivity: false,
        dispatch(request) {
            return new URL(request.url).pathname === "/api/admin/settings"
                ? Response.json({
                    ...response,
                    maintenance: {
                        ...response.maintenance,
                        lastError: "清理失败 private-admin-token",
                    },
                }, { headers: { etag: '"retention-1"' } })
                : Response.json({ status: "ok" });
        },
    });
    assertEquals(snapshot.settings?.settings.requestRetentionDays, 30);
    assertEquals(snapshot.settings?.settings.chatRetentionDays, 0);
    assertEquals(snapshot.settings?.etag, '"retention-1"');
    assertEquals(
        snapshot.settings?.maintenance?.lastError,
        "清理失败 [已隐藏]",
    );
    const html = ConsolePageView({
        snapshot,
        page: "settings",
        contributions: [],
    }).toString();
    for (
        const text of [
            "数据保留",
            "请求记录保留",
            "30 天",
            "永久保留",
            "最后活动时间",
            "上传租约",
            "上次清理失败",
            "12 条请求记录",
            "3 个对话",
            "5 个附件",
            "2026-09-29 01:00:00 UTC",
        ]
    ) assertStringIncludes(html, text);
    for (
        const secret of [
            "private-proxy-key",
            "private-worker-state",
            "private-admin-token",
        ]
    ) {
        assertFalse(html.includes(secret));
        assertFalse(JSON.stringify(snapshot).includes(secret));
    }
    assertFalse(html.includes("立即清理"));
});

Deno.test("runtime settings GET and PUT retain safe maintenance data and reject malformed policy values", async () => {
    configureAdminTransport(() =>
        Promise.resolve(Response.json(response, {
            headers: { etag: '"retention-1"' },
        }))
    );
    try {
        const read = await loadRuntimeSettings();
        const saved = await saveRuntimeSettings(
            { chatRetentionDays: 0 },
            read.etag,
        );
        assertEquals(read, saved);
        assertEquals(read.settings.requestRetentionDays, 30);
        assertEquals(read.settings.chatRetentionDays, 0);
        assertEquals(read.maintenance?.prunedAssets, 5);
        assertFalse(JSON.stringify(read).includes("private-"));
        configureAdminTransport(() =>
            Promise.resolve(Response.json({
                settings: {
                    ...response.settings,
                    requestRetentionDays: -1,
                    chatRetentionDays: 0.5,
                },
                maintenance: {
                    ...response.maintenance,
                    lastRunAt: "invalid",
                    prunedAssets: -5,
                },
            }))
        );
        const malformed = await loadRuntimeSettings();
        assertEquals(malformed.settings.requestRetentionDays, undefined);
        assertEquals(malformed.settings.chatRetentionDays, undefined);
        assertEquals(malformed.maintenance?.lastRunAt, null);
        assertEquals(malformed.maintenance?.prunedAssets, 0);
    } finally {
        configureAdminTransport();
    }
});

Deno.test("settings SSR without a maintenance service explains the state and retains readable policy defaults", async () => {
    const snapshot = await loadConsoleSnapshot({
        authorized: true,
        includeActivity: false,
        dispatch(request) {
            return new URL(request.url).pathname === "/api/admin/settings"
                ? Response.json({ settings: response.settings })
                : Response.json({ status: "ok" });
        },
    });
    assertEquals(snapshot.settings?.maintenance, undefined);
    const html = ConsolePageView({
        snapshot,
        page: "settings",
        contributions: [],
    }).toString();
    assertStringIncludes(html, "未配置自动清理");
    assertStringIncludes(html, "当前实例未提供清理任务状态");
});

Deno.test("permanent history retention still displays the next orphan attachment maintenance run", async () => {
    const snapshot = await loadConsoleSnapshot({
        authorized: true,
        includeActivity: false,
        dispatch(request) {
            return new URL(request.url).pathname === "/api/admin/settings"
                ? Response.json({
                    settings: {
                        ...response.settings,
                        requestRetentionDays: 0,
                        chatRetentionDays: 0,
                    },
                    maintenance: { ...response.maintenance, enabled: false },
                })
                : Response.json({ status: "ok" });
        },
    });
    const html = ConsolePageView({
        snapshot,
        page: "settings",
        contributions: [],
    }).toString();
    assertStringIncludes(html, "仅回收闲置附件");
    assertStringIncludes(html, "请求记录与对话永久保留");
    assertStringIncludes(html, "2026-09-29 01:00:00 UTC");
    assertFalse(html.includes("自动清理已停用"));
});
