import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import {
    CHAT_ASSET_LEASE_TTL_MS,
    ChatAssetError,
    ChatAssetService,
} from "@heimdall/core/chat/assets.ts";
import { openSqliteChatAssetStore } from "@heimdall/core/storage/sqlite-assets.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";

const date = "2026-09-29T12:00:00.000Z";
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const inline = { mediaType: "image/png", dataBase64: "iVBORw0KGgo=" };

Deno.test("partial inline normalization remains protected then reclaims its orphan across restart", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-inline-recovery-",
    });
    const path = `${directory}/assets.sqlite`;
    let store = openSqliteChatAssetStore(path);
    const chat = openSqliteChatStore(":memory:");
    let time = Date.parse(date);
    try {
        let assets = new ChatAssetService(store, { now: () => new Date(time) });
        await assertRejects(
            () =>
                assets.normalizeAttachments([
                    inline,
                    { assetId: "invalid-id", mediaType: "image/png" },
                ]),
            ChatAssetError,
        );
        const id = String(
            store.db.prepare("SELECT id FROM image_assets").get()?.id,
        );
        assert(store.get(id));
        assertEquals(assets.sweep(chat), 0);
        assertEquals(
            store.db.prepare("SELECT count(*) AS total FROM image_asset_leases")
                .get()?.total,
            1,
        );
        assertEquals(
            store.db.prepare(
                "SELECT count(*) AS total FROM image_asset_reclaim",
            ).get()?.total,
            1,
        );

        store.close();
        store = openSqliteChatAssetStore(path);
        assets = new ChatAssetService(store, { now: () => new Date(time) });
        time += CHAT_ASSET_LEASE_TTL_MS - 1;
        assertEquals(assets.sweep(chat), 0);
        assertEquals(store.read(id)?.bytes, bytes);
        time++;
        assertEquals(assets.sweep(chat), 1);
        assertEquals(store.get(id), null);
        assertEquals(assets.sweep(chat), 0);
    } finally {
        store.close();
        chat.close();
        await Deno.remove(path);
        await Deno.remove(directory);
    }
});

Deno.test("inline conversion atomically protects pending bytes and preserves committed or independently leased images", async () => {
    const store = openSqliteChatAssetStore(":memory:");
    const chat = openSqliteChatStore(":memory:");
    let time = Date.parse(date);
    try {
        const assets = new ChatAssetService(store, {
            now: () => new Date(time),
        });
        const write = store.put.bind(store);
        let writes = 0;
        // Stand in for maintenance after each write, before normalize/migration
        // resumes from its await and commits the corresponding history refs.
        store.put = (...args) => {
            const result = write(...args);
            writes++;
            assertEquals(assets.sweep(chat), 0);
            assert(store.get(result.id));
            return result;
        };
        const conversation = chat.createConversation("legacy", date);
        chat.addMessage({
            id: "legacy-images",
            conversationId: conversation.id,
            role: "user",
            text: "two pictures",
            createdAt: date,
            attachments: [inline, {
                mediaType: "image/png",
                dataBase64: "iVBORw0KGgoB",
            }],
        });
        assertEquals(await assets.migrateHistory(chat), 1);
        assertEquals(writes, 2);
        const history = chat.listMessages(conversation.id);
        const ids = history[0]!.attachments!.map((attachment) =>
            attachment.assetId!
        );
        assertEquals(new Set(ids).size, 2);
        assertFalse(JSON.stringify(history).includes("leaseId"));
        const presented = await assets.presentMessages(history, chat);
        assertFalse(JSON.stringify(presented).includes("leaseId"));
        assertFalse(JSON.stringify(presented).includes("dataBase64"));

        // Another browser draft has a separate reservation on the same bytes.
        time += CHAT_ASSET_LEASE_TTL_MS - 1;
        const draft = await assets.upload(bytes, "image/png");
        assertEquals(draft.assetId, ids[0]);
        time++;
        assertEquals(assets.sweep(chat), 0);
        for (const id of ids) assert(store.get(id));
        assets.queueReclaim(ids);
        chat.deleteConversation(conversation.id);
        assertEquals(assets.sweep(chat), 1);
        assert(store.get(draft.assetId));
        assert(assets.releaseLease(draft.assetId, draft.leaseId!, chat));
        assertEquals(store.get(draft.assetId), null);
    } finally {
        store.close();
        chat.close();
    }
});

Deno.test("failed inline history replacement keeps original bytes and makes retryable copies reclaimable", async () => {
    for (const path of ["migration", "presentation"] as const) {
        const store = openSqliteChatAssetStore(":memory:");
        const chat = openSqliteChatStore(":memory:");
        let time = Date.parse(date);
        try {
            const assets = new ChatAssetService(store, {
                now: () => new Date(time),
            });
            const conversation = chat.createConversation("legacy", date);
            chat.addMessage({
                id: "legacy",
                conversationId: conversation.id,
                role: "user",
                text: "picture",
                createdAt: date,
                attachments: [inline],
            });
            const replace = chat.replaceMessageAttachments.bind(chat);
            chat.replaceMessageAttachments = () => {
                throw new Error("simulated history write failure");
            };
            const convert = () =>
                path === "migration"
                    ? assets.migrateHistory(chat)
                    : assets.presentMessages(
                        chat.listMessages(conversation.id),
                        chat,
                    );
            await assertRejects(
                convert,
                Error,
                "simulated history write failure",
            );
            assertEquals(chat.listMessages(conversation.id)[0]!.attachments, [
                inline,
            ]);
            assertEquals(
                store.db.prepare("SELECT count(*) AS total FROM image_assets")
                    .get()?.total,
                1,
            );
            assertEquals(assets.sweep(chat), 0);
            time += CHAT_ASSET_LEASE_TTL_MS;
            assertEquals(assets.sweep(chat), 1);
            assertEquals(chat.listMessages(conversation.id)[0]!.attachments, [
                inline,
            ]);
            chat.replaceMessageAttachments = replace;
            await convert();
            const restored = chat.listMessages(conversation.id)[0]!
                .attachments![0]!;
            assert(restored.assetId);
            assertEquals(store.read(restored.assetId)?.bytes, bytes);
            assertFalse(
                JSON.stringify(
                    await assets.presentMessages(
                        chat.listMessages(conversation.id),
                        chat,
                    ),
                ).includes("leaseId"),
            );
            time += CHAT_ASSET_LEASE_TTL_MS;
            assertEquals(assets.sweep(chat), 0);
            assert(store.get(restored.assetId));
        } finally {
            store.close();
            chat.close();
        }
    }
});
