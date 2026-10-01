import { assertEquals, assertExists } from "@std/assert";
import {
    formControls,
    initialFormValues,
    validateForm,
} from "@heimdall/admin-contracts/forms.ts";
import {
    presetConfigSchema,
    sourceConfigSchema,
    sourcePluginIdFor,
} from "@heimdall/core/web/shared/source-schemas.ts";
import {
    DEFAULT_ENDPOINT as OPENAI_ENDPOINT,
    validateOpenAICompatibleSourceConfig,
} from "../../plugins/openai-source/config.ts";
import {
    DEFAULT_ANTHROPIC_VERSION,
    DEFAULT_BASE_URL,
    DEFAULT_ENDPOINT as ANTHROPIC_ENDPOINT,
    validateAnthropicSourceConfig,
} from "../../plugins/anthropic-source/config.ts";

Deno.test("built-in source form defaults produce configurations accepted by their transport validators", () => {
    const openai = sourceConfigSchema("openai-compatible");
    const openaiValues = validateForm(openai, {
        ...initialFormValues(openai),
        baseUrl: "https://example.com/v1",
    });
    assertEquals(openaiValues.valid, true);
    const openaiConfig = validateOpenAICompatibleSourceConfig(
        openaiValues.values as { baseUrl: string },
    );
    assertEquals(openaiConfig.endpoint, OPENAI_ENDPOINT);
    assertEquals(openaiConfig.compat, "full");

    const anthropic = sourceConfigSchema("anthropic");
    const anthropicValues = validateForm(
        anthropic,
        initialFormValues(anthropic),
    );
    assertEquals(anthropicValues.valid, true);
    const anthropicConfig = validateAnthropicSourceConfig(
        anthropicValues.values,
    );
    assertEquals(anthropicConfig.baseUrl, DEFAULT_BASE_URL);
    assertEquals(anthropicConfig.endpoint, ANTHROPIC_ENDPOINT);
    assertEquals(anthropicConfig.anthropicVersion, DEFAULT_ANTHROPIC_VERSION);
});

Deno.test("NewAPI quick preset exposes only connection inputs and uses its exact manifest id", () => {
    const schema = presetConfigSchema("heimdall.preset.newapi");
    assertExists(schema);
    assertEquals(formControls(schema).map((field) => field.name), [
        "baseUrl",
        "apiKey",
    ]);
    assertEquals(presetConfigSchema("newapi"), null);
    assertEquals(presetConfigSchema("unknown"), null);
});

Deno.test("unknown source names cannot select a guessed plugin or configuration schema", () => {
    for (
        const id of ["team-anthropic", "my-openai", "__proto__", "constructor"]
    ) {
        assertEquals(sourcePluginIdFor(id), undefined);
        assertEquals(sourceConfigSchema(id).fields, []);
    }
    assertEquals(
        sourcePluginIdFor("newapi"),
        "heimdall.source.openai-compatible",
    );
    assertEquals(
        sourcePluginIdFor("heimdall.source.anthropic"),
        "heimdall.source.anthropic",
    );
});

Deno.test("provider connection schemas do not render the host model mapping as raw JSON", () => {
    for (const sourceId of ["openai-compatible", "anthropic"]) {
        assertEquals(
            formControls(sourceConfigSchema(sourceId)).some((field) =>
                field.name === "modelMap"
            ),
            false,
        );
    }
});
