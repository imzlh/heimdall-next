import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { loadUiPolicy, parseUiPolicy } from "../src/composition/ui-policy.ts";

function policy() {
    return {
        trustedModules: {
            "sample.plugin:widget_1": "/admin/assets/plugins/sample/widget.js",
        },
        sandboxDocuments: {
            "sample.plugin:settings-2":
                "/admin/assets/plugins/sample/settings.html",
        },
        allowedActions: {
            "sample.plugin:widget_1": ["refresh", "cache.clear-1"],
            "sample.plugin:settings-2": [] as string[],
        },
    };
}

async function withPolicyFile(
    contents: string | Uint8Array,
    run: (path: string) => Promise<void>,
): Promise<void> {
    const path = await Deno.makeTempFile({
        prefix: "heimdall-ui-policy-",
        suffix: ".json",
    });
    try {
        await Deno.writeFile(
            path,
            typeof contents === "string"
                ? new TextEncoder().encode(contents)
                : contents,
        );
        await run(path);
    } finally {
        await Deno.remove(path);
    }
}

Deno.test("UI policy accepts empty and independently configured allowlists", () => {
    assertEquals(parseUiPolicy({}), {});
    for (
        const name of ["trustedModules", "sandboxDocuments", "allowedActions"]
    ) {
        assertEquals(parseUiPolicy({ [name]: {} }), { [name]: {} });
    }
    for (const [name, entries] of Object.entries(policy())) {
        assertEquals(parseUiPolicy({ [name]: entries }), { [name]: entries });
    }
});

Deno.test("UI policy preserves exact asset and action entries across a detached JSON boundary", () => {
    const input = policy();
    const result = parseUiPolicy(input);
    assertEquals(result, input);
    assert(result !== input);
    assert(result.trustedModules !== input.trustedModules);
    assert(result.sandboxDocuments !== input.sandboxDocuments);
    assert(result.allowedActions !== input.allowedActions);
    assert(
        result.allowedActions?.["sample.plugin:widget_1"] !==
            input.allowedActions["sample.plugin:widget_1"],
    );

    input.trustedModules["sample.plugin:widget_1"] =
        "/admin/assets/plugins/sample/replaced.js";
    input.sandboxDocuments["sample.plugin:settings-2"] =
        "/admin/assets/plugins/sample/replaced.html";
    input.allowedActions["sample.plugin:widget_1"].push("delete");
    input.allowedActions["sample.plugin:settings-2"] = ["save"];
    assertEquals(result, policy());
});

Deno.test("UI policy rejects non-object policies and allowlist containers", () => {
    for (const input of [undefined, null, [], true, 1, "policy", new Date()]) {
        assertThrows(() => parseUiPolicy(input), TypeError);
    }
    for (
        const name of ["trustedModules", "sandboxDocuments", "allowedActions"]
    ) {
        for (const entries of [null, [], true, 1, "entries"]) {
            assertThrows(() => parseUiPolicy({ [name]: entries }), TypeError);
        }
    }
});

Deno.test("UI policy rejects undeclared top-level fields", () => {
    for (const name of ["trust", "trustedPlugins", "permissions", "unknown"]) {
        assertThrows(
            () => parseUiPolicy({ ...policy(), [name]: {} }),
            TypeError,
        );
    }
});

Deno.test("UI policy requires exact plugin:contribution keys in every allowlist", () => {
    const invalidKeys = [
        "",
        "sample",
        ":widget",
        "sample:",
        "sample:widget:extra",
        "sample:*",
        "*:widget",
        ".sample:widget",
        "sample:_widget",
        "sample/widget:status",
        "sample:../widget",
        "sample:widget ",
        "sample:widget\n",
        "sample:\u63a7\u4ef6",
    ];
    for (const key of invalidKeys) {
        for (
            const [name, entry] of [
                ["trustedModules", "/admin/assets/plugins/sample/widget.js"],
                [
                    "sandboxDocuments",
                    "/admin/assets/plugins/sample/widget.html",
                ],
                ["allowedActions", ["refresh"]],
            ] as const
        ) {
            assertThrows(
                () => parseUiPolicy({ [name]: { [key]: entry } }),
                TypeError,
                undefined,
                `Accepted ${name} key ${JSON.stringify(key)}`,
            );
        }
    }
});

Deno.test("UI policy rejects external, traversing and noncanonical asset paths", () => {
    for (
        const [name, extension] of [
            ["trustedModules", "js"],
            ["sandboxDocuments", "html"],
        ] as const
    ) {
        const path = `/admin/assets/plugins/sample/widget.${extension}`;
        for (
            const entry of [
                `https://example.com${path}`,
                `//example.com${path}`,
                path.slice(1),
                `/admin/assets/widget.${extension}`,
                `/admin/assets/plugins/../widget.${extension}`,
                `/admin/assets/plugins/sample/./widget.${extension}`,
                `/admin/assets/plugins/%2e%2e/widget.${extension}`,
                `/admin/assets/plugins/sample%2fwidget.${extension}`,
                `/admin/assets/plugins/sample//widget.${extension}`,
                `/admin/assets/plugins/sample\\widget.${extension}`,
                `${path}?version=1`,
                `${path}#widget`,
                `${path}\n`,
                `${path}\u0000`,
            ]
        ) {
            assertThrows(
                () => parseUiPolicy({ [name]: { "sample:widget": entry } }),
                TypeError,
                undefined,
                `Accepted ${name} asset ${JSON.stringify(entry)}`,
            );
        }
    }
});

