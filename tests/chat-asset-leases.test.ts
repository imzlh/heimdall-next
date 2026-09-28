import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import {
    CHAT_ASSET_LEASE_TTL_MS,
    ChatAssetService,
} from "@heimdall/core/chat/assets.ts";
import {
    openSqliteChatAssetStore,
    type SqliteChatAssetStore,
} from "@heimdall/core/storage/sqlite-assets.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";
import { createServer } from "../main.ts";

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const date = "2026-09-27T00:00:00.000Z";

Deno.test("normalizing a live image renews its old draft lease before a concurrent sweep", async () => {
    const chat = openSqliteChatStore(":memory:");
    const assets = openSqliteChatAssetStore(":memory:");
    let time = Date.parse(date);
    try {
        const service = new ChatAssetService(assets, {
            now: () => new Date(time),
        });
        const draft = await service.upload(bytes, "image/png");
        const other = await service.upload(
            new Uint8Array([...bytes, 1]),
            "image/png",
        );
        await assertRejects(
            () =>
                service.normalizeAttachments([{
                    ...other,
                    leaseId: draft.leaseId,
                }]),
            Error,
            "不匹配",
        );
        time += CHAT_ASSET_LEASE_TTL_MS;
        const normalized = await service.normalizeAttachments([draft]);
        // A different write performs cleanup after normalization and before append.
        service.sweep(chat);
        assert(assets.get(draft.assetId));
        assertEquals(normalized, [{
            assetId: draft.assetId,
            mediaType: draft.mediaType,
        }]);
        const conversation = chat.createConversation(
            "resumed",
            new Date(time).toISOString(),
        );
        chat.addMessage({
            id: "resumed",
            conversationId: conversation.id,
            role: "user",
            text: "image",
            createdAt: date,
            attachments: normalized,
        });
        service.consumeLeases([draft], chat);
        assertEquals(leaseIds(assets, draft.assetId), []);
        assert(assets.get(draft.assetId));
    } finally {
        chat.close();
        assets.close();
    }
});

function leaseIds(store: SqliteChatAssetStore, assetId: string): string[] {
    return store.db.prepare(
        "SELECT id FROM image_asset_leases WHERE asset_id = ? ORDER BY id",
    ).all(assetId).map((row) => String(row.id));
}

Deno.test("independent drafts share image bytes but consume and release only their own leases", async () => {
    const chat = openSqliteChatStore(":memory:");
    const assets = openSqliteChatAssetStore(":memory:");
    try {
        const service = new ChatAssetService(assets, {
            now: () => new Date(date),
        });
        const first = await service.upload(bytes, "image/png", "first.png");
        const second = await service.upload(bytes, "image/png", "second.png");
        assert(first.leaseId);
        assert(second.leaseId);
        assertEquals(first.assetId, second.assetId);
        assertFalse(first.leaseId === second.leaseId);
        assertEquals(
            leaseIds(assets, first.assetId),
            [first.leaseId, second.leaseId].sort(),
        );

        const conversation = chat.createConversation("first draft", date);
        chat.addMessage({
            id: "first-message",
            conversationId: conversation.id,
            role: "user",
            text: "saved image",
            createdAt: date,
            attachments: await service.normalizeAttachments([first]),
        });
        service.consumeLeases([first], chat);
        assertEquals(leaseIds(assets, first.assetId), [second.leaseId]);
        assert(assets.get(first.assetId));

        chat.deleteConversation(conversation.id);
        assertEquals(service.reclaim([first.assetId], chat), 0);
        assert(assets.get(first.assetId));
        assertFalse(service.releaseLease(first.assetId, first.leaseId, chat));
        assertEquals(leaseIds(assets, first.assetId), [second.leaseId]);
        assert(service.releaseLease(second.assetId, second.leaseId, chat));
        assertEquals(assets.get(first.assetId), null);
        assertEquals(leaseIds(assets, first.assetId), []);
    } finally {
        chat.close();
        assets.close();
    }
});

