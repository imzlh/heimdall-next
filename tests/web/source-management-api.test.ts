import { assertEquals, assertRejects } from "@std/assert";
import type { UpdateSourceInput } from "@heimdall/admin-contracts";
import {
    AdminApiError,
    configureAdminTransport,
    createSource,
    deleteSource,
    probeSourceDraft,
    updateSource,
} from "@heimdall/core/web/client/api/admin.ts";

interface RecordedRequest {
    input: RequestInfo | URL;
    init?: RequestInit;
}

Deno.test("creation and probing send model aliases as host metadata without provider configuration fields", async () => {
    const modelMap = { fast: "provider-fast" };
    const input = {
        id: "draft-model-map",
        name: "模型渠道",
        priority: 1,
        sourcePluginId: "heimdall.source.openai-compatible",
        presetId: "heimdall.preset.newapi",
        modelMap,
        proxy: { mode: "direct" as const },
        config: { baseUrl: "https://provider.example/v1" },
    };
    await withTransport(
        () => Response.json({ probe: { ok: true } }),
        async (requests) => {
            await createSource(input);
            await probeSourceDraft(input);
            for (const request of requests) {
                const body = JSON.parse(String(request.init?.body));
                assertEquals(body.modelMap, modelMap);
                assertEquals(body.config.modelMap, undefined);
                assertEquals(body.proxy, { mode: "direct" });
            }
        },
    );
});

async function withTransport(
    response: () => Response,
    run: (requests: RecordedRequest[]) => Promise<void>,
): Promise<void> {
    const requests: RecordedRequest[] = [];
    configureAdminTransport((input, init) => {
        requests.push({ input, init });
        return Promise.resolve(response());
    });
    try {
        await run(requests);
    } finally {
        configureAdminTransport();
    }
}

Deno.test("source update encodes its ID and preserves metadata, false and versionstamp", async () => {
    const sourceId = "渠道 / primary?region=cn&model=1";
    const changes = { name: "主力渠道", priority: 17, enabled: false };
    const payload = { source: { id: sourceId, ...changes } };
    await withTransport(() => Response.json(payload), async (requests) => {
        assertEquals(
            await updateSource(sourceId, changes, '"revision-3"'),
            payload,
        );
        assertEquals(requests.length, 1);
        const request = requests[0]!;
        assertEquals(
            request.input,
            `/api/admin/sources?id=${encodeURIComponent(sourceId)}`,
        );
        assertEquals(request.init?.method, "PATCH");
        assertEquals(JSON.parse(String(request.init?.body)), changes);
        const headers = new Headers(request.init?.headers);
        assertEquals(headers.get("if-match"), '"revision-3"');
        assertEquals(headers.get("content-type"), "application/json");
    });
});

Deno.test("source partial updates send only supplied fields and omit the default versionstamp", async () => {
    const changes: UpdateSourceInput[] = [
        { name: "新名称" },
        { priority: 0 },
        { enabled: false },
        { proxy: { mode: "direct" as const } },
        { proxy: { mode: "proxy" as const, proxyId: "office" } },
        { modelMap: { fast: "upstream-fast" } },
        { modelMap: {} },
        { middleware: null },
        { middleware: [] },
        { middleware: ["middleware.second", "middleware.first"] },
        { healthPolicy: null },
        { healthPolicy: { cooldownMs: 0, authCooldownMs: 1250 } },
    ];
    await withTransport(
        () => Response.json({ updated: true }),
        async (requests) => {
            for (const change of changes) {
                await updateSource(
                    "source-1",
                    change,
                );
            }
            assertEquals(requests.length, changes.length);
            for (let index = 0; index < changes.length; index++) {
                const request = requests[index]!;
                assertEquals(request.input, "/api/admin/sources?id=source-1");
                assertEquals(request.init?.method, "PATCH");
                assertEquals(
                    JSON.parse(String(request.init?.body)),
                    changes[index],
                );
                assertEquals(
                    new Headers(request.init?.headers).has("if-match"),
                    false,
                );
            }
        },
    );
});

