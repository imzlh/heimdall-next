import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { copyChatText } from "../../src/web/client/chat/clipboard.ts";

async function withGlobals(
    values: Record<string, unknown>,
    run: () => Promise<void>,
): Promise<void> {
    const originals = Object.fromEntries(
        Object.keys(values).map((key) => [
            key,
            Object.getOwnPropertyDescriptor(globalThis, key),
        ]),
    );
    try {
        for (const [key, value] of Object.entries(values)) {
            Object.defineProperty(globalThis, key, {
                configurable: true,
                value,
            });
        }
        await run();
    } finally {
        for (const [key, descriptor] of Object.entries(originals)) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
}

function fallbackDocument(copy: () => boolean = () => true) {
    const calls: string[] = [];
    const originalRange = {
        text: "selected message",
        cloneRange: () => ({ text: "selected message" }),
    };
    const ranges: { text: string }[] = [originalRange];
    let copiedText = "";
    let created = 0;
    const active = {
        isConnected: true,
        selectionStart: 2,
        selectionEnd: 7,
        selectionDirection: "backward",
        focus(options: FocusOptions) {
            assertEquals(options, { preventScroll: true });
            calls.push("restore focus");
            document.activeElement = active;
        },
        setSelectionRange(start: number, end: number, direction: string) {
            calls.push("restore input selection");
            active.selectionStart = start;
            active.selectionEnd = end;
            active.selectionDirection = direction;
        },
    };
    const textarea = {
        value: "",
        readOnly: false,
        tabIndex: 0,
        style: { cssText: "" },
        isConnected: false,
        focus(options: FocusOptions) {
            assertEquals(options, { preventScroll: true });
            calls.push("focus textarea");
            document.activeElement = textarea;
            active.selectionStart = 0;
            active.selectionEnd = 0;
            active.selectionDirection = "none";
        },
        select() {
            calls.push("select textarea");
            ranges.splice(0, ranges.length, { text: textarea.value });
        },
        remove() {
            calls.push("remove textarea");
            textarea.isConnected = false;
        },
    };
    const selection = {
        get rangeCount() {
            return ranges.length;
        },
        getRangeAt(index: number) {
            assertEquals(index, 0);
            return originalRange;
        },
        removeAllRanges() {
            calls.push("clear selection");
            ranges.length = 0;
        },
        addRange(range: { text: string }) {
            calls.push("restore DOM selection");
            ranges.push(range);
        },
    };
    const document = {
        activeElement: active as typeof active | typeof textarea,
        body: {
            appendChild(node: typeof textarea) {
                assertStrictEquals(node, textarea);
                calls.push("append textarea");
                textarea.isConnected = true;
            },
        },
        getSelection: () => selection,
        createElement(tag: string) {
            assertEquals(tag, "textarea");
            created++;
            return textarea;
        },
        execCommand(command: string) {
            assertEquals(command, "copy");
            assertStrictEquals(document.activeElement, textarea);
            assertEquals(ranges, [{ text: textarea.value }]);
            calls.push("copy");
            copiedText = textarea.value;
            return copy();
        },
    };
    return {
        document,
        active,
        textarea,
        ranges,
        calls,
        get copiedText() {
            return copiedText;
        },
        get created() {
            return created;
        },
    };
}

function assertRestored(test: ReturnType<typeof fallbackDocument>): void {
    assertEquals(test.textarea.isConnected, false);
    assertStrictEquals(test.document.activeElement, test.active);
    assertEquals(test.active.selectionStart, 2);
    assertEquals(test.active.selectionEnd, 7);
    assertEquals(test.active.selectionDirection, "backward");
    assertEquals(test.ranges, [{ text: "selected message" }]);
    assertEquals(test.calls, [
        "append textarea",
        "focus textarea",
        "select textarea",
        "copy",
        "remove textarea",
        "restore focus",
        "clear selection",
        "restore DOM selection",
        "restore input selection",
    ]);
}

Deno.test("chat copy uses the clipboard API without changing focus or selection", async () => {
    const test = fallbackDocument();
    const text = "<script>literal</script>\nconst answer = 42;\n";
    const copied: string[] = [];
    const clipboard = {
        writeText(value: string) {
            assertStrictEquals(this, clipboard);
            copied.push(value);
            return Promise.resolve();
        },
    };
    await withGlobals(
        { navigator: { clipboard }, document: test.document },
        async () => {
            await copyChatText(text);
        },
    );
    assertEquals(copied, [text]);
    assertEquals(test.created, 0);
    assertEquals(test.calls, []);
    assertStrictEquals(test.document.activeElement, test.active);
    assertEquals(test.active.selectionStart, 2);
});

Deno.test("chat copy on HTTP copies literal text and restores focus and both selections", async () => {
    const test = fallbackDocument();
    const text = "**literal**\n  <button data-copy-key=evil>hello</button>\n";
    await withGlobals({ navigator: {}, document: test.document }, async () => {
        await copyChatText(text);
    });
    assertEquals(test.copiedText, text);
    assertEquals(test.textarea.readOnly, true);
    assertEquals(test.textarea.tabIndex, -1);
    assertRestored(test);
});

Deno.test("chat copy falls back when the clipboard API rejects permission", async () => {
    const test = fallbackDocument();
    let attempts = 0;
    const navigator = {
        clipboard: {
            writeText() {
                attempts++;
                return Promise.reject(new Error("Permission denied"));
            },
        },
    };
    await withGlobals({ navigator, document: test.document }, async () => {
        await copyChatText("fallback after permission denial");
    });
    assertEquals(attempts, 1);
    assertEquals(test.copiedText, "fallback after permission denial");
    assertRestored(test);
});

Deno.test("chat copy reports a false execCommand result and still restores the page", async () => {
    const test = fallbackDocument(() => false);
    await withGlobals({ navigator: {}, document: test.document }, async () => {
        await assertRejects(
            () => copyChatText("text"),
            Error,
            "Clipboard copy failed",
        );
    });
    assertRestored(test);
});

Deno.test("chat copy cleans up and restores the page if execCommand throws", async () => {
    const failure = new Error("Browser rejected copy");
    const test = fallbackDocument(() => {
        throw failure;
    });
    await withGlobals({ navigator: {}, document: test.document }, async () => {
        const error = await assertRejects(() => copyChatText("text"));
        assertStrictEquals(error, failure);
    });
    assertRestored(test);
});

Deno.test("chat copy reports when no browser copy mechanism exists", async () => {
    await withGlobals({ navigator: {}, document: undefined }, async () => {
        await assertRejects(
            () => copyChatText("text"),
            Error,
            "Clipboard is unavailable",
        );
    });
});
