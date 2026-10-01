import { assert, assertEquals } from "@std/assert";
import { createServer } from "../main.ts";
import { ChatAssetService } from "@heimdall/core/chat/assets.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";
import { openSqliteChatAssetStore } from "@heimdall/core/storage/sqlite-assets.ts";

const time = "2026-09-29T00:00:00.000Z";
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function deletionPath(
    kind: "conversation" | "message",
    conversationId: string,
) {
    return kind === "conversation"
        ? `http://localhost/api/chat/conversation?id=${conversationId}`
        : `http://localhost/api/chat/message?conversationId=${conversationId}&id=target`;
}

Deno.test("manual deletion persists asset candidates before mutation, and failed deletion cannot reclaim live references", async (test) => {
    for (const kind of ["conversation", "message"] as const) {
        await test.step(kind, async () => {
            const chat = openSqliteChatStore(":memory:");
            const assetStore = openSqliteChatAssetStore(":memory:");
            try {
                const assets = new ChatAssetService(assetStore);
                const image = await assets.upload(bytes, "image/png");
                const conversation = chat.createConversation("kept", time);
                chat.addMessage({
                    id: "target",
                    conversationId: conversation.id,
                    role: "user",
                    text: "kept",
                    createdAt: time,
                    attachments: await assets.normalizeAttachments([image]),
                });
                assets.consumeLeases([image], chat);
                const app = createServer({ chat: { store: chat, assets } });
                const path = deletionPath(kind, conversation.id);
                const mark = assetStore.markForReclaim.bind(assetStore);
                assetStore.markForReclaim = () => {
                    throw new Error("reclaim queue unavailable");
                };
                const queueFailure = await app.request(path, {
                    method: "DELETE",
                });
                assertEquals(queueFailure.status, 500);
                await queueFailure.body?.cancel();
                assert(chat.getConversation(conversation.id));
                assertEquals(
                    chat.listMessages(conversation.id).map((row) => row.id),
                    ["target"],
                );
                assert(assetStore.get(image.assetId));
                assetStore.markForReclaim = mark;
                if (kind === "conversation") {
                    chat.deleteConversation = () => {
                        throw new Error("history transaction failed");
                    };
                } else {
                    chat.deleteMessages = () => {
                        throw new Error("history transaction failed");
                    };
                }
                const deletionFailure = await app.request(path, {
                    method: "DELETE",
                });
                assertEquals(deletionFailure.status, 500);
                await deletionFailure.body?.cancel();
                assertEquals(
                    assetStore.db.prepare(
                        "SELECT COUNT(*) AS count FROM image_asset_reclaim",
                    ).get()?.count,
                    1,
                );
                assertEquals(assets.sweep(chat), 0);
                assert(assetStore.get(image.assetId));
                assertEquals(
                    chat.listMessages(conversation.id).map((row) => row.id),
                    ["target"],
                );
            } finally {
                chat.close();
                assetStore.close();
            }
        });
    }
});

Deno.test("manual deletion interrupted before sweep leaves durable reclaim work and preserves a surviving fork after restart", async (test) => {
    for (const kind of ["conversation", "message"] as const) {
        await test.step(kind, async () => {
            const directory = await Deno.makeTempDir({
                prefix: "heimdall-delete-recovery-",
            });
            const chatPath = `${directory}/chat.sqlite`;
            const assetPath = `${directory}/assets.sqlite`;
            let chat = openSqliteChatStore(chatPath);
            let assetStore = openSqliteChatAssetStore(assetPath);
            try {
                let assets = new ChatAssetService(assetStore);
                const shared = await assets.upload(bytes, "image/png");
                const exclusive = await assets.upload(
                    new Uint8Array([...bytes, 1]),
                    "image/png",
                );
                const conversation = chat.createConversation("original", time);
                chat.addMessage({
                    id: "shared",
                    conversationId: conversation.id,
                    role: "user",
                    text: "shared",
                    createdAt: time,
                    attachments: await assets.normalizeAttachments([shared]),
                });
                chat.addMessage({
                    id: "target",
                    conversationId: conversation.id,
                    role: "user",
                    text: "delete",
                    createdAt: time,
                    attachments: await assets.normalizeAttachments([exclusive]),
                });
                assets.consumeLeases([shared, exclusive], chat);
                const fork = chat.forkConversation(
                    conversation.id,
                    "shared",
                    time,
                );
                assertEquals(
                    assetStore.db.prepare(
                        "SELECT COUNT(*) AS count FROM image_asset_reclaim",
                    ).get()?.count,
                    0,
                );
                assets.sweep = () => {
                    throw new Error("process stopped after history deletion");
                };
                const app = createServer({ chat: { store: chat, assets } });
                const deletion = await app.request(
                    deletionPath(kind, conversation.id),
                    { method: "DELETE" },
                );
                assertEquals(deletion.status, 500);
                await deletion.body?.cancel();
                assertEquals(
                    chat.listAllMessages(conversation.id).some((row) =>
                        row.id === "target"
                    ),
                    false,
                );
                assert(assetStore.get(exclusive.assetId));
                chat.close();
                assetStore.close();
                chat = openSqliteChatStore(chatPath);
                assetStore = openSqliteChatAssetStore(assetPath);
                assets = new ChatAssetService(assetStore);
                assertEquals(assets.sweep(chat), 1);
                assertEquals(assetStore.get(exclusive.assetId), null);
                assert(assetStore.get(shared.assetId));
                assert(chat.getConversation(fork.id));
                assertEquals(
                    chat.listMessages(fork.id)[0]?.attachments?.[0]?.assetId,
                    shared.assetId,
                );
            } finally {
                chat.close();
                assetStore.close();
                await Deno.remove(directory, { recursive: true });
            }
        });
    }
});
