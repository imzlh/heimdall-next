import { assertEquals, assertThrows } from "@std/assert";
import {
    applyUnifiedPatch,
    MAX_PATCH_CHARS,
    replaceText,
} from "../../plugins/tool-workspace/patch.ts";
import { MAX_FILE_BYTES } from "../../plugins/tool-workspace/workspace.ts";

function diff(hunks: string, oldName = "a/file.txt", newName = "b/file.txt") {
    return `--- ${oldName}\n+++ ${newName}\n${hunks}`;
}

const change = diff("@@ -1,3 +1,3 @@\n first\n-old\n+new\n last\n");

Deno.test("workspace patch applies multiple exact hunks", () => {
    assertEquals(
        applyUnifiedPatch(
            "one\ntwo\nthree\nfour\nfive\nsix\n",
            diff(
                "@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n@@ -5,2 +5,2 @@\n-five\n+FIVE\n six\n",
            ),
        ),
        "one\nTWO\nthree\nfour\nFIVE\nsix\n",
    );
});

Deno.test("workspace patch preserves CRLF when supplied an LF patch", () => {
    assertEquals(
        applyUnifiedPatch("first\r\nold\r\nlast\r\n", change),
        "first\r\nnew\r\nlast\r\n",
    );
    assertEquals(
        applyUnifiedPatch(
            "first\nold\nlast\n",
            change.replaceAll("\n", "\r\n"),
        ),
        "first\nnew\nlast\n",
    );
});

Deno.test("workspace patch permits relocation only when all context matches", () => {
    assertEquals(
        applyUnifiedPatch("intro\nfirst\nold\nlast\n", change),
        "intro\nfirst\nnew\nlast\n",
    );
    for (
        const content of [
            "wrong\nold\nlast\n",
            "first\nother\nlast\n",
            "first\nold\nwrong\n",
        ]
    ) {
        assertThrows(
            () => applyUnifiedPatch(content, change),
            Error,
            "context",
        );
    }
});

Deno.test("workspace patch handles inserting and removing EOF newlines", () => {
    const marker = "\\ No newline at end of file\n";
    assertEquals(
        applyUnifiedPatch(
            "old",
            diff(`@@ -1 +1 @@\n-old\n${marker}+new\n${marker}`),
        ),
        "new",
    );
    assertEquals(
        applyUnifiedPatch("old", diff(`@@ -1 +1 @@\n-old\n${marker}+new\n`)),
        "new\n",
    );
    assertEquals(
        applyUnifiedPatch("old\n", diff(`@@ -1 +1 @@\n-old\n+new\n${marker}`)),
        "new",
    );
    assertEquals(
        applyUnifiedPatch(
            "first\r\nold",
            diff(`@@ -1,2 +1,2 @@\n first\n-old\n${marker}+new\n`),
        ),
        "first\r\nnew\r\n",
    );
    assertThrows(() =>
        applyUnifiedPatch("old\n", diff(`@@ -1 +1 @@\n-old\n${marker}+new\n`))
    );
    assertThrows(() =>
        applyUnifiedPatch("old", diff(`@@ -1 +1 @@\n-old\n+new\n${marker}`))
    );
});

Deno.test("workspace patch validates no-newline context and malformed markers", () => {
    const marker = "\\ No newline at end of file\n";
    const contextEof = diff(`@@ -1,2 +1,2 @@\n-old\n+new\n last\n${marker}`);
    assertEquals(applyUnifiedPatch("old\nlast", contextEof), "new\nlast");
    assertThrows(() => applyUnifiedPatch("old\nlast\n", contextEof));
    for (
        const hunks of [
            "@@ -1 +1 @@\n-old\n+new\n\\ invalid marker\n",
            `@@ -1,2 +1,2 @@\n-old\n${marker}+new\n last\n`,
            `@@ -1 +1 @@\n-old\n+new\n${marker}${marker}`,
        ]
    ) {
        assertThrows(() => applyUnifiedPatch("old\nlast", diff(hunks)));
    }
});

Deno.test("workspace patch anchors explicit no-newline markers to the actual EOF", () => {
    const marker = "\\ No newline at end of file\n";
    const contextEof = diff(`@@ -1,2 +1,2 @@\n-old\n+new\n last\n${marker}`);
    assertThrows(
        () => applyUnifiedPatch("old\nlast\nother", contextEof),
        Error,
        "EOF",
    );
    assertThrows(
        () => applyUnifiedPatch("prefix\nold\nlast", contextEof),
        Error,
        "EOF",
    );
    // The declared range ends at EOF, but its old context only matches earlier.
    assertThrows(
        () =>
            applyUnifiedPatch(
                "old\nlast\nwrong\nlast",
                diff(`@@ -3,2 +3,2 @@\n-old\n+new\n last\n${marker}`),
            ),
        Error,
        "context",
    );
    // A marker on an inserted line must not remove the file's actual EOF newline
    // while changing some unrelated line in the middle of the file.
    assertThrows(
        () =>
            applyUnifiedPatch(
                "old\nother\n",
                diff(`@@ -1 +1 @@\n-old\n+new\n${marker}`),
            ),
        Error,
        "EOF",
    );
});

