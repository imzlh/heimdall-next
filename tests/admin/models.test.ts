import { assertEquals } from "@std/assert";
import { createServer } from "../../main.ts";

Deno.test("admin model catalog uses the admin token and stays outside the proxy quota", async () => {
    let model = "first-model";
    const app = createServer({
        adminAuthToken: "operator-token",
        models: () => ({ object: "list", data: [{ id: model }] }),
        gateway: {
            proxyKey: "inference-token",
            limitPerMinute: 1,
            now: () => Date.parse("2026-09-23T11:00:00Z"),
        },
    });
    const operator = { authorization: "Bearer operator-token" };
    const inference = { authorization: "Bearer inference-token" };
    for (const prefix of ["/admin", "/api/admin"]) {
        assertEquals((await app.request(`${prefix}/models`)).status, 401);
        assertEquals(
            (await app.request(`${prefix}/models`, { headers: inference }))
                .status,
            401,
        );
        const response = await app.request(`${prefix}/models`, {
            headers: operator,
        });
        assertEquals(response.status, 200);
        assertEquals(await response.json(), {
            object: "list",
            data: [{ id: model }],
        });
    }
    model = "updated-model";
    const refreshed = await app.request("/admin/models", { headers: operator });
    assertEquals(await refreshed.json(), {
        object: "list",
        data: [{ id: "updated-model" }],
    });
    assertEquals(
        (await app.request("/v1/models", { headers: operator })).status,
        401,
    );
    assertEquals(
        (await app.request("/v1/models", { headers: inference })).status,
        200,
    );
    assertEquals(
        (await app.request("/v1/models", { headers: inference })).status,
        429,
        "only inference requests consume the proxy quota",
    );
});
