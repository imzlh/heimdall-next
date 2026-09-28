import { assert, assertEquals, assertFalse } from "@std/assert";
import type { InferenceSource, OperationRequest } from "@heimdall/contracts";
import type { StreamFrame } from "@heimdall/hip";
import { createServer } from "../main.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";
import { createServerApp } from "@heimdall/core/http/app.ts";
import {
    createChatAssetLinkRoutes,
    createChatAssetRoutes,
} from "@heimdall/core/http/chat-asset-routes.ts";
import {
    CHAT_ASSET_MAX_BYTES,
    ChatAssetService,
} from "@heimdall/core/chat/assets.ts";
import { openSqliteChatAssetStore } from "@heimdall/core/storage/sqlite-assets.ts";

const origin = "http://127.0.0.1";
const token = "private-chat-token";
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

Deno.test("composed chat uploads once, returns references, and gives HIP signed image links", async () => {
    const store = openSqliteChatStore(":memory:");
    const assetStore = openSqliteChatAssetStore(":memory:");
    const requests: OperationRequest[] = [];
    const source: InferenceSource = {
        id: "assets-source",
        capabilities: [{
            operation: "generation.create",
            models: ["image-model"],
            streaming: false,
        }],
        execute(input) {
            requests.push(input);
            return (async function* (): AsyncIterable<StreamFrame> {
                const events: StreamFrame["event"][] = [{
                    kind: "run.started",
                    request: input,
                }, {
                    kind: "part.delta",
                    messageId: "reply",
                    partId: "text",
                    delta: "看到了",
                }, { kind: "run.completed" }];
                for (const [index, event] of events.entries()) {
                    yield {
                        version: 1,
                        requestId: input.requestId,
                        streamId: input.requestId,
                        seq: index + 1,
                        eventId: `${input.requestId}:${index}`,
                        timestamp: new Date().toISOString(),
                        event,
                    };
                }
            })();
        },
    };
    try {
        const assets = new ChatAssetService(assetStore, {
            publicBaseUrl: origin,
        });
        const app = createServer({
            sources: [source],
            chat: { store, assets },
        });
        const upload = await app.request(`${origin}/api/chat/assets`, {
            method: "POST",
            headers: { "content-type": "image/png" },
            body: bytes,
        });
        assertEquals(upload.status, 201);
        const { attachment } = await upload.json();
        const conversation = store.createConversation(
            "image",
            new Date().toISOString(),
        );
        const response = await app.request(`${origin}/api/chat/message`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: conversation.id,
                model: "image-model",
                text: "看看",
                attachments: [attachment],
            }),
        });
        assertEquals(response.status, 200);
        const result = await response.json();
        assertEquals(
            result.messages[0].attachments[0].assetId,
            attachment.assetId,
        );
        assertEquals(result.messages[0].attachments[0].leaseId, undefined);
        assertEquals(
            assetStore.db.prepare(
                "SELECT count(*) AS total FROM image_asset_leases WHERE asset_id = ?",
            ).get(attachment.assetId)?.total,
            0,
        );
        assertFalse(JSON.stringify(result).includes("dataBase64"));
        const request = requests[0]!;
        assertEquals(request.operation, "generation.create");
        if (request.operation !== "generation.create") {
            throw new Error("unexpected operation");
        }
        const serialized = JSON.stringify(request);
        assertFalse(serialized.includes("dataBase64"));
        assert(
            serialized.includes(
                `/api/chat/asset-links/${attachment.assetId}?exp=`,
            ),
        );
        const loaded = await app.request(
            `${origin}/api/chat/conversation?id=${conversation.id}`,
        );
        const snapshot = await loaded.json();
        assertFalse(JSON.stringify(snapshot).includes("dataBase64"));
        assertEquals(snapshot.messages[0].attachments[0].url, attachment.url);
        assertEquals(store.listMessages(conversation.id)[0]?.attachments, [{
            assetId: attachment.assetId,
            mediaType: "image/png",
        }]);
        const duplicate = await app.request(`${origin}/api/chat/message`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: conversation.id,
                model: "image-model",
                text: "再看看",
                attachments: [{
                    assetId: attachment.assetId,
                    mediaType: "image/png",
                }],
            }),
        });
        assertEquals(duplicate.status, 200);
        await duplicate.body?.cancel();
        assertEquals(
            assetStore.db.prepare("SELECT count(*) AS total FROM image_assets")
                .get()?.total,
            1,
        );
        const html = await (await app.request(
            `${origin}/admin/chat?id=${conversation.id}`,
        )).text();
        assert(html.includes(attachment.url));
        assertFalse(html.includes("iVBORw0KGgo="));
        assertFalse(html.includes("asset-links/"));
    } finally {
        store.close();
        assetStore.close();
    }
});

