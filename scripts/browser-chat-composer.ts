import { assert, assertEquals } from "@std/assert";
import type { Page } from "playwright-core";

const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=";

type TransferFile = { name: string; type?: string; size?: number };

/** Exercise DOM event wiring against the smoke server's real asset endpoints. */
export async function checkChatComposer(page: Page): Promise<void> {
    const input = page.locator("#chat-draft");
    const composer = page.locator("form.chat-composer");
    const attachments = page.locator(".chat-draft-attachment");
    const initialUrl = page.url();
    const initialMessages = await page.locator(".chat-message").count();
    const draft = "保留这段草稿";
    await input.fill(draft);

    // Synthetic key events carry browser IME/repeat flags that keyboard.press
    // cannot set. The draft must remain ready to send after all three cases.
    const keys = await input.evaluate(async (element) => {
        const results = [];
        for (
            const flags of [
                { repeat: true },
                { isComposing: true },
                { keyCode: 229 },
            ]
        ) {
            const event = new KeyboardEvent("keydown", {
                key: "Enter",
                code: "Enter",
                bubbles: true,
                cancelable: true,
                ...flags,
            });
            element.dispatchEvent(event);
            results.push(event.defaultPrevented);
        }
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
        return results;
    });
    assertEquals(keys, [true, false, false], "Held Enter and IME handling");
    assertEquals(
        await input.inputValue(),
        draft,
        "Enter must retain the draft",
    );
    assertEquals(await page.locator(".chat-message").count(), initialMessages);
    assertEquals(await composer.getAttribute("data-sending"), "false");
    assert(await page.locator(".chat-send-action").isEnabled());

    const transfer = (
        type: "paste" | "dragenter" | "dragover" | "dragleave" | "drop",
        files: TransferFile[],
        text?: string,
    ) => page.evaluate(({ type, files, text, png }) => {
        const data = new DataTransfer();
        for (const file of files) {
            const bytes = file.size === undefined
                ? Uint8Array.from(atob(png), (value) => value.charCodeAt(0))
                : new Uint8Array(file.size);
            data.items.add(
                new File([bytes], file.name, {
                    type: file.type ?? "image/png",
                }),
            );
        }
        if (text !== undefined) data.setData("text/plain", text);
        const event = type === "paste"
            ? new ClipboardEvent(type, {
                clipboardData: data,
                bubbles: true,
                cancelable: true,
            })
            : new DragEvent(type, {
                dataTransfer: data,
                bubbles: true,
                cancelable: true,
            });
        document.querySelector(
            type === "paste" ? "#chat-draft" : "form.chat-composer",
        )!.dispatchEvent(event);
        return event.defaultPrevented;
    }, { type, files, text, png: PNG });

    const waitForAttachments = async (count: number) => {
        await page.waitForFunction(
            (expected) =>
                document.querySelectorAll(".chat-draft-attachment").length ===
                    expected &&
                document.querySelector(".chat-attach")?.getAttribute(
                        "aria-busy",
                    ) === "false",
            count,
        );
    };
    const assertDraftRetained = async (text: string, count: number) => {
        await waitForAttachments(count);
        assertEquals(await input.inputValue(), text);
        assertEquals(
            page.url(),
            initialUrl,
            "Dropping files must not navigate",
        );
    };

    // Native text-only paste must retain its default insertion behavior. A
    // synthetic clipboard event does not itself perform that default action.
    assertEquals(await transfer("paste", [], "纯文本"), false);
    assertEquals(await input.inputValue(), draft);
    await input.evaluate((element) =>
        (element as HTMLTextAreaElement).setSelectionRange(2, 4)
    );
    assert(await transfer("paste", [{ name: "clipboard.png" }]));
    await assertDraftRetained(draft, 1);
    await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>(
            ".chat-draft-attachment img",
        );
        return image?.complete && image.naturalWidth > 0;
    });

    await transfer("dragenter", [{ name: "dropped.png" }]);
    await page.waitForFunction(() =>
        document.querySelector("form.chat-composer")?.getAttribute(
            "data-dragging",
        ) === "true"
    );
    await transfer("dragleave", [{ name: "dropped.png" }]);
    await page.waitForFunction(() =>
        document.querySelector("form.chat-composer")?.getAttribute(
            "data-dragging",
        ) !== "true"
    );
    await transfer("dragenter", [{ name: "dropped.png" }]);
    assert(await transfer("dragover", [{ name: "dropped.png" }]));
    assert(await transfer("drop", [{ name: "dropped.png" }]));
    await assertDraftRetained(draft, 2);
    assertEquals(await composer.getAttribute("data-dragging"), "false");

    // Copying a screenshot alongside a caption must preserve both, replacing
    // only the selected text and placing the caret after the inserted caption.
    await input.evaluate((element) =>
        (element as HTMLTextAreaElement).setSelectionRange(2, 4)
    );
    const caption = "图片说明";
    const mixedDraft = `${draft.slice(0, 2)}${caption}${draft.slice(4)}`;
    assert(await transfer("paste", [{ name: "caption.png" }], caption));
    await assertDraftRetained(mixedDraft, 3);
    assertEquals(
        await input.evaluate((element) =>
            (element as HTMLTextAreaElement).selectionStart
        ),
        2 + caption.length,
    );

    for (
        const invalid of [
            {
                files: [{ name: "notes.txt", type: "text/plain" }],
                error: "仅支持 PNG、JPEG、GIF 和 WebP 图片",
            },
            {
                files: [{ name: "large.png", size: 5 * 1024 * 1024 + 1 }],
                error: "每张图片最多 5 MiB",
            },
            {
                files: [{ name: "four.png" }, { name: "five.png" }],
                error: "最多添加 4 张图片",
            },
        ]
    ) {
        assert(await transfer("drop", invalid.files));
        await page.locator(".chat-error").filter({ hasText: invalid.error })
            .waitFor();
        await assertDraftRetained(mixedDraft, 3);
    }

    // Successful upload clears the validation error and reaches the four-image
    // limit; restore the empty composer so the main smoke can send normally.
    assert(await transfer("drop", [{ name: "four.png" }]));
    await assertDraftRetained(mixedDraft, 4);
    await page.locator(".chat-error").waitFor({ state: "hidden" });
    assert(await page.locator(".chat-attach").isDisabled());
    for (let remaining = 4; remaining > 0; remaining--) {
        if (
            await page.locator(".chat-assets-toggle").getAttribute(
                "aria-expanded",
            ) !== "true"
        ) await page.locator(".chat-assets-toggle").click();
        await page.locator(".chat-remove-image").first().click();
        await waitForAttachments(remaining - 1);
    }
    assertEquals(await attachments.count(), 0);
    await input.fill("");
}
