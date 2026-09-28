import {
    assert,
    assertEquals,
    assertFalse,
    assertRejects,
    assertThrows,
} from "@std/assert";
import {
    CHAT_ASSET_MAX_BYTES,
    ChatAssetError,
    ChatAssetService,
} from "@heimdall/core/chat/assets.ts";
import {
    CHAT_ASSET_LINK_TTL_MS,
    ChatAssetLinks,
    chatAssetPublicOrigin,
} from "@heimdall/core/chat/asset-links.ts";
import { openSqliteChatAssetStore } from "@heimdall/core/storage/sqlite-assets.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";
import { DatabaseSync } from "node:sqlite";

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const inline = { mediaType: "image/png", dataBase64: "iVBORw0KGgo=" };
const date = "2026-09-27T00:00:00.000Z";

Deno.test("chat assets deduplicate bytes and persist only safe reference metadata across restart", async () => {
    const directory = await Deno.makeTempDir();
    const path = `${directory}/assets.sqlite`;
    let store = openSqliteChatAssetStore(path);
    try {
        const service = new ChatAssetService(store);
        const first = await service.upload(
            bytes,
            "image/png",
            "C:\\private\\截图.png",
        );
        const duplicate = await service.upload(bytes, "image/png", "other.png");
        assertEquals(duplicate.assetId, first.assetId);
        assertEquals(first.name, "截图.png");
        assertEquals(first.url, `/admin/chat/api/assets/${first.assetId}`);
        assertFalse(JSON.stringify(first).includes("dataBase64"));
        assertEquals(
            store.db.prepare("SELECT count(*) AS total FROM image_assets").get()
                ?.total,
            1,
        );
        store.close();
        store = openSqliteChatAssetStore(path);
        assertEquals(store.read(first.assetId)?.bytes, bytes);
        assertEquals(store.get(first.assetId)?.size, bytes.length);
        assertEquals(store.get(first.assetId)?.sha256.length, 64);
    } finally {
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("chat asset links bind ID and exact expiry and stop working after restart", async () => {
    let time = Date.parse(date);
    const links = new ChatAssetLinks(() => time);
    const id = crypto.randomUUID();
    const url = new URL(await links.path(id), "https://gateway.example");
    const expiry = url.searchParams.get("exp")!;
    const signature = url.searchParams.get("sig")!;
    assert(await links.verify(id, expiry, signature));
    assertFalse(await links.verify(crypto.randomUUID(), expiry, signature));
    assertFalse(await links.verify(id, String(Number(expiry) + 1), signature));
    assertFalse(await links.verify(id, expiry, "A".repeat(43)));
    assertFalse(await links.verify(id, expiry, "bad"));
    assertFalse(await links.verify(id, "0" + expiry, signature));
    assertFalse(
        await new ChatAssetLinks(() => time).verify(id, expiry, signature),
    );
    time += CHAT_ASSET_LINK_TTL_MS;
    assertFalse(await links.verify(id, expiry, signature));
    assertFalse(
        await links.verify(
            id,
            String(time + CHAT_ASSET_LINK_TTL_MS + 1),
            signature,
        ),
    );
});

Deno.test("only a declared public origin produces HIP links; local images resolve without a fetch", async () => {
    const store = openSqliteChatAssetStore(":memory:");
    try {
        const local = new ChatAssetService(store);
        const reference = await local.upload(bytes, "image/png");
        const localParts = await local.imageParts("message", [reference]);
        assertEquals(localParts[0]?.source.data, bytes);
        assertEquals(localParts[0]?.source.uri, undefined);
        const linked = new ChatAssetService(store, {
            publicBaseUrl: "https://gateway.example",
            now: () => new Date(date),
        });
        const parts = await linked.imageParts("message", [reference]);
        assertEquals(parts[0]?.source.data, undefined);
        const url = new URL(parts[0]!.source.uri!);
        assertEquals(url.origin, "https://gateway.example");
        assertEquals(
            url.pathname,
            `/api/chat/asset-links/${reference.assetId}`,
        );
        assert(
            await linked.links.verify(
                reference.assetId,
                url.searchParams.get("exp"),
                url.searchParams.get("sig"),
            ),
        );
        // Submitted metadata, including attacker-supplied URLs, never chooses bytes or an origin.
        const hostile = {
            ...reference,
            mediaType: "image/jpeg",
            url: "https://attacker.example/private",
        };
        const normalized = await linked.normalizeAttachments([hostile]);
        assertEquals(normalized, [{
            assetId: reference.assetId,
            mediaType: "image/png",
        }]);
        await assertRejects(
            () =>
                local.normalizeAttachments([{
                    assetId: "https://attacker.example/private",
                    mediaType: "image/png",
                }]),
            ChatAssetError,
        );
        await assertRejects(
            () =>
                local.normalizeAttachments([{
                    assetId: crypto.randomUUID(),
                    mediaType: "image/png",
                }]),
            ChatAssetError,
        );
    } finally {
        store.close();
    }
    assertEquals(chatAssetPublicOrigin(undefined), undefined);
    for (
        const value of [
            "file:///tmp/image",
            "https://name:password@example.com",
            "https://example.com/path",
            "https://example.com/?query",
            "https://example.com/#fragment",
        ]
    ) {
        assertThrows(() => chatAssetPublicOrigin(value), TypeError);
    }
});

Deno.test("legacy image migration clears inline columns on every branch and is idempotent", async () => {
    const directory = await Deno.makeTempDir();
    const chatPath = `${directory}/chat.sqlite`;
    const chat = openSqliteChatStore(chatPath);
    const assets = openSqliteChatAssetStore(`${directory}/assets.sqlite`);
    try {
        const service = new ChatAssetService(assets);
        const conversation = chat.createConversation("legacy", date);
        chat.addMessage({
            id: "original",
            conversationId: conversation.id,
            role: "user",
            text: "original",
            createdAt: date,
            parentId: null,
            attachments: [inline],
        });
        chat.addMessage({
            id: "alternative",
            conversationId: conversation.id,
            role: "user",
            text: "alternative",
            createdAt: date,
            parentId: null,
            attachments: [inline],
        });
        assertEquals(await service.migrateHistory(chat), 2);
        assertEquals(await service.migrateHistory(chat), 0);
        const original = chat.messagePath(conversation.id, "original")[0]!;
        const alternative = chat.messagePath(
            conversation.id,
            "alternative",
        )[0]!;
        assertEquals(original.attachments, alternative.attachments);
        assert(original.attachments![0]!.assetId);
        assertFalse(JSON.stringify(original).includes("dataBase64"));
        assertEquals(
            assets.db.prepare("SELECT count(*) AS total FROM image_assets")
                .get()?.total,
            1,
        );
        const db = new DatabaseSync(chatPath);
        try {
            assertEquals(
                db.prepare(
                    "SELECT count(*) AS total FROM message_attachments WHERE data_base64<>'' OR asset_id IS NULL",
                ).get()?.total,
                0,
            );
        } finally {
            db.close();
        }
        const presented = await service.presentMessages([original], chat);
        assertFalse(JSON.stringify(presented).includes(inline.dataBase64));
        assert(JSON.stringify(presented).includes("/admin/chat/api/assets/"));
    } finally {
        chat.close();
        assets.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("failed legacy asset writes leave original attachments available for retry", async () => {
    const chat = openSqliteChatStore(":memory:");
    const assets = openSqliteChatAssetStore(":memory:");
    try {
        const conversation = chat.createConversation("legacy", date);
        chat.addMessage({
            id: "legacy",
            conversationId: conversation.id,
            role: "user",
            text: "",
            createdAt: date,
            attachments: [inline],
        });
        const failed = new ChatAssetService(
            new Proxy(assets, {
                get(target, property) {
                    if (property === "put") {
                        return () => {
                            throw new Error("disk full");
                        };
                    }
                    const value = Reflect.get(target, property, target);
                    return typeof value === "function"
                        ? value.bind(target)
                        : value;
                },
            }),
        );
        await assertRejects(
            () => failed.migrateHistory(chat),
            Error,
            "disk full",
        );
        assertEquals(chat.listMessages(conversation.id)[0]?.attachments, [
            inline,
        ]);
        assertEquals(
            await new ChatAssetService(assets).migrateHistory(chat),
            1,
        );
    } finally {
        chat.close();
        assets.close();
    }
});

Deno.test("chat assets reject active content, oversized images and malformed legacy bytes", async () => {
    const store = openSqliteChatAssetStore(":memory:");
    try {
        const service = new ChatAssetService(store);
        for (
            const media of [
                "image/svg+xml",
                "text/html",
                "application/octet-stream",
            ]
        ) {
            await assertRejects(
                () => service.upload(bytes, media),
                ChatAssetError,
            );
        }
        await assertRejects(
            () => service.upload(new Uint8Array(), "image/png"),
            ChatAssetError,
        );
        await assertRejects(
            () =>
                service.upload(
                    new Uint8Array(CHAT_ASSET_MAX_BYTES + 1),
                    "image/png",
                ),
            ChatAssetError,
        );
        for (const dataBase64 of ["", "!", "A", "YQ==\n"]) {
            await assertRejects(
                () =>
                    service.normalizeAttachments([{
                        mediaType: "image/png",
                        dataBase64,
                    }]),
                ChatAssetError,
            );
        }
    } finally {
        store.close();
    }
});

Deno.test("damaged legacy images are quarantined without blocking valid images or exposing bytes", async () => {
    const directory = await Deno.makeTempDir();
    const chatPath = `${directory}/chat.sqlite`;
    const chat = openSqliteChatStore(chatPath);
    const assets = openSqliteChatAssetStore(`${directory}/assets.sqlite`);
    try {
        const conversation = chat.createConversation("damaged", date);
        chat.addMessage({
            id: "mixed",
            conversationId: conversation.id,
            role: "user",
            text: "survives",
            createdAt: date,
            attachments: [{ mediaType: "image/png", dataBase64: "A" }, inline, {
                mediaType: "image/png",
                dataBase64: "",
            }],
        });
        const service = new ChatAssetService(assets);
        assertEquals(await service.migrateHistory(chat), 1);
        assertEquals(service.quarantinedAttachments, 2);
        assertEquals(await service.migrateHistory(chat), 0);
        const record = chat.listMessages(conversation.id)[0]!;
        assertEquals(record.text, "survives");
        assertEquals(record.attachments?.length, 1);
        assert(record.attachments?.[0]?.assetId);
        assertFalse(
            JSON.stringify(await service.presentMessages([record], chat))
                .includes("dataBase64"),
        );
        const db = new DatabaseSync(chatPath);
        try {
            const evidence = db.prepare(
                "SELECT media_type, data_base64, reason FROM legacy_attachment_quarantine ORDER BY position",
            ).all();
            assertEquals(evidence.length, 2);
            assertEquals(evidence.map((row) => row.data_base64), ["A", ""]);
            assert(
                evidence.every((row) =>
                    typeof row.reason === "string" && row.reason.length > 0
                ),
            );
            chat.deleteConversation(conversation.id);
            assertEquals(
                db.prepare(
                    "SELECT count(*) AS total FROM legacy_attachment_quarantine",
                ).get()?.total,
                0,
            );
        } finally {
            db.close();
        }
    } finally {
        chat.close();
        assets.close();
        await Deno.remove(directory, { recursive: true });
    }
});
