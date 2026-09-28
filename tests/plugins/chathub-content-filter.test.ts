import { assert, assertEquals } from "@std/assert";
import {
    ChatHubContentFilterError,
    isContentPolicyBlock,
} from "../../plugins/chathub-source/tools.ts";

Deno.test("isContentPolicyBlock recognises the observed Copilot refusals", () => {
    const blocked = [
        "Hmm...it looks like I can't chat about this. Let's try a different topic.",
        "Sorry, it looks like I can't chat about this. Let's try a different topic.",
        "Sorry, it looks like I can’t respond to this. Let’s try a different topic.",
        "I'm sorry, I can't respond to that.",
        "很抱歉，我无法回答这个问题。",
    ];
    for (const text of blocked) {
        assert(isContentPolicyBlock(text), `should flag: ${text}`);
    }
});

Deno.test("isContentPolicyBlock leaves real answers alone", () => {
    assertEquals(isContentPolicyBlock(undefined), false);
    assertEquals(isContentPolicyBlock(""), false);
    assertEquals(
        isContentPolicyBlock("当然可以，下面是 10 个关于该主题的想法……"),
        false,
    );
    // A long reply that merely mentions changing topics is not a refusal.
    assertEquals(
        isContentPolicyBlock(
            "Let's try a different topic. ".repeat(20),
        ),
        false,
    );
});

Deno.test("ChatHubContentFilterError carries a stable name", () => {
    assertEquals(
        new ChatHubContentFilterError().name,
        "ChatHubContentFilterError",
    );
});
