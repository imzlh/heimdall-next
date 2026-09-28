import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { ChatAttachment } from "@heimdall/core/web/client/api/chat.ts";
import {
    CHAT_ATTACHMENT_ACCEPT,
    uploadChatAttachments,
    validateChatAttachments,
} from "@heimdall/core/web/client/chat/attachments.ts";

const inline: ChatAttachment = { mediaType: "image/png", dataBase64: "AA==" };
const asset: ChatAttachment = {
    assetId: "08ef4d1e-c1c7-4354-a172-e464892a40e8",
    mediaType: "image/png",
    size: 8,
};
const file = (type = "image/png", size = 8) =>
    new File([new Uint8Array(size)], "picture.png", { type });

Deno.test("chat uploads original files once and keeps only references in a new draft", async () => {
    const selected = file();
    const existing = Object.freeze([Object.freeze({ ...asset })]);
    const uploaded: File[] = [];
    Object.defineProperty(selected, "arrayBuffer", {
        value: () => {
            throw new Error("the browser should not re-encode the file");
        },
    });
    const added = { ...asset, assetId: "e203b792-baae-4cc2-a338-52c069e5a0ed" };
    const result = await uploadChatAttachments([selected], (value) => {
        uploaded.push(value);
        return Promise.resolve(added);
    }, existing);
    assertEquals(uploaded, [selected]);
    assertEquals(result, [asset, added]);
    assertEquals(existing, [asset]);
    assertEquals(
        CHAT_ATTACHMENT_ACCEPT,
        "image/png,image/jpeg,image/gif,image/webp",
    );
});

Deno.test("chat validates the entire selection before uploading any image", async () => {
    let uploads = 0;
    const upload = () => {
        uploads++;
        return Promise.resolve(asset);
    };
    for (const type of ["image/svg+xml", "image/bmp", "text/plain", ""]) {
        await assertRejects(() =>
            uploadChatAttachments([file(), file(type)], upload)
        );
    }
    for (const size of [0, 5 * 1024 * 1024 + 1]) {
        await assertRejects(() =>
            uploadChatAttachments([file(), file("image/png", size)], upload)
        );
    }
    await assertRejects(() =>
        uploadChatAttachments([file()], upload, [asset, asset, asset, asset])
    );
    assertEquals(uploads, 0);
});

Deno.test("chat accepts five MiB uploads without a base64-sized draft", async () => {
    const selected = file("image/png", 5 * 1024 * 1024);
    const result = await uploadChatAttachments(
        [selected],
        (value) => Promise.resolve({ ...asset, size: value.size }),
    );
    assertEquals(result, [{ ...asset, size: 5 * 1024 * 1024 }]);
    assertEquals(result[0]?.dataBase64, undefined);
});

Deno.test("chat failed uploads preserve existing references and reject inline upload responses", async () => {
    const existing = Object.freeze([Object.freeze({ ...asset })]);
    await assertRejects(() =>
        uploadChatAttachments(
            [file()],
            () => Promise.reject(new Error("offline")),
            existing,
        )
    );
    await assertRejects(() =>
        uploadChatAttachments([file()], () => Promise.resolve(inline), existing)
    );
    assertEquals(existing, [asset]);
});

Deno.test("chat validates asset IDs and still permits bounded legacy inline attachments", () => {
    validateChatAttachments([asset, inline]);
    for (
        const assetId of [
            "",
            "../secret",
            "https://other/image",
            "a".repeat(129),
        ]
    ) {
        assertThrows(() => validateChatAttachments([{ ...asset, assetId }]));
    }
    for (
        const dataBase64 of [
            "",
            " ",
            "====",
            "AA=A",
            "AA-_",
            "data:image/png;base64,AA==",
            "A".repeat(1_400_004),
        ]
    ) {
        assertThrows(() =>
            validateChatAttachments([{ mediaType: "image/png", dataBase64 }])
        );
    }
    assertThrows(() =>
        validateChatAttachments([{ ...asset, mediaType: "image/svg+xml" }])
    );
    assertThrows(() =>
        validateChatAttachments([asset, asset, asset, asset, asset])
    );
});
