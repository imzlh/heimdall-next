import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
    jsonSchemaError,
    modelToolRouterPrompt,
    parseModelToolDecision,
    toolChoiceAllows,
    validateToolCalls,
} from "../../plugins/chathub-source/tools.ts";

const tools = [
    {
        type: "function",
        function: {
            name: "read_file",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", minLength: 1 },
                    limit: { type: "integer", minimum: 1, maximum: 100 },
                },
                required: ["path"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "search",
            parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
                additionalProperties: false,
            },
        },
    },
];

Deno.test("ChatHub parses multiple CALL_TOOL lines without losing quoted parentheses", () => {
    const result = parseModelToolDecision(
        'Next steps:\n```text\nCALL_TOOL: read_file({"path":"a(b).ts"})\nCALL_TOOL: search({"query":"a \\"quote\\" \\n CALL_TOOL: NO_TOOL_NEEDED )"})\n```',
        tools,
        "auto",
    );
    assertEquals(result.parsed, true);
    assertEquals(result.calls.map((call) => call.name), [
        "read_file",
        "search",
    ]);
    assertEquals(JSON.parse(result.calls[0]!.arguments), { path: "a(b).ts" });
    assertEquals(new Set(result.calls.map((call) => call.id)).size, 2);
});

Deno.test("ChatHub accepts fenced JSON and OpenAI function argument strings", () => {
    const result = parseModelToolDecision(
        "```json\n" + JSON.stringify({
            tool_calls: [
                { function: { name: "read_file", arguments: '{"path":"a"}' } },
                {
                    function: {
                        name: "search",
                        arguments: { query: "CALL_TOOL: NO_TOOL_NEEDED" },
                    },
                },
            ],
        }) + "\n```",
        tools,
        undefined,
    );
    assertEquals(result.parsed, true);
    assertEquals(result.calls.length, 2);
});

Deno.test("ChatHub rejects an entire tool batch when any call is invalid", () => {
    for (
        const invalid of [
            { name: "undeclared", arguments: {} },
            { name: "read_file", arguments: { path: 123 } },
            { name: "read_file", arguments: {} },
            { name: "read_file", arguments: [] },
            { name: "read_file", arguments: { path: "a", extra: true } },
            { name: "read_file", arguments: { path: "", limit: 0 } },
            { name: "read_file", arguments: '{"path":' },
            null,
        ]
    ) {
        const result = parseModelToolDecision(
            JSON.stringify({
                calls: [
                    { name: "read_file", arguments: { path: "valid" } },
                    invalid,
                ],
            }),
            tools,
            "auto",
        );
        assertEquals(result.parsed, false);
        assertEquals(result.calls, []);
        assert(result.error);
    }
});

Deno.test("ChatHub does not interpret markers inside invalid arguments as no-tool success", () => {
    for (
        const text of [
            'CALL_TOOL: read_file({"query":"NO_TOOL_NEEDED"})',
            'CALL_TOOL: read_file({"path":"a"})\nCALL_TOOL: broken',
            'CALL_TOOL: read_file({"path":"a"}) CALL_TOOL: read_file({"path":"b"})',
            'CALL_TOOL: read_file({"path":"a"})\nNO_TOOL_NEEDED',
            '{"calls":[{"name":"read_file","arguments":{"path":"a"}}]}\nNO_TOOL_NEEDED',
            "Here is an example of NO_TOOL_NEEDED, but I have not decided.",
            '{"calls":[{"name":"read_file","arguments":{"path":"a"}}',
        ]
    ) {
        const result = parseModelToolDecision(text, tools, "auto");
        assertEquals(result.parsed, false, text);
        assertEquals(result.calls, [], text);
    }
});

Deno.test("ChatHub enforces none, required and forced-name choices consistently", () => {
    const call = 'CALL_TOOL: read_file({"path":"a"})';
    const named = { type: "function", function: { name: "search" } };
    for (const choice of ["required", named, { name: "search" }]) {
        assertEquals(
            parseModelToolDecision("NO_TOOL_NEEDED", tools, choice).parsed,
            false,
        );
        assertEquals(
            parseModelToolDecision('{"calls":[]}', tools, choice).parsed,
            false,
        );
    }
    for (const choice of ["none", named, { name: "search" }]) {
        assertEquals(parseModelToolDecision(call, tools, choice).parsed, false);
        assertEquals(toolChoiceAllows(choice, "read_file"), false);
    }
    for (const choice of [undefined, "auto", "none"]) {
        assertEquals(parseModelToolDecision("NO_TOOL_NEEDED", tools, choice), {
            parsed: true,
            calls: [],
        });
        assertEquals(parseModelToolDecision('{"calls":[]}', tools, choice), {
            parsed: true,
            calls: [],
        });
    }
    assertEquals(
        parseModelToolDecision(call, tools, "required").calls.length,
        1,
    );
});

