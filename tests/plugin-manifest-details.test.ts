import { assert, assertEquals, assertThrows } from "@std/assert";
import { validatePluginManifest } from "@heimdall/plugin-host/manifest.ts";
import { PluginVerificationError } from "@heimdall/plugin-host";

function manifest(
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        id: "test.details",
        version: "1.0.0",
        apiVersion: "1",
        name: "Plugin details",
        kind: "tool",
        ...extra,
    };
}

function rejected(input: unknown): void {
    const error = assertThrows(
        () => validatePluginManifest(input),
        PluginVerificationError,
    );
    assertEquals(error.code, "invalid_manifest");
}

Deno.test("optional plugin details preserve legacy manifest defaults and omission", () => {
    const result = validatePluginManifest(manifest());
    assertEquals(result, {
        id: "test.details",
        version: "1.0.0",
        apiVersion: "1",
        name: "Plugin details",
        kind: "tool",
        trust: "isolated",
        capabilities: [],
        routes: [],
        permissions: {
            network: false,
            filesystem: "none",
            subprocess: false,
        },
    });
    assert(!Object.hasOwn(result, "description"));
    assert(!Object.hasOwn(result, "dependencies"));
    assert(Object.isFrozen(result));
});

Deno.test("plugin descriptions accept trimmed text at both length boundaries", () => {
    for (
        const description of [
            "x",
            "插件说明",
            "First line\nSecond line",
            "x".repeat(2048),
        ]
    ) {
        const result = validatePluginManifest(manifest({ description }));
        assertEquals(result.description, description);
    }
});

Deno.test("plugin descriptions reject empty untrimmed oversized and nonstring values", () => {
    for (
        const description of [
            "",
            " ",
            " leading",
            "trailing ",
            "\ntext",
            "text\t",
            "\u3000text",
            "x".repeat(2049),
            null,
            1,
            true,
            [],
            {},
        ]
    ) {
        rejected(manifest({ description }));
    }
});

Deno.test("plugin dependencies accept zero to 64 IDs and return a detached frozen list", () => {
    assertEquals(
        validatePluginManifest(manifest({ dependencies: [] })).dependencies,
        [],
    );
    const dependencies = Array.from(
        { length: 64 },
        (_, index) => `dependency.${index}`,
    );
    dependencies[0] = "a";
    dependencies[1] = "a".repeat(128);
    dependencies[2] = "plugin.with_underscores-and-hyphens";
    const input = manifest({ description: "Operator details", dependencies });
    const result = validatePluginManifest(input);
    assertEquals(result.dependencies, dependencies);
    assert(!Object.is(result, input));
    assert(result.dependencies !== dependencies);
    assert(Object.isFrozen(result));
    assert(Object.isFrozen(result.dependencies));
    dependencies[0] = "changed.plugin";
    dependencies.push("added.plugin");
    input.description = "Changed details";
    assertEquals(result.dependencies?.[0], "a");
    assertEquals(result.dependencies?.length, 64);
    assertEquals(result.description, "Operator details");
    assertThrows(() => {
        (result.dependencies as string[]).push("added.plugin");
    }, TypeError);
});

Deno.test("plugin dependencies reject invalid IDs duplicate IDs self references and oversized lists", () => {
    for (
        const dependency of [
            "",
            "a".repeat(129),
            "UPPERCASE",
            ".leading",
            "trailing-",
            "with space",
            "plugin/path",
            "中文",
            null,
            false,
            1,
            {},
            undefined,
        ]
    ) {
        rejected(manifest({ dependencies: [dependency] }));
    }
    rejected(manifest({ dependencies: ["other.plugin", "other.plugin"] }));
    rejected(manifest({ dependencies: ["test.details"] }));
    rejected(manifest({
        dependencies: Array.from(
            { length: 65 },
            (_, index) => `dependency.${index}`,
        ),
    }));
    for (const dependencies of [null, "other.plugin", {}, true]) {
        rejected(manifest({ dependencies }));
    }
});

Deno.test("plugin details reject top-level getters without executing them", () => {
    let executions = 0;
    for (const key of ["description", "dependencies"]) {
        const input = manifest();
        Object.defineProperty(input, key, {
            enumerable: true,
            get() {
                executions++;
                return key === "description" ? "Description" : ["other.plugin"];
            },
        });
        rejected(input);
    }
    assertEquals(executions, 0);
});

Deno.test("plugin dependency array getters and iterators cannot execute during validation", () => {
    let executions = 0;
    const indexed = Object.defineProperty([], "0", {
        enumerable: true,
        get() {
            executions++;
            return "other.plugin";
        },
    });
    const iterator = Object.defineProperty(["other.plugin"], Symbol.iterator, {
        get() {
            executions++;
            return Array.prototype[Symbol.iterator];
        },
    });
    const decorated = Object.defineProperty(["other.plugin"], "extra", {
        enumerable: true,
        get() {
            executions++;
            return "ignored";
        },
    });
    for (const dependencies of [indexed, iterator, decorated]) {
        rejected(manifest({ dependencies }));
        assertEquals(executions, 0);
    }
});

Deno.test("plugin dependencies reject sparse decorated and custom-prototype arrays", () => {
    const sparse = new Array(2);
    sparse[1] = "other.plugin";
    const hidden = Object.defineProperty(["other.plugin"], "extra", {
        value: true,
        enumerable: false,
    });
    const symbolic = Object.assign(["other.plugin"], {
        [Symbol("extra")]: true,
    });
    const customPrototype = Object.setPrototypeOf(
        ["other.plugin"],
        Object.create(Array.prototype),
    );
    for (
        const dependencies of [
            sparse,
            hidden,
            symbolic,
            customPrototype,
            Object.assign(["other.plugin"], { extra: true }),
        ]
    ) {
        rejected(manifest({ dependencies }));
    }
});
