import { assertEquals } from "@std/assert";
import {
    readStoredDraft,
    writeStoredDraft,
} from "@heimdall/core/web/client/chat/drafts.ts";

const id = "draft-storage-test";
const key = `heimdall.chat.draft.${id}`;
const reference = {
    assetId: "saved-image",
    mediaType: "image/png",
    leaseId: "stored-not-owned",
    size: 5,
    name: "image.png",
};

Deno.test("chat stored drafts contain references and never retain image bytes or signed URLs", () => {
    try {
        writeStoredDraft(id, {
            text: "describe this",
            attachments: [{
                ...reference,
                url: "https://private.example/image?signature=temporary",
            }, { mediaType: "image/png", dataBase64: "AA==" }],
        });
        assertEquals(JSON.parse(localStorage.getItem(key)!), {
            text: "describe this",
            attachments: [reference],
        });
        assertEquals(readStoredDraft(id), {
            text: "describe this",
            attachments: [reference],
        });
    } finally {
        localStorage.removeItem(key);
    }
});

Deno.test("chat reading tampered or obsolete attachments preserves the text draft", () => {
    try {
        for (
            const attachments of [
                [{ mediaType: "image/png", dataBase64: "AA==" }],
                [{ ...reference, assetId: "../other-file" }],
                [{ ...reference, mediaType: "image/svg+xml" }],
                [reference, reference, reference, reference, reference],
                [null],
            ]
        ) {
            localStorage.setItem(
                key,
                JSON.stringify({ text: "keep", attachments }),
            );
            assertEquals(readStoredDraft(id), {
                text: "keep",
                attachments: [],
            });
        }
    } finally {
        localStorage.removeItem(key);
    }
});

Deno.test("chat draft references without an old lease remain recoverable", () => {
    try {
        const { leaseId: _lease, ...unleased } = reference;
        localStorage.setItem(
            key,
            JSON.stringify({
                text: "restorable",
                attachments: [{
                    ...unleased,
                    dataBase64: "AA==",
                    arbitrary: true,
                }],
            }),
        );
        assertEquals(readStoredDraft(id), {
            text: "restorable",
            attachments: [unleased],
        });
        writeStoredDraft(id, { text: "", attachments: [] });
        assertEquals(localStorage.getItem(key), null);
    } finally {
        localStorage.removeItem(key);
    }
});
