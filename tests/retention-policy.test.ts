import { assert, assertEquals, assertRejects } from "@std/assert";
import {
    CHAT_ASSET_LEASE_TTL_MS,
    ChatAssetService,
} from "@heimdall/core/chat/assets.ts";
import { withConversationRun } from "@heimdall/core/chat/runs.ts";
import { runRetentionSweep } from "@heimdall/core/composition/maintenance.ts";
import { startRetentionMaintenance } from "@heimdall/core/composition/retention-runtime.ts";
import {
    createRuntimeSettings,
    hydrateRuntimeSettings,
    saveRuntimeSettings,
} from "@heimdall/core/composition/runtime-settings.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";
import { openSqliteChatAssetStore } from "@heimdall/core/storage/sqlite-assets.ts";
import { StorageConflictError } from "@heimdall/storage";
import { loadBuiltinComposition } from "@heimdall/core/composition/builtins.ts";
import { createServer } from "../main.ts";

const old = "2026-08-01T00:00:00.000Z";
const current = "2026-09-29T12:00:00.000Z";
const requests = { pruneOlderThan: () => ({ deleted: 0, done: true }) };
const noAssets = { queueReclaim: () => {}, sweep: () => 0 };

Deno.test("retention uses last activity, skips active commands, and reclaims all expired branches without deleting fork or draft assets", async () => {
    const chat = openSqliteChatStore(":memory:");
    const assetStore = openSqliteChatAssetStore(":memory:");
    let time = Date.parse(current);
    const assets = new ChatAssetService(assetStore, {
        now: () => new Date(time),
    });
    const gate = Promise.withResolvers<void>();
    let running: Promise<void> | undefined;
    try {
        const expired = chat.createConversation("expired", old);
        const active = chat.createConversation("active generation", old);
        const touched = chat.createConversation("old but recently used", old);
        chat.updateConversation(touched.id, { updatedAt: current });
        running = withConversationRun(chat, active.id, () => gate.promise);
        const uploaded = [];
        for (let n = 0; n < 3; n++) {
            const image = await assets.upload(
                new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, n]),
                "image/png",
            );
            uploaded.push(image);
            chat.addMessage({
                id: `image-${n}`,
                conversationId: expired.id,
                role: "user",
                text: "image",
                createdAt: old,
                parentId: null,
                attachments: await assets.normalizeAttachments([image]),
            });
            assets.consumeLeases([image], chat);
        }
        // The first image also belongs to a fresh fork. The third is an inactive branch.
        const fork = chat.forkConversation(expired.id, "image-0", current);
        chat.selectBranch(expired.id, "image-1", old);
        const leased = await assets.upload(
            new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]),
            "image/png",
        );
        assertEquals(leased.assetId, uploaded[1]!.assetId);
        const options = {
            requests,
            chat,
            assets,
            requestRetentionDays: 0,
            chatRetentionDays: 7,
            now: () => new Date(time),
        };
        const first = runRetentionSweep(options);
        assertEquals(first, {
            prunedRequests: 0,
            prunedConversations: 1,
            prunedAssets: 1,
            errors: [],
        });
        assertEquals(chat.getConversation(expired.id), null);
        assert(chat.getConversation(active.id));
        assert(chat.getConversation(touched.id));
        assert(chat.getConversation(fork.id));
        assert(assetStore.get(uploaded[0]!.assetId));
        assert(assetStore.get(uploaded[1]!.assetId));
        assertEquals(assetStore.get(uploaded[2]!.assetId), null);
        gate.resolve();
        await running;
        time += CHAT_ASSET_LEASE_TTL_MS;
        const second = runRetentionSweep(options);
        assertEquals(second.prunedConversations, 1);
        assertEquals(second.prunedAssets, 1);
        assertEquals(chat.getConversation(active.id), null);
        assertEquals(assetStore.get(leased.assetId), null);
        assert(assetStore.get(uploaded[0]!.assetId));
    } finally {
        gate.resolve();
        await running;
        assetStore.close();
        chat.close();
    }
});