Deno.test("source creation sends ordered middleware separately from preset configuration", async () => {
    await withTransport(
        () => Response.json({ created: true }),
        async (requests) => {
            for (
                const middleware of [undefined, null, [], [
                    "middleware.second",
                    "middleware.first",
                ]]
            ) {
                await createSource({
                    id: "source-with-middleware",
                    name: "渠道",
                    priority: 1,
                    sourcePluginId: "heimdall.source.openai-compatible",
                    presetId: "heimdall.preset.newapi",
                    middleware,
                    config: { baseUrl: "https://provider.example/v1" },
                });
                const body = JSON.parse(String(requests.at(-1)?.init?.body));
                assertEquals(body.middleware, middleware);
                assertEquals(body.config.middleware, undefined);
            }
        },
    );
});

Deno.test("source deletion encodes its ID and sends the versionstamp without a body", async () => {
    const sourceId = "来源 / test?next=1&enabled=false";
    const payload = { deleted: true, id: sourceId };
    await withTransport(() => Response.json(payload), async (requests) => {
        assertEquals(await deleteSource(sourceId, '"revision-4"'), payload);
        assertEquals(requests.length, 1);
        const request = requests[0]!;
        assertEquals(
            request.input,
            `/api/admin/sources?id=${encodeURIComponent(sourceId)}`,
        );
        assertEquals(request.init?.method, "DELETE");
        assertEquals(request.init?.body, undefined);
        assertEquals(
            new Headers(request.init?.headers).get("if-match"),
            '"revision-4"',
        );
    });
});

Deno.test("source deletion omits If-Match when no versionstamp is supplied", async () => {
    await withTransport(
        () => Response.json({ deleted: true }),
        async (requests) => {
            await deleteSource("source-1");
            assertEquals(requests.length, 1);
            assertEquals(requests[0]!.input, "/api/admin/sources?id=source-1");
            assertEquals(requests[0]!.init?.method, "DELETE");
            assertEquals(
                new Headers(requests[0]!.init?.headers).has("if-match"),
                false,
            );
            assertEquals(requests[0]!.init?.body, undefined);
        },
    );
});

Deno.test("source update and deletion retain API conflict diagnostics", async () => {
    const payload = {
        error: { code: "version_conflict", message: "渠道已被其他操作更新" },
    };
    for (const operation of ["update", "delete"] as const) {
        const requestId = `request-source-${operation}`;
        await withTransport(
            () =>
                Response.json(payload, {
                    status: 409,
                    headers: { "x-heimdall-request-id": requestId },
                }),
            async (requests) => {
                const error = await assertRejects(
                    () =>
                        operation === "update"
                            ? updateSource(
                                "source-1",
                                { enabled: false },
                                '"stale"',
                            )
                            : deleteSource("source-1", '"stale"'),
                    AdminApiError,
                    payload.error.message,
                );
                assertEquals(requests.length, 1);
                assertEquals(error.status, 409);
                assertEquals(error.code, "version_conflict");
                assertEquals(error.requestId, requestId);
                assertEquals(error.details, payload);
            },
        );
    }
});

Deno.test("draft probe API sends the unsaved preset and proxy choice with request cancellation", async () => {
    const probe = {
        ok: true,
        message: "连接正常",
        checkedAt: "2026-09-28T00:00:00.000Z",
        models: ["model-a"],
    };
    await withTransport(() => Response.json({ probe }), async (requests) => {
        const controller = new AbortController();
        const input = {
            id: "e3ea7f49-9726-41a4-97c2-c6f00f51bb75",
            name: "主渠道",
            priority: 4,
            sourcePluginId: "heimdall.source.openai-compatible",
            presetId: "heimdall.preset.newapi",
            proxy: { mode: "direct" as const },
            config: { apiKey: "draft-secret" },
        };
        assertEquals(await probeSourceDraft(input, controller.signal), probe);
        assertEquals(requests.length, 1);
        assertEquals(requests[0]?.input, "/api/admin/source-draft-probe");
        assertEquals(requests[0]?.init?.method, "POST");
        assertEquals(requests[0]?.init?.signal, controller.signal);
        assertEquals(JSON.parse(String(requests[0]?.init?.body)), input);
    });
});
