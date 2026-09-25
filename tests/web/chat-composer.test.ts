import { assertEquals } from "@std/assert";
import {
    composerKeyAction,
    insertComposerNewline,
    resizeComposerInput,
} from "@heimdall/core/web/client/chat/composer-behavior.ts";

const enter = {
    key: "Enter",
    keyCode: 13,
    isComposing: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
};

Deno.test("composer Enter submits only after IME confirmation and without newline modifiers", () => {
    assertEquals(composerKeyAction(enter), "send");
    assertEquals(composerKeyAction({ ...enter, isComposing: true }), "none");
    // Safari and older IMEs can clear isComposing on the confirmation key.
    assertEquals(composerKeyAction({ ...enter, keyCode: 229 }), "none");
    for (const modifier of ["shiftKey", "ctrlKey", "metaKey"] as const) {
        assertEquals(
            composerKeyAction({ ...enter, [modifier]: true }),
            "newline",
        );
        assertEquals(
            composerKeyAction({
                ...enter,
                [modifier]: true,
                isComposing: true,
            }),
            "none",
        );
    }
    assertEquals(
        composerKeyAction({ ...enter, key: "a", keyCode: 65 }),
        "none",
    );
});

Deno.test("composer modified Enter replaces the selected text and retains a middle caret", () => {
    assertEquals(insertComposerNewline("第一行第二行", 3, 3), {
        text: "第一行\n第二行",
        caret: 4,
    });
    assertEquals(insertComposerNewline("保留选中片段结尾", 2, 6), {
        text: "保留\n结尾",
        caret: 3,
    });
    assertEquals(insertComposerNewline("", 0, 0), { text: "\n", caret: 1 });
});

Deno.test("composer growth caps long drafts, permits scrolling, and shrinks after acknowledgement", () => {
    let contentHeight = 300;
    let visualHeight = 61;
    const committed: string[] = [];
    const style = { transition: "", height: "80px", overflowY: "hidden" };
    // Metrics stand in for the layout engine; this checks the measuring and
    // write protocol. Width, timing and focus still need a browser smoke test.
    const input = {
        style,
        getBoundingClientRect: () => ({ height: visualHeight }),
        get scrollHeight() {
            assertEquals(style.transition, "none");
            assertEquals(style.height, "auto");
            return contentHeight;
        },
        get offsetHeight() {
            committed.push(style.height);
            return visualHeight;
        },
    } as unknown as HTMLTextAreaElement;
    resizeComposerInput(input);
    assertEquals(committed, ["61px"]);
    assertEquals(style, { transition: "", height: "144px", overflowY: "auto" });

    // The controller clears a draft after the server acknowledges it. The old
    // growing height must become a short pill again, with scrolling disabled.
    contentHeight = 32;
    visualHeight = 144;
    resizeComposerInput(input);
    assertEquals(committed, ["61px", "144px"]);
    assertEquals(style, {
        transition: "",
        height: "32px",
        overflowY: "hidden",
    });
});
