import { assertEquals, assertThrows } from "@std/assert";
import {
    applyFrame,
    HipValidationError,
    initialState,
    type StreamEvent,
    type StreamFrame,
    validateStreamFrame,
} from "@heimdall/hip";

function frame(seq: number, event: StreamEvent): StreamFrame {
    return {
        version: 1,
        streamId: "s",
        requestId: "r",
        seq,
        eventId: `e${seq}`,
        timestamp: "2026-09-22T00:00:00.000Z",
        event,
    };
}

Deno.test("HIP validates title and suggestions metadata events", () => {
    validateStreamFrame(frame(1, { kind: "title", title: "Cats 101" }));
    validateStreamFrame(
        frame(2, { kind: "suggestions", suggestions: ["one", "two"] }),
    );
    assertThrows(
        () => validateStreamFrame(frame(1, { kind: "title", title: "" })),
        HipValidationError,
    );
    assertThrows(
        () =>
            validateStreamFrame(
                // deno-lint-ignore no-explicit-any
                frame(1, { kind: "suggestions", suggestions: [1] as any }),
            ),
        HipValidationError,
    );
});

Deno.test("HIP reducer projects title and suggestions into state", () => {
    const running = {
        ...initialState("s", "r"),
        status: "running" as const,
        seq: 1,
    };
    const withTitle = applyFrame(
        running,
        frame(2, { kind: "title", title: "Cats 101" }),
    );
    assertEquals(withTitle.title, "Cats 101");
    const withSuggestions = applyFrame(
        withTitle,
        frame(3, { kind: "suggestions", suggestions: ["a", "b"] }),
    );
    assertEquals(withSuggestions.suggestions, ["a", "b"]);
    // The metadata events never become terminal, so the run stays running.
    assertEquals(withSuggestions.status, "running");
});