Deno.test("retention scans bounded keyset batches and keeps both histories when disabled", () => {
    const chat = openSqliteChatStore(":memory:");
    try {
        for (let n = 0; n < 61; n++) chat.createConversation(`old-${n}`, old);
        const options = {
            requests,
            chat,
            assets: noAssets,
            requestRetentionDays: 0,
            chatRetentionDays: 0,
            maxConversations: 30,
            now: () => new Date(current),
        };
        assertEquals(runRetentionSweep(options).prunedConversations, 0);
        assertEquals(chat.listConversations(100).length, 61);
        assertEquals(
            runRetentionSweep({ ...options, chatRetentionDays: 30 })
                .prunedConversations,
            30,
        );
        assertEquals(
            runRetentionSweep({ ...options, chatRetentionDays: 30 })
                .prunedConversations,
            30,
        );
        assertEquals(
            runRetentionSweep({ ...options, chatRetentionDays: 30 })
                .prunedConversations,
            1,
        );
        assertEquals(chat.listConversations().length, 0);
    } finally {
        chat.close();
    }
});

Deno.test("failed cleanup preserves partial counts and never deletes history before queuing assets", () => {
    const chat = openSqliteChatStore(":memory:");
    try {
        const conversation = chat.createConversation(
            "protected by failed queue",
            old,
        );
        let batches = 0;
        const result = runRetentionSweep({
            requests: {
                pruneOlderThan: () => {
                    if (++batches > 1) throw new Error("private request text");
                    return { deleted: 500, done: false };
                },
            },
            chat,
            assets: {
                queueReclaim: () => {
                    throw new Error("private asset metadata");
                },
                sweep: () => 0,
            },
            requestRetentionDays: 30,
            chatRetentionDays: 30,
            now: () => new Date(current),
        });
        assertEquals(result.prunedRequests, 500);
        assertEquals(result.prunedConversations, 0);
        assertEquals(result.errors, ["请求记录清理失败", "对话清理失败"]);
        assert(chat.getConversation(conversation.id));
    } finally {
        chat.close();
    }
});

