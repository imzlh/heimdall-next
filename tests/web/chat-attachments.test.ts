import {
    assertEquals,
    assertNotStrictEquals,
    assertRejects,
    assertThrows,
} from "@std/assert";
import type { ChatAttachment } from "@heimdall/core/web/client/api/chat.ts";
import {
    CHAT_ATTACHMENT_ACCEPT,
    readChatAttachments,
    validateChatAttachments,
} from "@heimdall/core/web/client/chat/attachments.ts";

const png: ChatAttachment = { mediaType: "image/png", dataBase64: "AA==" };

class TrackedFile extends File {
    reads = 0;

    override arrayBuffer(): Promise<ArrayBuffer> {
        this.reads++;
        return super.arrayBuffer();
    }
}

Deno.test("chat attachments encode supported images without changing the existing draft", async () => {
    const existing = Object.freeze([Object.freeze({ ...png })]);
    const files = [
        new File([new Uint8Array([255])], "image.jpg", { type: "image/jpeg" }),
        new File([new Uint8Array([255, 238])], "image.gif", {
            type: "image/gif",
        }),
        new File([new Uint8Array([255, 238, 221])], "image.webp", {
            type: "image/webp",
        }),
    ];
    const attachments = await readChatAttachments(files, existing);
    assertEquals(attachments, [
        png,
        { mediaType: "image/jpeg", dataBase64: "/w==" },
        { mediaType: "image/gif", dataBase64: "/+4=" },
        { mediaType: "image/webp", dataBase64: "/+7d" },
    ]);
    assertNotStrictEquals(attachments, existing);
    assertEquals(existing, [png]);
    assertEquals(
        CHAT_ATTACHMENT_ACCEPT,
        "image/png,image/jpeg,image/gif,image/webp",
    );
});

Deno.test("chat attachments encode bytes across chunk boundaries", async () => {
    const bytes = Uint8Array.from(
        { length: 65_541 },
        (_, index) => index % 256,
    );
    const [attachment] = await readChatAttachments([
        new File([bytes], "image.png", { type: "image/png" }),
    ]);
    assertEquals(
        Uint8Array.from(
            atob(attachment!.dataBase64),
            (char) => char.charCodeAt(0),
        ),
        bytes,
    );
});

Deno.test("chat attachments enforce four images across existing and new selections before reading", async () => {
    validateChatAttachments([png, png, png, png]);
    assertThrows(() => validateChatAttachments([png, png, png, png, png]));
    const file = new TrackedFile(["image"], "image.png", { type: "image/png" });
    await assertRejects(() =>
        readChatAttachments([file], [png, png, png, png])
    );
    assertEquals(file.reads, 0);
});

Deno.test("chat attachments reject unsupported types before reading any selected file", async () => {
    for (const type of ["image/svg+xml", "image/bmp", "text/plain", ""]) {
        const valid = new TrackedFile(["image"], "valid.png", {
            type: "image/png",
        });
        const invalid = new TrackedFile(["image"], "invalid.png", { type });
        await assertRejects(() => readChatAttachments([valid, invalid]));
        assertEquals([valid.reads, invalid.reads], [0, 0]);
        assertThrows(() =>
            validateChatAttachments([{ mediaType: type, dataBase64: "AA==" }])
        );
    }
});

Deno.test("chat attachments accept the exact byte and base64 caps", async () => {
    const [attachment] = await readChatAttachments([
        new File([new Uint8Array(1_050_000)], "maximum.png", {
            type: "image/png",
        }),
    ]);
    assertEquals(attachment!.dataBase64.length, 1_400_000);
    validateChatAttachments([attachment!]);
    validateChatAttachments([{
        ...png,
        dataBase64: "A".repeat(1_399_998) + "==",
    }]);
    assertThrows(() =>
        validateChatAttachments([{ ...png, dataBase64: "A".repeat(1_400_004) }])
    );
});

Deno.test("chat attachments reject empty or oversized files before reading any selected file", async () => {
    for (const size of [0, 1_050_001]) {
        const valid = new TrackedFile(["image"], "valid.png", {
            type: "image/png",
        });
        const invalid = new TrackedFile([new Uint8Array(size)], "invalid.png", {
            type: "image/png",
        });
        await assertRejects(() => readChatAttachments([valid, invalid]));
        assertEquals([valid.reads, invalid.reads], [0, 0]);
    }
});

Deno.test("chat attachment validation matches the server base64 alphabet and padding checks", () => {
    for (const dataBase64 of ["A", "AA", "AAA", "AH==", "AAB=", " AA==\n"]) {
        validateChatAttachments([{ ...png, dataBase64 }]);
    }
    for (
        const dataBase64 of [
            "",
            " ",
            "====",
            "A===",
            "=AAA",
            "AA=A",
            "AA==\nAA",
            "AA-_",
            "data:image/png;base64,AA==",
        ]
    ) {
        assertThrows(() => validateChatAttachments([{ ...png, dataBase64 }]));
    }
});

Deno.test("chat attachments validate existing data before reading and preserve it after failure", async () => {
    const invalid = Object.freeze({ ...png, dataBase64: "invalid!" });
    const existing = Object.freeze([invalid]);
    const file = new TrackedFile(["image"], "image.png", { type: "image/png" });
    await assertRejects(() => readChatAttachments([file], existing));
    assertEquals(file.reads, 0);
    assertEquals(existing, [{
        mediaType: "image/png",
        dataBase64: "invalid!",
    }]);
});