Deno.test("pending asset reclamation survives restart and waits for the last lease expiry", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-asset-leases-",
    });
    const chatPath = `${directory}/chat.sqlite`;
    const assetsPath = `${directory}/assets.sqlite`;
    let chat = openSqliteChatStore(chatPath);
    let assets = openSqliteChatAssetStore(assetsPath);
    let time = Date.parse(date);
    try {
        assertEquals(CHAT_ASSET_LEASE_TTL_MS, 24 * 60 * 60_000);
        let service = new ChatAssetService(assets, {
            now: () => new Date(time),
        });
        const draft = await service.upload(bytes, "image/png");
        assert(draft.leaseId);
        assertEquals(service.reclaim([draft.assetId], chat), 0);
        assertEquals(
            assets.db.prepare(
                "SELECT asset_id FROM image_asset_reclaim WHERE asset_id = ?",
            ).get(draft.assetId)?.asset_id,
            draft.assetId,
        );
        chat.close();
        assets.close();
        chat = openSqliteChatStore(chatPath);
        assets = openSqliteChatAssetStore(assetsPath);
        service = new ChatAssetService(assets, {
            now: () => new Date(time),
        });
        assertEquals(leaseIds(assets, draft.assetId), [draft.leaseId]);
        assertEquals(service.sweep(chat), 0);
        assert(assets.get(draft.assetId));
        time += CHAT_ASSET_LEASE_TTL_MS - 1;
        assertEquals(service.sweep(chat), 0);
        assert(assets.get(draft.assetId));
        time++;
        assertEquals(service.sweep(chat), 1);
        assertEquals(assets.get(draft.assetId), null);
        assertEquals(leaseIds(assets, draft.assetId), []);
        assertEquals(
            assets.db.prepare(
                "SELECT asset_id FROM image_asset_reclaim WHERE asset_id = ?",
            ).get(draft.assetId),
            undefined,
        );
        assertEquals(service.sweep(chat), 0);
    } finally {
        chat.close();
        assets.close();
        await Deno.remove(chatPath);
        await Deno.remove(assetsPath);
        await Deno.remove(directory);
    }
});

Deno.test("saved message snapshots omit lease credentials and saved references survive lease expiry", async () => {
    const chat = openSqliteChatStore(":memory:");
    const assets = openSqliteChatAssetStore(":memory:");
    let time = Date.parse(date);
    try {
        const service = new ChatAssetService(assets, {
            now: () => new Date(time),
        });
        const draft = await service.upload(bytes, "image/png");
        assert(draft.leaseId);
        const conversation = chat.createConversation("saved image", date);
        const message = {
            id: "saved-image-message",
            conversationId: conversation.id,
            role: "user" as const,
            text: "image",
            createdAt: date,
            attachments: await service.normalizeAttachments([draft]),
        };
        chat.addMessage(message);
        service.consumeLeases([draft], chat);
        assertEquals(leaseIds(assets, draft.assetId), []);
        const snapshots = [
            await service.presentMessages(
                chat.listMessages(conversation.id),
                chat,
            ),
            await service.presentMessages([{
                ...message,
                attachments: [draft],
            }], chat),
        ];
        for (const snapshot of snapshots) {
            assertEquals(snapshot[0]?.attachments?.[0]?.assetId, draft.assetId);
            assertFalse(JSON.stringify(snapshot).includes("leaseId"));
            assertFalse(JSON.stringify(snapshot).includes(draft.leaseId));
        }
        assertEquals(service.reclaim([draft.assetId], chat), 0);
        time += CHAT_ASSET_LEASE_TTL_MS;
        assertEquals(service.sweep(chat), 0);
        assertEquals(assets.read(draft.assetId)?.bytes, bytes);
    } finally {
        chat.close();
        assets.close();
    }
});

Deno.test("renewed leases are independent and a wrong lease cannot discard another draft", async () => {
    const chat = openSqliteChatStore(":memory:");
    const assets = openSqliteChatAssetStore(":memory:");
    try {
        const service = new ChatAssetService(assets, {
            now: () => new Date(date),
        });
        const first = await service.upload(bytes, "image/png");
        const renewed = service.lease(first.assetId);
        const other = await service.upload(
            new Uint8Array([...bytes, 1]),
            "image/png",
        );
        assert(first.leaseId);
        assert(renewed.leaseId);
        assert(other.leaseId);
        assertEquals(renewed.assetId, first.assetId);
        assertFalse(renewed.leaseId === first.leaseId);
        assertFalse(service.releaseLease(first.assetId, other.leaseId, chat));
        assertFalse(
            service.releaseLease(first.assetId, crypto.randomUUID(), chat),
        );
        assertEquals(
            leaseIds(assets, first.assetId),
            [first.leaseId, renewed.leaseId].sort(),
        );
        assertEquals(leaseIds(assets, other.assetId), [other.leaseId]);
        assert(service.releaseLease(first.assetId, first.leaseId, chat));
        assertEquals(service.reclaim([first.assetId], chat), 0);
        assertEquals(assets.read(first.assetId)?.bytes, bytes);
        assertEquals(leaseIds(assets, first.assetId), [renewed.leaseId]);
        assert(service.releaseLease(first.assetId, renewed.leaseId, chat));
        assertEquals(assets.get(first.assetId), null);
        assert(assets.get(other.assetId));
        assertEquals(leaseIds(assets, other.assetId), [other.leaseId]);
    } finally {
        chat.close();
        assets.close();
    }
});