Deno.test("workspace patch permits earlier hunk relocation while anchoring an EOF hunk", () => {
    const marker = "\\ No newline at end of file\n";
    assertEquals(
        applyUnifiedPatch(
            "intro\nold\nmiddle\nlast",
            diff(
                `@@ -1 +1,2 @@\n-old\n+new\n+added\n@@ -4 +5 @@\n-last\n${marker}+LAST\n${marker}`,
            ),
        ),
        "intro\nnew\nadded\nmiddle\nLAST",
    );
});

Deno.test("workspace patch accepts a standard git text diff and treats headers as metadata", () => {
    assertEquals(
        applyUnifiedPatch(
            "first\nold\nlast\n",
            `diff --git a/file.txt b/file.txt\nindex abc1234..def5678 100644\n${change}`,
        ),
        "first\nnew\nlast\n",
    );
    assertEquals(
        applyUnifiedPatch(
            "old\n",
            diff(
                "@@ -1 +1 @@\n-old\n+new\n",
                "../../metadata-only",
                "../../metadata-only",
            ),
        ),
        "new\n",
    );
});

Deno.test("workspace patch supports inserting into and clearing an existing file", () => {
    assertEquals(applyUnifiedPatch("", diff("@@ -0,0 +1 @@\n+new\n")), "new\n");
    assertEquals(applyUnifiedPatch("old\n", diff("@@ -1 +0,0 @@\n-old\n")), "");
});

Deno.test("workspace patch never treats a terminal newline as another empty source line", () => {
    for (
        const hunks of [
            "@@ -2 +2 @@\n-\n+new\n",
            "@@ -1 +1 @@\n-\n+new\n",
            "@@ -2,0 +3 @@\n+new\n",
        ]
    ) {
        assertThrows(() => applyUnifiedPatch("old\n", diff(hunks)));
    }
    assertThrows(() => applyUnifiedPatch("", diff("@@ -1 +1 @@\n-\n+new\n")));
    assertEquals(
        applyUnifiedPatch("old\n", diff("@@ -1,0 +2 @@\n+new\n")),
        "old\nnew\n",
    );
    assertEquals(
        applyUnifiedPatch("old\n\n", diff("@@ -2 +2 @@\n-\n+new\n")),
        "old\nnew\n",
    );
});

Deno.test("workspace patch rejects multiple files, file operations, binary and empty patches", () => {
    const hunk = "@@ -1 +1 @@\n-old\n+new\n";
    for (
        const patch of [
            "",
            "garbage",
            hunk,
            diff(""),
            diff("@@ -1 +1 @@\n old\n"),
            diff("@@ -0,0 +0,0 @@\n"),
            change + diff(hunk, "a/second.txt", "b/second.txt"),
            diff(hunk, "/dev/null", "file.txt"),
            diff(hunk, "file.txt", "/dev/null"),
            diff(hunk, "a/old.txt", "b/new.txt"),
            `new file mode 100644\n${change}`,
            `deleted file mode 100644\n${change}`,
            `rename from file.txt\nrename to other.txt\n${change}`,
            `copy from file.txt\ncopy to other.txt\n${change}`,
            `GIT binary patch\n${change}`,
            `Binary files a/file.txt and b/file.txt differ\n${change}`,
            diff("@@ -1 +1 @@\n-old\n+new\0\n"),
        ]
    ) {
        assertThrows(() => applyUnifiedPatch("old\n", patch));
    }
});

Deno.test("workspace patch rejects malformed counts, headers and oversized input", () => {
    for (
        const hunks of [
            "@@ -1,2 +1 @@\n-old\n+new\n",
            "@@ invalid @@\n-old\n+new\n",
            "@@ -999999999999999999999,0 +1 @@\n+new\n",
            "@@ -99999,0 +1 @@\n+new\n",
        ]
    ) {
        assertThrows(() => applyUnifiedPatch("old\n", diff(hunks)));
    }
    assertThrows(() =>
        applyUnifiedPatch("old\n", " ".repeat(MAX_PATCH_CHARS + 1))
    );
});

Deno.test("workspace replacement is literal, exact and rejects ambiguity by default", () => {
    assertEquals(replaceText("a.old.b", ".old.", "$&$1"), "a$&$1b");
    assertEquals(replaceText("old\nold\n", "old", "new", true), "new\nnew\n");
    assertEquals(replaceText("old", "old", ""), "");
    assertThrows(() => replaceText("old", "", "new"), Error, "empty");
    assertThrows(() => replaceText("old", "OLD", "new"), Error, "match");
    assertThrows(() => replaceText("old old", "old", "new"), Error, "multiple");
    assertThrows(() => replaceText("aaa", "aa", "new"), Error, "multiple");
});

Deno.test("workspace replacement rejects oversized results before allocation", () => {
    const content = "a".repeat(MAX_FILE_BYTES);
    assertThrows(
        () => replaceText(content, "a", "b".repeat(MAX_PATCH_CHARS), true),
        Error,
        "Replacement exceeds",
    );
    assertThrows(
        () => replaceText(content, content, "b".repeat(MAX_FILE_BYTES + 1)),
        Error,
        "Replacement exceeds",
    );
    assertEquals(replaceText(content, "a", "", true), "");
    assertEquals(replaceText(content, "aa", "bb", true).length, MAX_FILE_BYTES);
    assertEquals(replaceText("a", "a", content).length, MAX_FILE_BYTES);
});
