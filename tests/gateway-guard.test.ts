import { assertEquals } from "@std/assert";
import { createServer } from "../main.ts";

Deno.test("public gateway requires the proxy key and limits one peer", async () => {
    let now = Date.parse("2026-09-22T00:00:00.000Z");
    const app = createServer({
        gateway: {
            proxyKey: "proxy-secret",
            limitPerMinute: 2,
            now: () => now,
        },
    });
    const missing = await app.request("http://localhost/v1/models", {
        headers: { authorization: "Bearer wrong" },
    });
    assertEquals(missing.status, 401);

    const headers = { authorization: "Bearer proxy-secret" };
    assertEquals(
        (await app.request("http://localhost/v1/models", { headers })).status,
        200,
    );
    assertEquals(
        (await app.request("http://localhost/v1/models", { headers })).status,
        200,
    );
    const limited = await app.request("http://localhost/v1/models", {
        headers,
    });
    assertEquals(limited.status, 429);
    assertEquals((await limited.json()).error.code, "rate_limited");

    now += 60_000;
    const apiKey = await app.request("http://localhost/v1/models", {
        headers: { "x-api-key": "proxy-secret" },
    });
    assertEquals(apiKey.status, 200);

    const health = await app.request("http://localhost/health");
    assertEquals(health.status, 200);
});