Deno.test("a failed HTTP message write preserves the draft lease for retry", async () => {
    const chat = openSqliteChatStore(":memory:");
    const assets = openSqliteChatAssetStore(":memory:");
    try {
        const service = new ChatAssetService(assets, {
            now: () => new Date(date),
        });
        const draft = await service.upload(bytes, "image/png");
        assert(draft.leaseId);
        const conversation = chat.createConversation("failed write", date);
        const app = createServer({ chat: { store: chat, assets: service } });
        chat.addMessage = () => {
            throw new Error("simulated disk full");
        };
        const response = await app.request(
            "http://localhost/api/chat/message",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    conversationId: conversation.id,
                    model: "image-model",
                    text: "save image",
                    attachments: [draft],
                }),
            },
        );
        assertEquals(response.status, 500);
        await response.body?.cancel();
        assertEquals(chat.listMessages(conversation.id), []);
        assertEquals(leaseIds(assets, draft.assetId), [draft.leaseId]);
        assertEquals(service.reclaim([draft.assetId], chat), 0);
        assertEquals(assets.read(draft.assetId)?.bytes, bytes);
    } finally {
        chat.close();
        assets.close();
    }
});

Deno.test("an upload abandoned before sending is reclaimed when its draft lease expires", async () => {
    const chat = openSqliteChatStore(":memory:");
    const assets = openSqliteChatAssetStore(":memory:");
    let time = Date.parse(date);
    try {
        const service = new ChatAssetService(assets, {
            now: () => new Date(time),
        });
        const draft = await service.upload(bytes, "image/png");
        assert(draft.leaseId);
        assertEquals(service.sweep(chat), 0);
        time += CHAT_ASSET_LEASE_TTL_MS - 1;
        assertEquals(service.sweep(chat), 0);
        assertEquals(assets.read(draft.assetId)?.bytes, bytes);
        time++;
        assertEquals(service.sweep(chat), 1);
        assertEquals(assets.get(draft.assetId), null);
        assertEquals(leaseIds(assets, draft.assetId), []);
        assertEquals(service.sweep(chat), 0);
    } finally {
        chat.close();
        assets.close();
    }
});

