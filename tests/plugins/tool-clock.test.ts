import { assertEquals, assertMatch } from "@std/assert";
import type { ServerTool, ToolExecutionContext } from "@heimdall/contracts";
import {
    createClockToolPlugin,
    toolPlugin,
} from "../../plugins/tool-clock/mod.ts";

function invoke(
    clock: ServerTool,
    argumentsText = "{}",
    name = "current_time",
) {
    const context: ToolExecutionContext = {
        signal: new AbortController().signal,
        budget: {
            consume() {
                throw new Error("the clock must not consume a tool budget");
            },
        },
    };
    return clock.execute(
        { callId: "clock-call", name, argumentsText },
        context,
    );
}

Deno.test("clock factory exposes an executable server tool without configuration", async () => {
    const plugin = toolPlugin.create({
        env() {
            throw new Error("the clock must not require environment variables");
        },
    });
    assertEquals(plugin.manifest, toolPlugin.manifest);
    assertEquals(plugin.manifest.id, "heimdall.tool.clock");
    assertEquals(plugin.manifest.kind, "tool");
    assertEquals(plugin.tools.length, 1);
    const clock = plugin.tools[0]!;
    assertEquals(clock.definition.name, "current_time");
    assertEquals(clock.definition.execution, "server");
    assertEquals(clock.definition.inputSchema, {
        type: "object",
        properties: {},
        additionalProperties: false,
    });
    const outcome = await invoke(clock);
    assertEquals(outcome.isError, false);
    assertMatch(
        outcome.text,
        /^Current time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \(UTC\)\.$/,
    );
});

Deno.test("clock reads the injected time on each invocation", async () => {
    let reads = 0;
    const clock = createClockToolPlugin({
        now: () => new Date(Date.UTC(2026, 8, 24, 8, 30, reads++)),
    }).tools[0]!;
    assertEquals(await invoke(clock), {
        text: "Current time: 2026-09-24T08:30:00.000Z (UTC).",
        isError: false,
    });
    assertEquals(await invoke(clock), {
        text: "Current time: 2026-09-24T08:30:01.000Z (UTC).",
        isError: false,
    });
});

Deno.test("clock enforces argument limits before dispatch and avoids reading time on errors", async () => {
    let reads = 0;
    const clock = createClockToolPlugin({
        now: () => {
            reads += 1;
            return new Date("2026-09-24T08:30:00.000Z");
        },
    }).tools[0]!;
    const atLimit = "{}".padEnd(32_768, " ");
    assertEquals((await invoke(clock, atLimit)).isError, false);
    const oversized = `${atLimit} `;
    const tooLarge = { text: "tool arguments are too large", isError: true };
    assertEquals(await invoke(clock, oversized), tooLarge);
    assertEquals(await invoke(clock, "{}", "missing"), {
        text: "unknown tool: missing",
        isError: true,
    });
    assertEquals(await invoke(clock, oversized, "missing"), tooLarge);
    assertEquals(reads, 1);
});