Deno.test("asset upload/read reuse chat authentication and public short links only accept signatures", async () => {
    const store = openSqliteChatAssetStore(":memory:");
    try {
        const assets = new ChatAssetService(store);
        const app = createServerApp({
            adminAuthToken: token,
            chatRoutes: createChatAssetRoutes(assets),
            chatAssetLinkRoutes: createChatAssetLinkRoutes(assets),
        });
        const login = await app.request(`${origin}/admin/session`, {
            method: "POST",
            headers: { origin },
            body: new URLSearchParams({ token }),
        });
        const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
        const browserUpload = `${origin}/admin/chat/api/assets`;
        for (
            const headers of [{ origin }, { cookie }, {
                cookie,
                origin: "https://attacker.example",
            }, { cookie, origin, "sec-fetch-site": "cross-site" }] as Record<
                string,
                string
            >[]
        ) {
            const response = await app.request(browserUpload, {
                method: "POST",
                headers: { "content-type": "image/png", ...headers },
                body: bytes,
            });
            assert(response.status === 401 || response.status === 403);
            await response.body?.cancel();
        }
        assertEquals(
            store.db.prepare("SELECT count(*) AS total FROM image_assets").get()
                ?.total,
            0,
        );
        const uploaded = await app.request(browserUpload, {
            method: "POST",
            headers: {
                origin,
                cookie,
                "content-type": "image/png",
                "x-file-name": encodeURIComponent("参考.png"),
                "x-request-id": "asset-upload-trace",
            },
            body: bytes,
        });
        assertEquals(uploaded.status, 201);
        assertEquals(
            uploaded.headers.get("x-heimdall-request-id"),
            "asset-upload-trace",
        );
        const { attachment } = await uploaded.json();
        assertEquals(attachment.name, "参考.png");
        assertEquals(attachment.dataBase64, undefined);
        const browserImage = `${origin}${attachment.url}`;
        assertEquals((await app.request(browserImage)).status, 401);
        const image = await app.request(browserImage, { headers: { cookie } });
        assertEquals(image.status, 200);
        assertEquals(new Uint8Array(await image.arrayBuffer()), bytes);
        assertEquals(image.headers.get("cache-control"), "no-store");
        assertEquals(image.headers.get("content-type"), "image/png");
        const bearerImage = `${origin}/api/chat/assets/${attachment.assetId}`;
        assertEquals(
            (await app.request(bearerImage, { headers: { cookie } })).status,
            401,
        );
        const authorized = await app.request(bearerImage, {
            headers: { authorization: `Bearer ${token}` },
        });
        assertEquals(authorized.status, 200);
        await authorized.body?.cancel();
        const signed = `${origin}${await assets.links.path(
            attachment.assetId,
        )}`;
        const publicImage = await app.request(signed, {
            headers: { origin: "https://provider.example" },
        });
        assertEquals(publicImage.status, 200);
        assertEquals(new Uint8Array(await publicImage.arrayBuffer()), bytes);
        assertEquals(publicImage.headers.get("referrer-policy"), "no-referrer");
        const signature = new URL(signed).searchParams.get("sig");
        for (
            const url of [
                signed.split("?")[0]!,
                `${signed}&sig=${signature}`,
                signed.replace(attachment.assetId, crypto.randomUUID()),
            ]
        ) {
            for (const method of ["GET", "HEAD"]) {
                const denied = await app.request(url, {
                    method,
                    headers: { cookie, authorization: `Bearer ${token}` },
                });
                assertEquals(denied.status, 403);
                assertEquals(denied.headers.get("cache-control"), "no-store");
                await denied.body?.cancel();
            }
        }
        const head = await app.request(signed, { method: "HEAD" });
        assertEquals(head.status, 200);
        assertEquals(await head.text(), "");
        assertEquals(
            (await app.request(
                `${origin}/admin/chat/api/asset-links/${attachment.assetId}`,
            )).status,
            404,
        );
    } finally {
        store.close();
    }
});

