import { assertEquals } from "@std/assert";
import type { ChatMessageRecord } from "@heimdall/storage";
import { boundHistory } from "@heimdall/core/chat/history.ts";

function row(
    id: string,
    role: ChatMessageRecord["role"],
    text: string,
): ChatMessageRecord {
    return {
        id,
        conversationId: "c",
        role,
        text,
        createdAt: "2026-09-22T00:00:00.000Z",
    };
}

Deno.test("boundHistory keeps a short history unchanged", () => {
    const messages = [row("1", "user", "hi"), row("2", "assistant", "hello")];
    assertEquals(boundHistory(messages, 40, 24_000), messages);
});

Deno.test("boundHistory keeps only the most recent messages by count", () => {
    const messages = Array.from(
        { length: 45 },
        (_, i) => row(String(i), i % 2 === 0 ? "user" : "assistant", `m${i}`),
    );
    const bounded = boundHistory(messages, 40, 24_000);
    assertEquals(bounded.length, 40);
    assertEquals(bounded[0]?.id, "5");
    assertEquals(bounded.at(-1)?.id, "44");
});
Deno.test("boundHistory enforces the character budget, keeping the last message", () => {
    const big = "x".repeat(10_000);
    const messages = [
        row("1", "user", big),
        row("2", "assistant", big),
        row("3", "user", big),
    ];
    assertEquals(
        boundHistory(messages, 40, 24_000).map((m) => m.id),
        ["2", "3"],
    );
    const huge = [
        row("1", "user", "hi"),
        row("2", "assistant", "y".repeat(50_000)),
    ];
    assertEquals(boundHistory(huge, 40, 24_000).map((m) => m.id), ["2"]);
});

Deno.test("boundHistory never begins on a dangling tool result", () => {
    const messages = [
        row("call", "assistant", "{}"),
        row("res", "tool", "result"),
        row("q", "user", "next"),
    ];
    assertEquals(boundHistory(messages, 2, 24_000).map((m) => m.id), ["q"]);
});