Deno.test("UI policy permits only JS trusted modules and HTML sandbox documents", () => {
    for (
        const [name, invalidExtensions] of [
            ["trustedModules", ["html", "mjs", "JS", "js.map"]],
            ["sandboxDocuments", ["js", "htm", "HTML", "html.js"]],
        ] as const
    ) {
        const entries: unknown[] = [null, false, 1, [], {}];
        entries.push(
            ...invalidExtensions.map((extension) =>
                `/admin/assets/plugins/sample/widget.${extension}`
            ),
        );
        for (const entry of entries) {
            assertThrows(
                () => parseUiPolicy({ [name]: { "sample:widget": entry } }),
                TypeError,
            );
        }
    }
});

Deno.test("UI policy accepts 32 actions and 80-character IDs but rejects a 33rd action", () => {
    const actions = Array.from({ length: 32 }, (_, index) => `action-${index}`);
    actions[0] = "a".repeat(80);
    const input = { allowedActions: { "sample:widget": actions } };
    assertEquals(parseUiPolicy(input), input);
    actions.push("one-too-many");
    assertThrows(() => parseUiPolicy(input), TypeError);
});

Deno.test("UI policy rejects malformed action lists and invalid action IDs", () => {
    for (const entry of [null, false, 1, "refresh", {}]) {
        assertThrows(
            () => parseUiPolicy({ allowedActions: { "sample:widget": entry } }),
            TypeError,
        );
    }
    for (
        const action of [
            null,
            false,
            1,
            {},
            [],
            "",
            "_refresh",
            ".refresh",
            "-refresh",
            "refresh now",
            "refresh/now",
            "sample:refresh",
            "refresh*",
            "refresh\n",
            "\u5237\u65b0",
            "a".repeat(81),
        ]
    ) {
        assertThrows(
            () =>
                parseUiPolicy({
                    allowedActions: { "sample:widget": ["refresh", action] },
                }),
            TypeError,
            undefined,
            `Accepted action ${JSON.stringify(action)}`,
        );
    }
});

Deno.test("loading UI policy without a path returns an empty policy", async () => {
    assertEquals(await loadUiPolicy(), {});
    assertEquals(await loadUiPolicy(""), {});
});

Deno.test("loading UI policy reports a missing file", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-ui-policy-" });
    try {
        await assertRejects(
            () => loadUiPolicy(`${directory}/missing.json`),
            Deno.errors.NotFound,
        );
    } finally {
        await Deno.remove(directory);
    }
});

Deno.test("loading UI policy accepts UTF-8 JSON with or without a byte order mark", async () => {
    for (const prefix of ["", "\uFEFF"]) {
        await withPolicyFile(
            prefix + JSON.stringify(policy()),
            async (path) => {
                assertEquals(await loadUiPolicy(path), policy());
            },
        );
    }
});

Deno.test("loading UI policy accepts exactly 16 KiB including UTF-8 bytes", async () => {
    const json = "\uFEFF" + JSON.stringify(policy());
    const size = new TextEncoder().encode(json).length;
    const contents = json + " ".repeat(16_384 - size);
    assertEquals(new TextEncoder().encode(contents).length, 16_384);
    await withPolicyFile(contents, async (path) => {
        assertEquals(await loadUiPolicy(path), policy());
    });
});

Deno.test("loading UI policy rejects a file one byte above 16 KiB", async () => {
    const json = "\uFEFF" + JSON.stringify(policy());
    const size = new TextEncoder().encode(json).length;
    const contents = json + " ".repeat(16_385 - size);
    assertEquals(new TextEncoder().encode(contents).length, 16_385);
    await withPolicyFile(contents, async (path) => {
        await assertRejects(() => loadUiPolicy(path), TypeError, "16 KiB");
    });
});

Deno.test("loading UI policy rejects malformed JSON and invalid policy JSON", async () => {
    for (const contents of ["", "{", '{"allowedActions":{},}', "{} {}"]) {
        await withPolicyFile(contents, async (path) => {
            await assertRejects(() => loadUiPolicy(path), SyntaxError);
        });
    }
    for (const input of [null, [], { unknown: {} }, { allowedActions: [] }]) {
        await withPolicyFile(JSON.stringify(input), async (path) => {
            await assertRejects(() => loadUiPolicy(path), TypeError);
        });
    }
});

Deno.test("loading UI policy rejects malformed UTF-8 before parsing JSON", async () => {
    for (
        const invalid of [
            [0xff],
            [0xc3],
            [0xc3, 0x28],
            [0xc0, 0xaf],
            [0xed, 0xa0, 0x80],
        ]
    ) {
        // A replacement decoder would produce a JSON SyntaxError here instead.
        await withPolicyFile(
            new Uint8Array([0x7b, 0x7d, ...invalid]),
            async (path) => {
                await assertRejects(() => loadUiPolicy(path), TypeError);
            },
        );
    }
});
