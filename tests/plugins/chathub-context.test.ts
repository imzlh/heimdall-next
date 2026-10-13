import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { GenerationRequest } from "@heimdall/contracts";
import {
    conversationHistoryHash,
    conversationMessages,
    conversationText,
} from "../../plugins/chathub-source/request.ts";
import { flattenConversation } from "../../plugins/chathub-source/tools.ts";

Deno.test("ChatHub reconstruction preserves mixed text, call and result order", () => {
    const request: GenerationRequest = {
        messages: [{
            id: "mixed-message",
            role: "assistant",
            parts: [
                {
                    id: "before",
                    type: "text",
                    text: "Inspect the configuration",
                },
                {
                    id: "call",
                    type: "tool_call",
                    callId: "read-config",
                    name: "read_file",
                    argumentsText: '{"path":"config.json"}',
                },
                {
                    id: "result",
                    type: "tool_result",
                    callId: "read-config",
                    result: { port: 8765 },
                },
                {
                    id: "after",
                    type: "text",
                    text: "The configured port is known",
                },
            ],
        }],
    };
    const text = conversationText(request);
    const ordered = [
        "Inspect the configuration",
        "[assistant tool_calls]",
        "[tool result id=",
        '"port":8765',
        "The configured port is known",
    ].map((fragment) => {
        assertStringIncludes(text, fragment);
        return text.indexOf(fragment);
    });
    assertEquals(ordered, [...ordered].sort((left, right) => left - right));
});

Deno.test("ChatHub empty tool parts retain structured result and failure details", () => {
    const error = {
        code: "permission_denied",
        message: "Cannot read the requested file",
        retryable: false,
    };
    const messages = conversationMessages({
        messages: [{
            id: "results",
            role: "tool",
            parts: [
                {
                    id: "success",
                    type: "tool_result",
                    callId: "success-call",
                    parts: [],
                    result: { count: 3 },
                },
                {
                    id: "failure",
                    type: "tool_result",
                    callId: "failed-call",
                    parts: [],
                    isError: true,
                    error,
                },
            ],
        }],
    });
    assertEquals(messages.length, 2);
    assertEquals(JSON.parse(String(messages[0]!.content)), { count: 3 });
    assertEquals(JSON.parse(String(messages[1]!.content)), error);
});

Deno.test("ChatHub tool results retain the matching tool name and error status", () => {
    const messages = conversationMessages({
        messages: [{
            id: "calls",
            role: "assistant",
            parts: [{
                id: "read-call",
                type: "tool_call",
                callId: "read-1",
                name: "read_file",
                argumentsText: '{"path":"missing.txt"}',
            }],
        }, {
            id: "results",
            role: "tool",
            parts: [{
                id: "read-result",
                type: "tool_result",
                callId: "read-1",
                isError: true,
                result: { message: "File does not exist" },
            }],
        }],
    });
    const result = messages.find((message) => message.role === "tool");
    assert(result);
    assertEquals(result.tool_call_id, "read-1");
    assertEquals(result.name, "read_file");
    assertEquals(result.is_error, true);
    assertStringIncludes(String(result.content), "File does not exist");
});

Deno.test("ChatHub reconstruction retains JSON evidence nested in tool parts", () => {
    const text = conversationText({
        messages: [{
            id: "json-input",
            role: "user",
            parts: [{
                id: "specification",
                type: "json",
                value: { expected: ["alpha", "beta"] },
            }],
        }, {
            id: "json-output",
            role: "tool",
            parts: [{
                id: "result",
                type: "tool_result",
                callId: "scan-1",
                parts: [
                    { id: "label", type: "text", text: "Scan evidence:" },
                    {
                        id: "structured-evidence",
                        type: "json",
                        value: { actual: { names: ["alpha", "beta"] } },
                    },
                    {
                        id: "raw-evidence",
                        type: "json",
                        text: '{"verified":true}',
                    },
                ],
            }],
        }],
    });
    assertStringIncludes(text, '{"expected":["alpha","beta"]}');
    assertStringIncludes(text, "Scan evidence:");
    assertStringIncludes(text, '{"actual":{"names":["alpha","beta"]}}');
    assertStringIncludes(text, '{"verified":true}');
});

Deno.test("ChatHub preserves the middle of recent tool evidence within the total budget", () => {
    const evidence = "a".repeat(3500) + "CRITICAL_MIDDLE_EVIDENCE" +
        "z".repeat(3500);
    const text = flattenConversation([
        { role: "user", content: "Diagnose the failure using this output" },
        { role: "tool", tool_call_id: "diagnostic-1", content: evidence },
    ]);
    assertStringIncludes(text, evidence);
    assertEquals(text.includes("truncated"), false);
});