Deno.test("asset HTTP reads are bounded without Content-Length and forbid unsupported content", async () => {
    const store = openSqliteChatAssetStore(":memory:");
    try {
        const assets = new ChatAssetService(store);
        const app = createServerApp({
            chatRoutes: createChatAssetRoutes(assets),
        });
        for (
            const media of ["image/svg+xml", "text/html", "application/json"]
        ) {
            const response = await app.request(`${origin}/api/chat/assets`, {
                method: "POST",
                headers: { "content-type": media },
                body: "payload",
            });
            assertEquals(response.status, 415);
            assertEquals(
                response.headers.get("x-content-type-options"),
                "nosniff",
            );
            await response.body?.cancel();
        }
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array(CHAT_ASSET_MAX_BYTES + 1));
            },
            cancel() {
                cancelled = true;
            },
        });
        const response = await app.request(`${origin}/api/chat/assets`, {
            method: "POST",
            headers: { "content-type": "image/png" },
            body,
        });
        assertEquals(response.status, 413);
        assert(cancelled);
        assertEquals(
            store.db.prepare("SELECT count(*) AS total FROM image_assets").get()
                ?.total,
            0,
        );
        await response.body?.cancel();
    } finally {
        store.close();
    }
});

Deno.test("chat deletion reclaims only unreferenced candidates and preserves forks and fresh uploads", async () => {
    const store = openSqliteChatStore(":memory:");
    const assetStore = openSqliteChatAssetStore(":memory:");
    try {
        const assets = new ChatAssetService(assetStore);
        const app = createServer({ chat: { store, assets } });
        const shared = await assets.upload(bytes, "image/png");
        const pending = await assets.upload(
            new Uint8Array([...bytes, 1]),
            "image/png",
        );
        const conversation = store.createConversation(
            "original",
            new Date().toISOString(),
        );
        store.addMessage({
            id: "first-image",
            conversationId: conversation.id,
            role: "user",
            text: "first",
            createdAt: new Date().toISOString(),
            attachments: [shared],
        });
        assets.consumeLeases([shared], store);
        const fork = store.forkConversation(
            conversation.id,
            "first-image",
            new Date().toISOString(),
        );
        const deletedMessage = await app.request(
            `${origin}/api/chat/message?conversationId=${conversation.id}&id=first-image`,
            { method: "DELETE" },
        );
        assertEquals(deletedMessage.status, 200);
        await deletedMessage.body?.cancel();
        assert(assetStore.get(shared.assetId));
        assert(assetStore.get(pending.assetId));
        const signedPath = await assets.links.path(shared.assetId);
        const deletedFork = await app.request(
            `${origin}/api/chat/conversation?id=${fork.id}`,
            { method: "DELETE" },
        );
        assertEquals(deletedFork.status, 200);
        await deletedFork.body?.cancel();
        assertEquals(assetStore.get(shared.assetId), null);
        assert(assetStore.get(pending.assetId));
        const staleLink = await app.request(`${origin}${signedPath}`);
        assertEquals(staleLink.status, 404);
        await staleLink.body?.cancel();
    } finally {
        store.close();
        assetStore.close();
    }
});