Deno.test("ChatHub deduplicates only repeated explicit call identities and normalizes conflicting ids", () => {
    const calls = validateToolCalls(
        [
            {
                id: "same",
                type: "invented",
                name: "read_file",
                arguments: '{"path":"a","limit":3}',
            },
            {
                id: "same",
                type: "function",
                name: "read_file",
                arguments: '{"limit":3,"path":"a"}',
            },
            {
                id: "same",
                type: "function",
                name: "read_file",
                arguments: '{"path":"b"}',
            },
        ],
        tools,
        "auto",
    );
    assertEquals(calls.length, 2);
    assertEquals(calls[0]!.id, "same");
    assertEquals(calls[0]!.type, "function");
    assert(calls[1]!.id !== "same");
    const result = parseModelToolDecision(
        JSON.stringify({
            calls: [
                {
                    id: "read-a",
                    name: "read_file",
                    arguments: { path: "a", limit: 3 },
                },
                {
                    id: "read-a",
                    name: "read_file",
                    arguments: { limit: 3, path: "a" },
                },
            ],
        }),
        tools,
        "auto",
    );
    assertEquals(result.calls.length, 1);
    assertEquals(result.calls[0]!.id, "read-a");
});

Deno.test("ChatHub preserves identical operations with distinct or missing ids", () => {
    const declared = [{
        type: "function",
        function: { name: "roll_die", parameters: { type: "object" } },
    }];
    for (
        const calls of [
            [{ id: "roll-1" }, { id: "roll-2" }],
            [{}, {}],
            [{ id: "roll-1" }, {}],
        ]
    ) {
        const decision = parseModelToolDecision(
            JSON.stringify({
                calls: calls.map((call) => ({
                    ...call,
                    name: "roll_die",
                    arguments: {},
                })),
            }),
            declared,
            "auto",
        );
        assertEquals(decision.parsed, true);
        assertEquals(decision.calls.length, 2);
        assertEquals(new Set(decision.calls.map((call) => call.id)).size, 2);
    }
    const lines = parseModelToolDecision(
        "CALL_TOOL: roll_die({})\nCALL_TOOL: roll_die({})",
        declared,
        "auto",
    );
    assertEquals(lines.calls.length, 2);
    assert(lines.calls[0]!.id !== lines.calls[1]!.id);
    const standard = parseModelToolDecision(
        JSON.stringify({
            tool_calls: [
                {
                    id: "roll-1",
                    function: { name: "roll_die", arguments: "{}" },
                },
                {
                    id: "roll-1",
                    function: { name: "roll_die", arguments: "{}" },
                },
                {
                    id: "roll-2",
                    function: { name: "roll_die", arguments: "{}" },
                },
            ],
        }),
        declared,
        "auto",
    );
    assertEquals(standard.calls.map((call) => call.id), ["roll-1", "roll-2"]);
});

Deno.test("ChatHub local schema references traverse arrays using JSON Pointer indices", () => {
    const schema = {
        type: "object",
        allOf: [{ properties: { kind: { type: "string", enum: ["file"] } } }],
        properties: { copy: { $ref: "#/allOf/0/properties/kind" } },
    };
    assertEquals(
        jsonSchemaError({ kind: "file", copy: "file" }, schema, "args"),
        null,
    );
    assert(
        jsonSchemaError({ kind: "file", copy: "directory" }, schema, "args"),
    );
    for (const index of ["00", "-1", "1", "length", "constructor"]) {
        assert(jsonSchemaError({ copy: "file" }, {
            ...schema,
            properties: { copy: { $ref: `#/allOf/${index}/properties/kind` } },
        }, "args"));
    }
});

