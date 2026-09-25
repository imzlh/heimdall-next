import { assertEquals } from "@std/assert";
import type { CreateSourceInput, SourceDto } from "@heimdall/admin-contracts";
import { createServerApp } from "@heimdall/core/http/app.ts";

const adminToken = "source-create-operator-token";
const prefixes = ["/admin", "/api/admin"] as const;
const input: CreateSourceInput = {
    id: "e3ea7f49-9726-41a4-97c2-c6f00f51bb75",
    name: "主渠道",
    priority: 9,
    sourcePluginId: "heimdall.source.openai-compatible",
    presetId: "heimdall.preset.newapi",
    config: {
        baseUrl: "https://provider.example/v1",
        apiKey: "private-source-key",
    },
};

function sourceDto(value: CreateSourceInput): SourceDto {
    return {
        id: value.id,
        name: value.name,
        priority: value.priority,
        sourcePluginId: value.sourcePluginId,
        enabled: true,
        models: ["model-a"],
        capabilities: ["generation.create"],
    };
}

function request(body: unknown, headers?: HeadersInit): RequestInit {
    const result = new Headers(headers);
    result.set("content-type", "application/json");
    return { method: "POST", headers: result, body: JSON.stringify(body) };
}

Deno.test("source creation supports both authenticated aliases and returns a 201 DTO with ETag", async () => {
    const received: { input: CreateSourceInput; requestId: string }[] = [];
    const app = createServerApp({
        adminAuthToken: adminToken,
        adminManagement: {
            createSource: (context, value) => {
                received.push({ input: value, requestId: context.requestId });
                return {
                    data: { source: sourceDto(value) },
                    versionstamp: "created-v1",
                };
            },
        },
    });
    for (const prefix of prefixes) {
        const response = await app.request(
            `http://localhost${prefix}/sources`,
            request({
                ...input,
                name: `  ${input.name}  `,
                sourcePluginId: ` ${input.sourcePluginId} `,
                presetId: ` ${input.presetId} `,
                enabled: false,
                ignored: { internalState: "must not enter the callback" },
            }, {
                authorization: `Bearer ${adminToken}`,
                "x-request-id": "source-create-request",
            }),
        );
        assertEquals(response.status, 201);
        assertEquals(response.headers.get("etag"), "created-v1");
        assertEquals(
            response.headers.get("x-heimdall-request-id"),
            "source-create-request",
        );
        const data = await response.json();
        assertEquals(data, { source: sourceDto(input) });
        assertEquals(
            JSON.stringify(data).includes("private-source-key"),
            false,
        );
    }
    assertEquals(
        received,
        prefixes.map(() => ({
            input,
            requestId: "source-create-request",
        })),
    );
});

Deno.test("source creation authenticates before reading or dispatching malformed input", async () => {
    let calls = 0;
    const app = createServerApp({
        adminAuthToken: adminToken,
        adminManagement: {
            createSource: () => {
                calls++;
                return { data: {} };
            },
        },
    });
    for (const prefix of prefixes) {
        for (const authorization of [undefined, "Bearer wrong"]) {
            const response = await app.request(
                `http://localhost${prefix}/sources`,
                {
                    method: "POST",
                    headers: authorization === undefined
                        ? {}
                        : { authorization },
                    body: "{ malformed private-source-key",
                },
            );
            assertEquals(response.status, 401);
            assertEquals((await response.json()).error.code, "unauthorized");
        }
    }
    assertEquals(calls, 0);
});