Deno.test("ChatHub compacts older results only when their total exceeds the budget", () => {
    const older = "旧日志开头\n" + "旧".repeat(20000) + "\n旧日志结尾";
    const latest = "a".repeat(3000) + "LATEST_CRITICAL_EVIDENCE" +
        "z".repeat(3000);
    const text = flattenConversation([
        { role: "tool", tool_call_id: "older-call", content: older },
        { role: "tool", tool_call_id: "latest-call", content: latest },
    ], { toolResultBudget: 12000 });
    assert(/\[tool result id="?older-call"?(?:\s|\])/.test(text));
    assertStringIncludes(text, "旧日志开头");
    assertStringIncludes(text, "旧日志结尾");
    assertStringIncludes(text, "characters");
    assertEquals(text.includes("bytes"), false);
    assertStringIncludes(text, latest);
    assert(
        text.length < 12500,
        "tool output did not respect its shared budget",
    );
});

Deno.test("ChatHub keeps tool result identities when many old results are compacted", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
        role: "tool",
        tool_call_id: `call-${index}`,
        content: `result-${index}:` + "x".repeat(5000),
    }));
    const text = flattenConversation(messages, { toolResultBudget: 8000 });
    for (const message of messages) {
        assert(
            new RegExp(
                `\\[tool result id="?${message.tool_call_id}"?(?:\\s|\\])`,
            ).test(text),
            `lost tool result ${message.tool_call_id}`,
        );
    }
    assert(
        text.includes(messages.at(-1)!.content),
        "recent evidence was truncated while it still fits the shared budget",
    );
    assertStringIncludes(text, "characters");
});

Deno.test("ChatHub history fingerprints detect edited image bytes with unchanged text", async () => {
    const messagesWithImage = (data: Uint8Array) =>
        conversationMessages({
            messages: [{
                id: "image-message",
                role: "user",
                parts: [{
                    id: "image-part",
                    type: "image",
                    source: { mediaType: "image/png", data },
                }],
            }],
        });
    const original = messagesWithImage(new Uint8Array([1, 2, 3]));
    const same = messagesWithImage(new Uint8Array([1, 2, 3]));
    const edited = messagesWithImage(new Uint8Array([1, 9, 3]));
    assertEquals(flattenConversation(original), flattenConversation(edited));
    assertEquals(
        await conversationHistoryHash(original),
        await conversationHistoryHash(same),
    );
    assert(
        await conversationHistoryHash(original) !==
            await conversationHistoryHash(edited),
        "editing an attachment must invalidate the upstream conversation",
    );
});

Deno.test("ChatHub history fingerprints include evidence omitted from the wire prompt", async () => {
    const messagesWithResult = (middle: string) => [{
        role: "tool",
        tool_call_id: "large-result",
        content: "a".repeat(6000) + middle + "z".repeat(6000),
    }];
    const original = messagesWithResult("BEFORE");
    const edited = messagesWithResult("AFTER!");
    assertEquals(
        flattenConversation(original, { toolResultBudget: 2000 }),
        flattenConversation(edited, { toolResultBudget: 2000 }),
    );
    assert(
        await conversationHistoryHash(original) !==
            await conversationHistoryHash(edited),
        "editing omitted evidence must invalidate the upstream conversation",
    );
});

Deno.test("ChatHub preserves exact tool ids containing punctuation", () => {
    const id = "call#1/中文";
    const text = conversationText({
        messages: [{
            id: "assistant",
            role: "assistant",
            parts: [{
                id: "call",
                type: "tool_call",
                callId: id,
                name: "lookup",
                argumentsText: "{}",
            }],
        }, {
            id: "tool",
            role: "tool",
            parts: [{
                id: "result",
                type: "tool_result",
                callId: id,
                result: "done",
            }],
        }],
    });
    assertStringIncludes(text, `"id":${JSON.stringify(id)}`);
    assertStringIncludes(text, `id=${JSON.stringify(id)}`);
});

Deno.test("ChatHub marks unavailable tool images and fingerprints their bytes", async () => {
    const messages = (byte: number) =>
        conversationMessages({
            messages: [{
                id: "tool",
                role: "tool",
                parts: [{
                    id: "result",
                    type: "tool_result",
                    callId: "screenshot",
                    parts: [{
                        id: "screenshot",
                        type: "image",
                        source: {
                            mediaType: "image/png",
                            data: new Uint8Array([byte]),
                        },
                    }],
                }],
            }],
        });
    assertStringIncludes(
        flattenConversation(messages(1)),
        "pixels were not uploaded",
    );
    assert(
        await conversationHistoryHash(messages(1)) !==
            await conversationHistoryHash(messages(2)),
    );
});
