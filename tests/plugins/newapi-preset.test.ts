import { assertEquals, assertThrows } from "@std/assert";
import {
    newApiPreset,
    newApiPresetManifest,
    newApiPresetSchema,
    redactNewApiPresetApplication,
    toOpenAICompatibleSourceConfig,
    validateNewApiPresetConfig,
} from "../../plugins/newapi-preset/mod.ts";
import { validateOpenAICompatibleSourceConfig } from "../../plugins/openai-source/mod.ts";

Deno.test("NewAPI preset normalizes into an OpenAI-compatible source config", () => {
    const config = validateNewApiPresetConfig({
        baseUrl: "https://newapi.example/v1/",
        apiKey: "newapi-secret",
    });
    assertEquals(config, {
        id: "newapi",
        baseUrl: "https://newapi.example/v1",
        apiKey: "newapi-secret",
        endpoint: "/chat/completions",
    });
    assertEquals(toOpenAICompatibleSourceConfig(config), config);
});

Deno.test("NewAPI preset preserves explicit source options and rejects unsafe headers", () => {
    assertEquals(
        validateNewApiPresetConfig({
            id: "newapi-primary",
            baseUrl: "https://newapi.example",
            endpoint: "/v1/chat/completions",
            headers: { "x-channel": "primary" },
        }),
        {
            id: "newapi-primary",
            baseUrl: "https://newapi.example",
            endpoint: "/v1/chat/completions",
            headers: { "x-channel": "primary" },
        },
    );
    assertThrows(
        () =>
            validateNewApiPresetConfig({
                baseUrl: "https://newapi.example",
                headers: { authorization: "should-not-be-configured" },
            }),
        TypeError,
    );
});

Deno.test("NewAPI preset declares a non-network preset plugin", () => {
    assertEquals(newApiPresetManifest.id, "heimdall.preset.newapi");
    assertEquals(newApiPresetManifest.kind, "preset");
    assertEquals(newApiPresetManifest.permissions?.network, false);
});

Deno.test("NewAPI schema is closed and rejects malformed nested values", () => {
    assertEquals(newApiPresetSchema.additionalProperties, false);
    assertEquals(newApiPresetSchema.properties.apiKey.writeOnly, true);
    assertThrows(
        () =>
            validateNewApiPresetConfig({
                baseUrl: "https://newapi.example",
                unknown: true,
            } as unknown),
        TypeError,
    );
    assertThrows(
        () =>
            validateNewApiPresetConfig({
                baseUrl: "https://newapi.example",
                modelMap: { local: 42 },
            } as unknown),
        TypeError,
    );
    assertThrows(
        () => validateNewApiPresetConfig(null),
        TypeError,
    );
});

Deno.test("NewAPI preset normalizes endpoints and leaves model mapping to the host", () => {
    const config = validateNewApiPresetConfig({
        baseUrl: "https://newapi.example///",
        endpoint: "//v1///chat/completions/",
    });
    assertEquals(config.baseUrl, "https://newapi.example");
    assertEquals(config.endpoint, "/v1/chat/completions");
    assertThrows(
        () =>
            validateNewApiPresetConfig({
                baseUrl: "https://newapi.example",
                modelMap: { public: "upstream" },
            }),
        TypeError,
        "unknown NewAPI preset field",
    );
});

Deno.test("NewAPI output is accepted by the OpenAI source validator", () => {
    const generated = toOpenAICompatibleSourceConfig({
        baseUrl: "https://newapi.example/v1",
        apiKey: "source-secret",
    });
    assertEquals(validateOpenAICompatibleSourceConfig(generated), {
        ...generated,
        compat: "full",
    });
});

Deno.test("NewAPI preset rejects credential-like and duplicate headers", () => {
    for (
        const name of [
            "x-api-key",
            "x-provider-token",
            "cookie",
            "content-type",
        ]
    ) {
        assertThrows(
            () =>
                validateNewApiPresetConfig({
                    baseUrl: "https://newapi.example",
                    headers: { [name]: "secret" },
                }),
            TypeError,
        );
    }
    assertThrows(
        () =>
            validateNewApiPresetConfig({
                baseUrl: "https://newapi.example",
                headers: {
                    "X-Trace": "one",
                    "x-trace": "two",
                },
            }),
        TypeError,
    );
    assertThrows(
        () =>
            validateNewApiPresetConfig({
                baseUrl: "https://newapi.example",
                headers: { "x-trace": "ok\r\nX-Leak: yes" },
            }),
        TypeError,
    );
    assertThrows(
        () =>
            validateNewApiPresetConfig({
                baseUrl: "https://newapi.example",
                endpoint: "/v1/../admin",
            }),
        TypeError,
    );
});

Deno.test("NewAPI preset redaction never exposes the API key", () => {
    const application = newApiPreset.apply({
        baseUrl: "https://newapi.example/v1/",
        apiKey: "newapi-super-secret",
        headers: { "x-channel": "primary" },
    });
    const safe = newApiPreset.redact!(application);
    assertEquals(safe, {
        id: "newapi",
        baseUrl: "https://newapi.example/v1",
        endpoint: "/chat/completions",
        headers: { "x-channel": "primary" },
        apiKeyConfigured: true,
    });
    assertEquals(JSON.stringify(safe).includes("newapi-super-secret"), false);
    assertEquals(
        redactNewApiPresetApplication(application),
        safe,
    );
});