Deno.test("source creation validates identifiers, basic fields, and object configuration before dispatch", async () => {
    let calls = 0;
    const app = createServerApp({
        adminManagement: {
            createSource: () => {
                calls++;
                return { data: {} };
            },
        },
    });
    const invalid: unknown[] = [
        null,
        [],
        "text",
        {},
        { ...input, id: undefined },
        { ...input, id: "arbitrary-source-id" },
        { ...input, id: ` ${input.id}` },
        { ...input, id: "e3ea7f49-9726-51a4-97c2-c6f00f51bb75" },
        { ...input, id: "e3ea7f49-9726-41a4-77c2-c6f00f51bb75" },
        { ...input, name: undefined },
        { ...input, name: 3 },
        { ...input, name: " \t\n " },
        { ...input, name: "x".repeat(121) },
        { ...input, priority: undefined },
        { ...input, priority: "9" },
        { ...input, priority: 0.5 },
        { ...input, priority: Number.MAX_SAFE_INTEGER + 1 },
        { ...input, priority: Number.MIN_SAFE_INTEGER - 1 },
        { ...input, priority: NaN },
        { ...input, priority: Infinity },
        { ...input, sourcePluginId: undefined },
        { ...input, sourcePluginId: " " },
        { ...input, sourcePluginId: "x".repeat(129) },
        { ...input, sourcePluginId: [] },
        { ...input, presetId: null },
        { ...input, presetId: " " },
        { ...input, presetId: "x".repeat(129) },
        { ...input, presetId: 1 },
        { ...input, config: undefined },
        { ...input, config: null },
        { ...input, config: [] },
        { ...input, config: "private-source-key" },
    ];
    for (const body of invalid) {
        const response = await app.request(
            "http://localhost/api/admin/sources",
            request(body),
        );
        assertEquals(response.status, 400);
        const data = await response.json();
        assertEquals(data.error.code, "invalid_request");
        assertEquals(
            JSON.stringify(data).includes("private-source-key"),
            false,
        );
    }
    assertEquals(calls, 0);
});

Deno.test("source creation accepts custom setup and basic field boundaries", async () => {
    const received: CreateSourceInput[] = [];
    const app = createServerApp({
        adminManagement: {
            createSource: (_context, value) => {
                received.push(value);
                return { data: { source: sourceDto(value) } };
            },
        },
    });
    for (
        const priority of [Number.MIN_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER]
    ) {
        const value = {
            id: input.id,
            name: "n".repeat(120),
            priority,
            sourcePluginId: "s".repeat(128),
            config: {},
        };
        const response = await app.request(
            "http://localhost/admin/sources",
            request(value),
        );
        assertEquals(response.status, 201);
        assertEquals(response.headers.get("etag"), null);
        assertEquals(received.at(-1), value);
        assertEquals(Object.hasOwn(received.at(-1)!, "presetId"), false);
    }
    const preset = { ...input, presetId: "p".repeat(128) };
    const response = await app.request(
        "http://localhost/admin/sources",
        request(preset),
    );
    assertEquals(response.status, 201);
    assertEquals(received.at(-1), preset);
});

Deno.test("source creation rejects malformed and oversized JSON through the management boundary", async () => {
    let calls = 0;
    const app = createServerApp({
        adminManagement: {
            createSource: () => {
                calls++;
                return { data: {} };
            },
        },
    });
    const malformed = await app.request("http://localhost/admin/sources", {
        method: "POST",
        body: "{",
    });
    assertEquals(malformed.status, 400);
    assertEquals((await malformed.json()).error.code, "invalid_json");
    const oversized = await app.request(
        "http://localhost/api/admin/sources",
        request({
            ...input,
            config: { large: "x".repeat(1_048_576) },
        }),
    );
    assertEquals(oversized.status, 413);
    assertEquals((await oversized.json()).error.code, "payload_too_large");
    assertEquals(calls, 0);
});

Deno.test("source creation reports missing capability and preserves typed duplicate conflicts", async () => {
    const unsupported = createServerApp();
    for (const prefix of prefixes) {
        const response = await unsupported.request(
            `http://localhost${prefix}/sources`,
            request(input),
        );
        assertEquals(response.status, 501);
        assertEquals(
            (await response.json()).error.code,
            "management_unavailable",
        );
    }

    const created = new Set<string>();
    const app = createServerApp({
        adminManagement: {
            createSource: (_context, value) => {
                if (created.has(value.id)) {
                    throw Object.assign(new Error("source already exists"), {
                        name: "ManagementError",
                        status: 409,
                        code: "source_exists",
                    });
                }
                created.add(value.id);
                return { data: { source: sourceDto(value) } };
            },
        },
    });
    const first = await app.request(
        "http://localhost/admin/sources",
        request(input),
    );
    assertEquals(first.status, 201);
    const duplicate = await app.request(
        "http://localhost/api/admin/sources",
        request(input, {
            "x-request-id": "duplicate-source-request",
        }),
    );
    assertEquals(duplicate.status, 409);
    assertEquals(await duplicate.json(), {
        error: {
            code: "source_exists",
            message: "source already exists",
            request_id: "duplicate-source-request",
        },
    });
    assertEquals(created.size, 1);
});