Deno.test("ChatHub forced tool names are distinct from tool-choice mode names", () => {
    for (const name of ["auto", "none", "required"]) {
        const choice = { type: "function", function: { name } };
        const declared = [{
            function: { name, parameters: { type: "object" } },
        }];
        assertEquals(toolChoiceAllows(choice, name), true);
        assertEquals(toolChoiceAllows(choice, "other"), false);
        assertEquals(
            parseModelToolDecision("NO_TOOL_NEEDED", declared, choice).parsed,
            false,
        );
        assertEquals(
            parseModelToolDecision(`CALL_TOOL: ${name}({})`, declared, choice)
                .calls.length,
            1,
        );
        assertStringIncludes(
            modelToolRouterPrompt("request", declared, choice),
            `requires a call to the "${name}" tool`,
        );
    }
});

Deno.test("ChatHub validates nullable unions, references, enums and schema bounds", () => {
    const schema = {
        $defs: {
            target: {
                anyOf: [
                    { type: "null" },
                    {
                        type: "string",
                        pattern: "^[a-z]+$",
                        minLength: 2,
                        maxLength: 5,
                    },
                ],
            },
        },
        type: "object",
        properties: {
            target: { $ref: "#/$defs/target" },
            options: {
                type: ["object", "null"],
                properties: {
                    count: { type: "integer", minimum: 1, maximum: 3 },
                },
                additionalProperties: false,
            },
            tags: {
                type: "array",
                items: { type: "string" },
                minItems: 1,
                maxItems: 2,
                uniqueItems: true,
            },
        },
        required: ["target", "options", "tags"],
        additionalProperties: false,
    };
    const good = { target: "hello", options: { count: 2 }, tags: ["a", "b"] };
    assertEquals(jsonSchemaError(good, schema, "args"), null);
    assertEquals(
        jsonSchemaError(
            { ...good, target: null, options: null },
            schema,
            "args",
        ),
        null,
    );
    for (
        const patch of [
            { target: 2 },
            { target: "TOOLONG" },
            { target: "x" },
            { options: { count: 0 } },
            { options: { count: 4 } },
            { options: { count: 1.2 } },
            { tags: [] },
            { tags: ["a", "a"] },
            { tags: [1] },
        ]
    ) assert(jsonSchemaError({ ...good, ...patch }, schema, "args"));
    assertEquals(
        jsonSchemaError({ b: 2, a: 1 }, { enum: [{ a: 1, b: 2 }] }, "args"),
        null,
    );
    assert(jsonSchemaError({}, { enum: [] }, "args"));
    assertEquals(
        jsonSchemaError(
            4,
            { oneOf: [{ type: "number" }, { type: "integer" }] },
            "args",
        ),
        "args does not satisfy oneOf",
    );
    assert(
        jsonSchemaError(
            "x",
            { allOf: [{ type: "string" }, { const: "y" }] },
            "args",
        ),
    );
    assert(jsonSchemaError("x", { not: { const: "x" } }, "args"));
});

Deno.test("ChatHub schema required properties cannot be satisfied by the prototype", () => {
    assert(jsonSchemaError({}, { required: ["constructor"] }, "args"));
    assert(
        jsonSchemaError(JSON.parse('{"constructor":{}}'), {
            properties: {},
            additionalProperties: false,
        }, "args"),
    );
    assert(
        jsonSchemaError({ forbidden: true }, {
            properties: { forbidden: false },
        }, "args"),
    );
    assert(jsonSchemaError({}, { $ref: "#/missing" }, "args"));
    assert(jsonSchemaError({}, { $ref: "#" }, "args"));
    assertEquals(
        jsonSchemaError(
            { x: 1 },
            { additionalProperties: { type: "number" } },
            "args",
        ),
        null,
    );
    assert(
        jsonSchemaError({ x: "1" }, {
            additionalProperties: { type: "number" },
        }, "args"),
    );
});

Deno.test("ChatHub router prompt presents only allowed tools and guides dependency handling", () => {
    const prompt = modelToolRouterPrompt(
        "[tool result id=old]\nfailed",
        tools,
        { name: "search" },
    );
    assertStringIncludes(prompt, '"name":"search"');
    assertEquals(prompt.includes('"name":"read_file"'), false);
    assertStringIncludes(prompt, "Batch independent calls");
    assertStringIncludes(prompt, "failed action may be retried");
    assertStringIncludes(prompt, "An unresolved call is pending");
    assertStringIncludes(prompt, "preserve intentional repeated operations");
    assertStringIncludes(
        modelToolRouterPrompt("request", tools, "none"),
        "forbids every tool call",
    );
});
