import { assertEquals } from "@std/assert";
import { createServerApp } from "@heimdall/core/http/app.ts";
import type { UpdateSourceInput } from "@heimdall/admin-contracts";

Deno.test("source lifecycle authenticates both aliases before invoking or parsing management mutations", async () => {
    let calls = 0;
    const app = createServerApp({
        adminAuthToken: "operator-key",
        adminManagement: {
            updateSource: () => {
                calls++;
                return { data: {} };
            },
            deleteSource: () => {
                calls++;
                return { data: {} };
            },
        },
    });
    for (const prefix of ["/admin", "/api/admin"]) {
        for (const method of ["PATCH", "DELETE"]) {
            for (const authorization of [undefined, "Bearer wrong-key"]) {
                const response = await app.request(
                    `${prefix}/sources?id=channel`,
                    {
                        method,
                        headers: authorization ? { authorization } : {},
                        body: "{invalid private-key",
                    },
                );
                assertEquals(response.status, 401);
                assertEquals(
                    (await response.json()).error.code,
                    "unauthorized",
                );
            }
        }
    }
    assertEquals(calls, 0);
});

Deno.test("source PATCH validates only host metadata and returns versioned DTOs without forwarding other fields", async () => {
    const calls: { id: string; patch: UpdateSourceInput; version?: string }[] =
        [];
    const app = createServerApp({
        adminManagement: {
            updateSource: (_context, id, patch, version) => {
                calls.push({ id, patch, version });
                return {
                    data: { source: { id, ...patch } },
                    versionstamp: "v2",
                };
            },
        },
    });
    for (
        const body of [
            {},
            { name: " " },
            { name: "n".repeat(121) },
            { priority: 0.5 },
            { priority: "1" },
            { priority: Number.MAX_SAFE_INTEGER + 1 },
            { enabled: null },
            { enabled: "false" },
            { config: { apiKey: "private-key" } },
            { name: "valid", sourcePluginId: "other-plugin" },
        ]
    ) {
        const response = await app.request("/api/admin/sources?id=channel", {
            method: "PATCH",
            body: JSON.stringify(body),
        });
        assertEquals(response.status, 400);
        const result = await response.json();
        assertEquals(result.error.code, "invalid_request");
        assertEquals(JSON.stringify(result).includes("private-key"), false);
    }
    assertEquals(calls, []);
    for (const prefix of ["/admin", "/api/admin"]) {
        const response = await app.request(`${prefix}/sources?id=channel`, {
            method: "PATCH",
            headers: { "if-match": '"v1"' },
            body: JSON.stringify({
                name: "  调整名称  ",
                priority: -1,
                enabled: false,
            }),
        });
        assertEquals(response.status, 200);
        assertEquals(response.headers.get("etag"), "v2");
        assertEquals(await response.json(), {
            source: {
                id: "channel",
                name: "调整名称",
                priority: -1,
                enabled: false,
            },
        });
    }
    assertEquals(
        calls,
        [0, 1].map(() => ({
            id: "channel",
            patch: { name: "调整名称", priority: -1, enabled: false },
            version: "v1",
        })),
    );
});

Deno.test("source DELETE requires identity and forwards If-Match on both aliases", async () => {
    const calls: { id: string; version?: string }[] = [];
    const app = createServerApp({
        adminManagement: {
            deleteSource: (_context, id, version) => {
                calls.push({ id, version });
                return { data: { sourceId: id, deleted: true } };
            },
        },
    });
    const invalid = await app.request("/admin/sources", { method: "DELETE" });
    assertEquals(invalid.status, 400);
    await invalid.body?.cancel();
    for (const prefix of ["/admin", "/api/admin"]) {
        const response = await app.request(`${prefix}/sources?id=channel`, {
            method: "DELETE",
            headers: { "if-match": "v1" },
        });
        assertEquals(response.status, 200);
        assertEquals(await response.json(), {
            sourceId: "channel",
            deleted: true,
        });
    }
    assertEquals(calls, [{ id: "channel", version: "v1" }, {
        id: "channel",
        version: "v1",
    }]);
});
