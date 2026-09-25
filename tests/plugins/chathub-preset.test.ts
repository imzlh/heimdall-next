import { assertEquals, assertThrows } from "@std/assert";
import {
    CHATHUB_PRESET_ID,
    CHATHUB_SOURCE_PLUGIN_ID,
    chatHubPreset,
    chatHubPresetManifest,
    redactChatHubPresetApplication,
    validateChatHubPresetConfig,
} from "../../plugins/chathub-preset/mod.ts";
import {
    DEFAULT_ENDPOINT,
    DEFAULT_MODELS,
    validateChatHubSourceConfig,
} from "../../plugins/chathub-source/config.ts";

const credentials = {
    id: "3b02c87a-932c-41dd-adfd-1c8940632b92",
    oid: "user-id",
    tid: "tenant-id",
    accessToken: "provider-access-secret",
};

Deno.test("ChatHub preset declares its source and authorization dependencies", () => {
    assertEquals(chatHubPresetManifest.id, CHATHUB_PRESET_ID);
    assertEquals(chatHubPresetManifest.kind, "preset");
    assertEquals(chatHubPreset.sourcePluginId, CHATHUB_SOURCE_PLUGIN_ID);
    assertEquals(chatHubPresetManifest.dependencies, [
        CHATHUB_SOURCE_PLUGIN_ID,
        "heimdall.api.chathub-auth",
    ]);
    assertEquals(chatHubPresetManifest.permissions, {
        network: false,
        filesystem: "none",
        subprocess: false,
    });
    assertEquals(chatHubPresetManifest.presetPage, {
        modulePath: "/admin/assets/plugins/chathub-setup.js",
    });
    assertEquals(chatHubPresetManifest.configSchema, undefined);
});

Deno.test("ChatHub preset preserves the host source ID and uses provider defaults", () => {
    const application = chatHubPreset.apply(credentials);
    assertEquals(application, {
        sourcePluginId: CHATHUB_SOURCE_PLUGIN_ID,
        config: {
            ...credentials,
            endpoint: DEFAULT_ENDPOINT,
            models: DEFAULT_MODELS,
        },
    });
    assertEquals<unknown>(
        validateChatHubSourceConfig(application.config),
        application.config,
    );
    for (const id of [undefined, null, 42, "", "  ", "x".repeat(257)]) {
        assertThrows(
            () => chatHubPreset.apply({ ...credentials, id }),
            TypeError,
        );
    }
    const { id: _id, ...withoutId } = credentials;
    assertThrows(() => chatHubPreset.apply(withoutId), TypeError);
});

Deno.test("ChatHub preset accepts explicit models and source options without mutating input", () => {
    const models = [" model-a ", "model-b", "model-a"];
    const input = {
        ...credentials,
        models,
        endpoint: "wss://chathub.example/session",
        refreshToken: "provider-refresh-secret",
        accountEmail: " user@example.com ",
        expiresAt: "2027-01-01T00:00:00.000Z",
        locale: "zh-cn",
        timezone: "Asia/Shanghai",
        scenario: "test",
        licenseType: "enterprise",
    };
    const normalized = validateChatHubPresetConfig(input);
    assertEquals(normalized, {
        ...input,
        models: ["model-a", "model-b"],
        accountEmail: "user@example.com",
    });
    assertEquals(models, [" model-a ", "model-b", "model-a"]);
    assertEquals(
        validateChatHubPresetConfig({ ...credentials, models: "one, two one" })
            .models,
        ["one", "two"],
    );
});

Deno.test("ChatHub preset redaction never returns access or refresh tokens", () => {
    const application = chatHubPreset.apply({
        ...credentials,
        refreshToken: "provider-refresh-secret",
    });
    const safe = chatHubPreset.redact!(application);
    assertEquals(safe, {
        id: credentials.id,
        oid: credentials.oid,
        tid: credentials.tid,
        endpoint: DEFAULT_ENDPOINT,
        models: DEFAULT_MODELS.join(","),
        accessTokenConfigured: true,
        refreshTokenConfigured: true,
    });
    assertEquals(
        JSON.stringify(safe).includes("provider-access-secret"),
        false,
    );
    assertEquals(
        JSON.stringify(safe).includes("provider-refresh-secret"),
        false,
    );
    assertEquals(redactChatHubPresetApplication(application), safe);
    assertThrows(
        () =>
            redactChatHubPresetApplication({
                ...application,
                sourcePluginId: "heimdall.source.other",
            }),
        TypeError,
    );
    assertThrows(
        () =>
            redactChatHubPresetApplication({
                sourcePluginId: CHATHUB_SOURCE_PLUGIN_ID,
                config: { ...credentials, unexpectedSecret: "must-not-leak" },
            }),
        TypeError,
    );
});

Deno.test("ChatHub preset rejects invalid credentials and source configuration", () => {
    for (
        const invalid of [
            null,
            [],
            "config",
            { ...credentials, oid: "" },
            { ...credentials, tid: null },
            { ...credentials, accessToken: " " },
            { ...credentials, accessToken: 123 },
            { ...credentials, refreshToken: "enc:v1:unusable" },
            { ...credentials, expiresAt: "not-a-date" },
            { ...credentials, endpoint: "ws://remote.example/session" },
            { ...credentials, endpoint: "wss://user:password@example.com/" },
            { ...credentials, endpoint: "wss://example.com/?token=secret" },
            { ...credentials, models: [] },
            { ...credentials, models: ["good", 42] },
            { ...credentials, models: ["good", " "] },
            { ...credentials, unknown: true },
            { ...credentials, sourcePluginId: CHATHUB_SOURCE_PLUGIN_ID },
        ]
    ) {
        assertThrows(() => chatHubPreset.apply(invalid), TypeError);
    }
});

Deno.test("ChatHub preset rejects unsafe properties without invoking getters", () => {
    let getterCalls = 0;
    const accessor = {
        ...credentials,
        get refreshToken() {
            getterCalls++;
            return "unsafe-token";
        },
    };
    const arrayAccessor = ["good"];
    Object.defineProperty(arrayAccessor, "0", {
        enumerable: true,
        get() {
            getterCalls++;
            return "unsafe-model";
        },
    });
    for (
        const invalid of [
            Object.assign(Object.create({ injected: true }), credentials),
            { ...credentials, ...JSON.parse('{"__proto__":"unsafe"}') },
            { ...credentials, constructor: "unsafe" },
            { ...credentials, [Symbol("secret")]: "unsafe" },
            Object.defineProperty({ ...credentials }, "refreshToken", {
                value: "hidden-secret",
            }),
            accessor,
            { ...credentials, models: arrayAccessor },
            { ...credentials, models: ["good", , "bad"] },
        ]
    ) {
        assertThrows(() => chatHubPreset.apply(invalid), TypeError);
    }
    assertEquals(getterCalls, 0);
    assertEquals(
        validateChatHubPresetConfig(
            Object.assign(Object.create(null), credentials),
        )
            .id,
        credentials.id,
    );
});
