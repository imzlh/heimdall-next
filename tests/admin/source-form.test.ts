import { assertEquals } from "@std/assert";
import { sourceConfigSchema } from "@heimdall/core/web/shared/source-schemas.ts";
import {
    prepareSourceInput,
    sourceFormValues,
} from "@heimdall/core/web/client/forms/source-config-model.ts";

Deno.test("source form omits saved secrets and retains hidden preset parameters", () => {
    const schema = sourceConfigSchema("openai-compatible");
    const values = sourceFormValues(schema, {
        baseUrl: "https://models.example/v1",
        endpoint: "/chat/completions",
        modelMap: { fast: "upstream-model" },
        headers: { "x-region": "eu" },
        compat: "full",
        apiKeyConfigured: true,
    });
    assertEquals(values.apiKey, "");
    assertEquals(values.modelMap, undefined);
    const result = prepareSourceInput(
        schema,
        {
            ...values,
            baseUrl: "https://new.example/v1",
            apiKey: "   ",
        },
        "production-channel",
        ["apiKey"],
        "heimdall.preset.newapi",
    );
    assertEquals(result.errors, {});
    assertEquals(result.config, {
        id: "production-channel",
        baseUrl: "https://new.example/v1",
        endpoint: "/chat/completions",
        headers: { "x-region": "eu" },
    });
    assertEquals(Object.hasOwn(result.config!, "apiKey"), false);
});

Deno.test("source preset refuses to silently replace an existing compatibility mode", () => {
    const schema = sourceConfigSchema("openai-compatible");
    const values = sourceFormValues(schema, {
        baseUrl: "https://models.example",
        compat: "embeddings",
    });
    const result = prepareSourceInput(
        schema,
        values,
        "openai-compatible",
        [],
        "heimdall.preset.newapi",
    );
    assertEquals(result.config, undefined);
    assertEquals(Boolean(result.errors.compat), true);
});

Deno.test("source form catches invalid JSON maps before issuing a management write", () => {
    const schema = sourceConfigSchema("anthropic");
    const values = { ...sourceFormValues(schema), headers: '{"x-region":42}' };
    const result = prepareSourceInput(schema, values, "anthropic", []);
    assertEquals(result.config, undefined);
    assertEquals(Boolean(result.errors.headers), true);
});