Deno.test("saved retention survives durable restart, uses CAS, and restores the last maintenance summary", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-retention-" });
    const path = `${directory}/settings.sqlite`;
    let kv = await Deno.openKv(path);
    const chat = openSqliteChatStore(":memory:");
    const logs: string[] = [];
    const logger = {
        debug: () => {},
        info: (scope: string, message: string) => {
            logs.push(`${scope}: ${message}`);
        },
        warn: (scope: string, message: string) => {
            logs.push(`${scope}: ${message}`);
        },
        error: () => {},
    };
    const seed = {
        proxyKey: "",
        limitPerMinute: 120,
        probeIntervalMs: 0,
        requestRetentionDays: 0,
        chatRetentionDays: 0,
    };
    try {
        const store = new DenoKvConfigStore(kv);
        const settings = createRuntimeSettings(seed);
        const saved = await saveRuntimeSettings(store, settings, {
            requestRetentionDays: 30,
            chatRetentionDays: 7,
        });
        assertEquals(saved.settings.chatRetentionDays, 7);
        await assertRejects(
            () =>
                saveRuntimeSettings(
                    store,
                    settings,
                    { chatRetentionDays: 1 },
                    "stale",
                ),
            StorageConflictError,
        );
        await assertRejects(
            () =>
                saveRuntimeSettings(store, settings, {
                    requestRetentionDays: 1.5,
                }, settings.versionstamp()),
            TypeError,
        );
        chat.createConversation("expired private text", old);
        const runtime = await startRetentionMaintenance({
            store,
            settings,
            requests,
            chat,
            assets: noAssets,
            now: () => new Date(current),
            logger,
        });
        await runtime.run();
        const before = runtime.snapshot();
        assertEquals(before.prunedConversations, 1);
        assertEquals(before.lastRunAt, current);
        assertEquals(before.nextRunAt, "2026-09-29T13:00:00.000Z");
        assertEquals(before.running, false);
        assertEquals(before.lastError, null);
        assertEquals(logs, [
            "maintenance: 已清理 0 条请求记录、1 个对话、0 个未引用附件。",
        ]);
        await runtime[Symbol.asyncDispose]();
        kv.close();
        kv = await Deno.openKv(path);
        const restartedStore = new DenoKvConfigStore(kv);
        const restartedSettings = createRuntimeSettings({
            ...seed,
            requestRetentionDays: 90,
        });
        await hydrateRuntimeSettings(restartedStore, restartedSettings);
        assertEquals(restartedSettings.get().requestRetentionDays, 30);
        assertEquals(restartedSettings.get().chatRetentionDays, 7);
        await using restarted = await startRetentionMaintenance({
            store: restartedStore,
            settings: restartedSettings,
            requests,
            chat,
            assets: noAssets,
            now: () => new Date(current),
        });
        assertEquals(restarted.snapshot(), before);
        await saveRuntimeSettings(restartedStore, restartedSettings, {
            requestRetentionDays: 0,
            chatRetentionDays: 0,
        }, restartedSettings.versionstamp());
        assertEquals(restarted.snapshot().enabled, false);
        assertEquals(restarted.snapshot().nextRunAt, current);
        chat.createConversation("keep forever", old);
        await restarted.run();
        assertEquals(restarted.snapshot().prunedConversations, 0);
        assertEquals(chat.listConversations().length, 1);
    } finally {
        kv.close();
        chat.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("legacy settings preserve the env retention seed until the operator saves a policy", async () => {
    const kv = await Deno.openKv(":memory:");
    try {
        const store = new DenoKvConfigStore(kv);
        await store.namespace("heimdall", "settings").set(["runtime"], {
            proxyKey: "legacy",
            limitPerMinute: 1,
            probeIntervalMs: 0,
        });
        const settings = createRuntimeSettings({
            proxyKey: "",
            limitPerMinute: 0,
            probeIntervalMs: 0,
            requestRetentionDays: 14,
            chatRetentionDays: 0,
        });
        await hydrateRuntimeSettings(store, settings);
        assertEquals(settings.get().requestRetentionDays, 14);
        await saveRuntimeSettings(
            store,
            settings,
            { requestRetentionDays: 0 },
            settings.versionstamp(),
        );
        await hydrateRuntimeSettings(store, settings);
        assertEquals(settings.get().requestRetentionDays, 0);
    } finally {
        kv.close();
    }
});

Deno.test("admin settings validates retention atomically, publishes maintenance, and enforces a fresh settings revision", async () => {
    const kv = await Deno.openKv(":memory:");
    const settings = createRuntimeSettings({
        proxyKey: "private-gateway-key",
        limitPerMinute: 120,
        probeIntervalMs: 0,
    });
    const maintenance = {
        enabled: true,
        running: false,
        lastRunAt: current,
        nextRunAt: "2026-09-29T13:00:00.000Z",
        prunedRequests: 2,
        prunedConversations: 1,
        prunedAssets: 3,
        lastError: null,
    };
    const composition = await loadBuiltinComposition({
        configStore: new DenoKvConfigStore(kv),
        runtimeSettings: settings,
        maintenanceStatus: () => maintenance,
        env: () => undefined,
    });
    const app = createServer({ adminManagement: composition.management });
    const put = (body: unknown, revision?: string) =>
        app.request("http://localhost/api/admin/settings", {
            method: "PUT",
            headers: {
                "content-type": "application/json",
                ...(revision ? { "if-match": revision } : {}),
            },
            body: JSON.stringify(body),
        });
    try {
        const saved = await put({
            requestRetentionDays: 30,
            chatRetentionDays: 7,
        });
        assertEquals(saved.status, 200);
        const revision = saved.headers.get("etag")!;
        const body = await saved.json();
        assertEquals(body.settings.requestRetentionDays, 30);
        assertEquals(body.settings.chatRetentionDays, 7);
        assertEquals(body.maintenance, maintenance);
        assertEquals(
            JSON.stringify(body).includes("private-gateway-key"),
            false,
        );
        for (const invalid of [-1, 0.5, 3651, "30", null]) {
            const response = await put({
                requestRetentionDays: 1,
                chatRetentionDays: invalid,
            }, revision);
            assertEquals(response.status, 400);
            await response.body?.cancel();
            assertEquals(settings.get().requestRetentionDays, 30);
            assertEquals(settings.get().chatRetentionDays, 7);
        }
        const conflict = await put({ chatRetentionDays: 0 }, "stale");
        assertEquals(conflict.status, 409);
        await conflict.body?.cancel();
        const cleared = await put({ chatRetentionDays: 0 }, revision);
        assertEquals(cleared.status, 200);
        await cleared.body?.cancel();
        const read = await app.request("http://localhost/api/admin/settings");
        const currentSettings = await read.json();
        assertEquals(currentSettings.settings.chatRetentionDays, 0);
        assertEquals(currentSettings.settings.requestRetentionDays, 30);
        assertEquals(currentSettings.maintenance, maintenance);
    } finally {
        await composition.close();
        kv.close();
    }
});
