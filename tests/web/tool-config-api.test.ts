import { assertEquals, assertRejects } from "@std/assert";
import {
    loadToolConfig,
    saveToolConfig,
} from "@heimdall/core/web/client/api/tool-config.ts";
import {
    AdminApiError,
    configureAdminTransport,
} from "@heimdall/core/web/client/api/transport.ts";
import { PLUGIN_CATALOG_CHANGED } from "@heimdall/core/web/client/plugin-events.ts";

interface RecordedRequest {
    input: RequestInfo | URL;
    init?: RequestInit;
}

const pluginId = "heimdall.tool.workspace";
const config = {
    root: "D:/projects/example",
    readOnly: false,
    ignoredPaths: [".git", "node_modules"],
};
const configSchema = {
    type: "object",
    properties: { root: { type: "string" } },
};

async function withTransport(
    response: () => Response,
    run: (
        requests: RecordedRequest[],
        notifications: { count: number },
    ) => Promise<void>,
): Promise<void> {
    const requests: RecordedRequest[] = [];
    const notifications = { count: 0 };
    const onCatalogChange = () => notifications.count++;
    globalThis.addEventListener(PLUGIN_CATALOG_CHANGED, onCatalogChange);
    configureAdminTransport((input, init) => {
        requests.push({ input, init });
        return Promise.resolve(response());
    });
    try {
        await run(requests, notifications);
    } finally {
        configureAdminTransport();
        globalThis.removeEventListener(PLUGIN_CATALOG_CHANGED, onCatalogChange);
    }
}

Deno.test("tool configuration loading encodes the plugin ID and forwards request cancellation", async () => {
    const requestedPluginId = "workspace / primary?region=cn&project=工具";
    const payload = {
        pluginId: requestedPluginId,
        config,
        configSchema,
        revision: null,
    };
    await withTransport(
        () => Response.json(payload),
        async (requests, notifications) => {
            const controller = new AbortController();
            assertEquals(
                await loadToolConfig(requestedPluginId, controller.signal),
                payload,
            );
            assertEquals(requests.length, 1);
            assertEquals(
                requests[0]?.input,
                `/api/admin/tool-config?pluginId=${
                    encodeURIComponent(requestedPluginId)
                }`,
            );
            assertEquals(requests[0]?.init?.method ?? "GET", "GET");
            assertEquals(requests[0]?.init?.signal, controller.signal);
            assertEquals(requests[0]?.init?.body, undefined);
            assertEquals(notifications.count, 0);
        },
    );
});

Deno.test("tool configuration saves retain create/update revisions and invalidate the plugin catalog", async () => {
    const payload = { pluginId, config, configSchema, revision: "revision-2" };
    await withTransport(
        () => Response.json(payload),
        async (requests, notifications) => {
            for (const revision of [null, "revision-1"]) {
                const previousCount = notifications.count;
                assertEquals(
                    await saveToolConfig(pluginId, config, revision),
                    payload,
                );
                const request = requests.at(-1)!;
                assertEquals(request.input, "/api/admin/tool-config");
                assertEquals(request.init?.method, "PUT");
                assertEquals(JSON.parse(String(request.init?.body)), {
                    pluginId,
                    config,
                    revision,
                });
                assertEquals(
                    new Headers(request.init?.headers).get("content-type"),
                    "application/json",
                );
                assertEquals(notifications.count, previousCount + 1);
            }
            assertEquals(requests.length, 2);
        },
    );
});

Deno.test("tool configuration conflicts preserve API diagnostics without invalidating the catalog", async () => {
    const payload = {
        error: {
            code: "version_conflict",
            message: "Configuration has changed; reload before saving",
        },
    };
    const requestId = "request-tool-config-conflict";
    await withTransport(
        () =>
            Response.json(payload, {
                status: 409,
                headers: { "x-heimdall-request-id": requestId },
            }),
        async (requests, notifications) => {
            const error = await assertRejects(
                () => saveToolConfig(pluginId, config, "stale-revision"),
                AdminApiError,
                payload.error.message,
            );
            assertEquals(error.status, 409);
            assertEquals(error.code, "version_conflict");
            assertEquals(error.requestId, requestId);
            assertEquals(error.details, payload);
            assertEquals(requests.length, 1);
            assertEquals(notifications.count, 0);
        },
    );
});

Deno.test("tool configuration rejects incomplete or mismatched responses before notifying the catalog", async () => {
    const valid = { pluginId, config, configSchema, revision: "revision-1" };
    const invalidPayloads: unknown[] = [
        null,
        [],
        {},
        { ...valid, pluginId: "another.plugin" },
        { ...valid, config: null },
        { ...valid, config: [] },
        { ...valid, configSchema: null },
        { ...valid, configSchema: [] },
        { pluginId, config, configSchema },
        { ...valid, revision: "" },
        { ...valid, revision: 1 },
    ];
    for (const payload of invalidPayloads) {
        await withTransport(
            () => Response.json(payload),
            async (requests, notifications) => {
                for (
                    const operation of [
                        () => loadToolConfig(pluginId),
                        () => saveToolConfig(pluginId, config, "revision-1"),
                    ]
                ) {
                    const error = await assertRejects(operation, AdminApiError);
                    assertEquals(error.code, "invalid_response");
                }
                assertEquals(requests.length, 2);
                assertEquals(notifications.count, 0);
            },
        );
    }
});