Deno.test("HTTP draft leases preserve cookie and Bearer boundaries and release only the selected reservation", async () => {
    const chat = openSqliteChatStore(":memory:");
    const assets = openSqliteChatAssetStore(":memory:");
    const origin = "http://localhost";
    const token = "asset-lease-admin-token";
    try {
        const service = new ChatAssetService(assets, {
            now: () => new Date(date),
        });
        const draft = await service.upload(bytes, "image/png");
        assert(draft.leaseId);
        const app = createServer({
            adminAuthToken: token,
            chat: { store: chat, assets: service },
        });
        const login = await app.request(`${origin}/admin/session`, {
            method: "POST",
            headers: { origin },
            body: new URLSearchParams({ token }),
        });
        assertEquals(login.status, 303);
        const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
        await login.body?.cancel();
        const browserPath =
            `${origin}/admin/chat/api/assets/${draft.assetId}/lease`;
        const bearerPath = `${origin}/api/chat/assets/${draft.assetId}/lease`;
        for (const method of ["POST", "DELETE"]) {
            const suffix = method === "DELETE"
                ? `?leaseId=${draft.leaseId}`
                : "";
            for (
                const [headers, status] of [
                    [{ origin }, 401],
                    [{ cookie }, 403],
                    [{ cookie, origin: "https://attacker.example" }, 403],
                    [{ cookie, origin, "sec-fetch-site": "cross-site" }, 403],
                ] as const
            ) {
                const denied = await app.request(`${browserPath}${suffix}`, {
                    method,
                    headers,
                });
                assertEquals(denied.status, status);
                await denied.body?.cancel();
            }
            const cookieOnly = await app.request(`${bearerPath}${suffix}`, {
                method,
                headers: { cookie, origin },
            });
            assertEquals(cookieOnly.status, 401);
            await cookieOnly.body?.cancel();
        }
        assertEquals(leaseIds(assets, draft.assetId), [draft.leaseId]);

        const browserResponse = await app.request(browserPath, {
            method: "POST",
            headers: { cookie, origin, "x-request-id": "browser-asset-lease" },
        });
        assertEquals(browserResponse.status, 201);
        assertEquals(
            browserResponse.headers.get("x-heimdall-request-id"),
            "browser-asset-lease",
        );
        assertEquals(browserResponse.headers.get("cache-control"), "no-store");
        const browserLease = (await browserResponse.json()).attachment;
        const bearerResponse = await app.request(bearerPath, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
        });
        assertEquals(bearerResponse.status, 201);
        const bearerLease = (await bearerResponse.json()).attachment;
        for (const lease of [browserLease, bearerLease]) {
            assertEquals(lease.assetId, draft.assetId);
            assertEquals(lease.url, `/admin/chat/api/assets/${draft.assetId}`);
            assert(typeof lease.leaseId === "string");
            assertFalse(lease.leaseId === draft.leaseId);
            assertFalse("bytes" in lease);
            assertFalse("dataBase64" in lease);
            assertFalse(JSON.stringify(lease).includes(token));
        }
        assertFalse(browserLease.leaseId === bearerLease.leaseId);
        const expectedLeases = [
            draft.leaseId,
            browserLease.leaseId,
            bearerLease.leaseId,
        ].sort();
        assertEquals(leaseIds(assets, draft.assetId), expectedLeases);

        const wrongAsset = await app.request(
            `${origin}/admin/chat/api/assets/${crypto.randomUUID()}/lease?leaseId=${browserLease.leaseId}`,
            { method: "DELETE", headers: { cookie, origin } },
        );
        assertEquals(wrongAsset.status, 200);
        assertEquals(await wrongAsset.json(), { released: false });
        const invalidAsset = await app.request(
            `${origin}/admin/chat/api/assets/not-an-id/lease?leaseId=${browserLease.leaseId}`,
            { method: "DELETE", headers: { cookie, origin } },
        );
        assertEquals(invalidAsset.status, 400);
        await invalidAsset.body?.cancel();
        const ambiguousLease = await app.request(
            `${browserPath}?leaseId=${browserLease.leaseId}&leaseId=${draft.leaseId}`,
            { method: "DELETE", headers: { cookie, origin } },
        );
        assertEquals(ambiguousLease.status, 400);
        await ambiguousLease.body?.cancel();
        assertEquals(leaseIds(assets, draft.assetId), expectedLeases);

        const firstRelease = await app.request(
            `${browserPath}?leaseId=${draft.leaseId}`,
            { method: "DELETE", headers: { cookie, origin } },
        );
        assertEquals(firstRelease.status, 200);
        assertEquals(await firstRelease.json(), { released: true });
        assertEquals(
            leaseIds(assets, draft.assetId),
            [browserLease.leaseId, bearerLease.leaseId].sort(),
        );
        const secondRelease = await app.request(
            `${bearerPath}?leaseId=${browserLease.leaseId}`,
            { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
        );
        assertEquals(secondRelease.status, 200);
        assertEquals(await secondRelease.json(), { released: true });
        assertEquals(leaseIds(assets, draft.assetId), [bearerLease.leaseId]);
        assertEquals(assets.read(draft.assetId)?.bytes, bytes);
        const finalRelease = await app.request(
            `${browserPath}?leaseId=${bearerLease.leaseId}`,
            { method: "DELETE", headers: { cookie, origin } },
        );
        assertEquals(finalRelease.status, 200);
        assertEquals(await finalRelease.json(), { released: true });
        assertEquals(assets.get(draft.assetId), null);
        assertEquals(leaseIds(assets, draft.assetId), []);
    } finally {
        chat.close();
        assets.close();
    }
});
