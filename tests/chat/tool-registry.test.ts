import { assertEquals, assertThrows } from "@std/assert";
import type { ServerTool, ToolOutcome, ToolPlugin } from "@heimdall/contracts";
import {
    MAX_TOOL_ARGUMENT_CHARS,
    MAX_TOOL_TEXT_CHARS,
} from "@heimdall/core/chat/constants.ts";
import {
    createChatToolset,
    newRunBudget,
} from "@heimdall/core/chat/tools/toolset.ts";

function plugin(
    id: string,
    name: string,
    execute: ServerTool["execute"],
): ToolPlugin {
    return {
        manifest: {
            id,
            name: id,
            apiVersion: "1",
            version: "1.0.0",
            kind: "tool",
            trust: "trusted",
        },
        tools: [{
            definition: { name, inputSchema: { type: "object" } },
            execute,
        }],
    };
}

const signal = new AbortController().signal;
const invocation = (name: string, argumentsText = "{}") => ({
    callId: "call-1",
    name,
    argumentsText,
});

Deno.test("chat core starts without tool implementations and accepts arbitrary injected names", async () => {
    const empty = createChatToolset();
    assertEquals(empty.definitions, []);
    assertEquals(empty.isServerTool("current_time"), false);
    assertEquals(
        (await empty.run(invocation("current_time"), newRunBudget(), signal))
            .isError,
        true,
    );
    const calls: string[] = [];
    const registry = createChatToolset([
        plugin("example.echo", "arbitrary_echo", (call, context) => {
            assertEquals(context.signal, signal);
            calls.push(call.argumentsText);
            return { text: call.argumentsText, isError: false };
        }),
    ]);
    assertEquals(registry.definitions[0]?.execution, "server");
    assertEquals(registry.isServerTool("arbitrary_echo"), true);
    assertEquals(
        await registry.run(
            invocation("arbitrary_echo", '{"value":42}'),
            newRunBudget(),
            signal,
        ),
        { text: '{"value":42}', isError: false },
    );
    assertEquals(calls, ['{"value":42}']);
});

Deno.test("tool budgets share a run while isolating plugin keys", async () => {
    const execute: ServerTool["execute"] = (_call, { budget }) => ({
        text: "result",
        isError: !budget.consume("same-key", 1),
    });
    const registry = createChatToolset([
        plugin("one", "first", execute),
        plugin("two", "second", execute),
    ]);
    const budget = newRunBudget();
    for (const name of ["first", "second"]) {
        assertEquals(
            (await registry.run(invocation(name), budget, signal)).isError,
            false,
        );
        assertEquals(
            (await registry.run(invocation(name), budget, signal)).isError,
            true,
        );
    }
    assertEquals(
        (await registry.run(invocation("first"), newRunBudget(), signal))
            .isError,
        false,
    );
});

Deno.test("tool registration rejects conflicting plugin identities and tool names", () => {
    const first = plugin(
        "example",
        "same_name",
        () => ({ text: "", isError: false }),
    );
    assertThrows(
        () => createChatToolset([first, first]),
        TypeError,
        "duplicate tool plugin",
    );
    assertThrows(
        () =>
            createChatToolset([first, {
                ...first,
                manifest: { ...first.manifest, id: "another" },
            }]),
        TypeError,
        "duplicate tool name",
    );
});

Deno.test("tool execution bounds arguments and outputs and contains plugin failures", async () => {
    let calls = 0;
    const registry = createChatToolset([
        plugin("large", "large", () => {
            calls++;
            return {
                text: "x".repeat(MAX_TOOL_TEXT_CHARS + 1),
                isError: false,
            };
        }),
        plugin("throws", "throws", () => {
            throw new Error("secret credential");
        }),
        plugin(
            "invalid",
            "invalid",
            () => ({ text: 3 } as unknown as ToolOutcome),
        ),
    ]);
    const budget = newRunBudget();
    assertEquals(
        await registry.run(
            invocation("large", "x".repeat(MAX_TOOL_ARGUMENT_CHARS + 1)),
            budget,
            signal,
        ),
        { text: "tool arguments are too large", isError: true },
    );
    assertEquals(calls, 0);
    assertEquals(
        (await registry.run(invocation("large"), budget, signal)).text.length,
        MAX_TOOL_TEXT_CHARS,
    );
    assertEquals(await registry.run(invocation("throws"), budget, signal), {
        text: "tool execution failed",
        isError: true,
    });
    assertEquals(await registry.run(invocation("invalid"), budget, signal), {
        text: "tool returned an invalid result",
        isError: true,
    });
});

Deno.test("tool execution respects cancellation before and during plugin work", async () => {
    const controller = new AbortController();
    let calls = 0;
    const registry = createChatToolset([plugin("cancel", "cancel", () => {
        calls++;
        controller.abort();
        return { text: "late result", isError: false };
    })]);
    const budget = newRunBudget();
    const call = invocation("cancel");
    assertEquals(await registry.run(call, budget, controller.signal), {
        text: "tool execution cancelled",
        isError: true,
    });
    assertEquals(await registry.run(call, budget, controller.signal), {
        text: "tool execution cancelled",
        isError: true,
    });
    assertEquals(calls, 1);
});
