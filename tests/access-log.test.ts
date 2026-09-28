import { assertEquals, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/deno";
import { createAccessLog } from "@heimdall/core/http/access-log.ts";

Deno.test("access log prints one compact line per request: time status method path latency ip", async () => {
    const lines: string[] = [];
    const app = new Hono();
    app.use(
        "*",
        createAccessLog({
            log: (line) => lines.push(line),
            color: false,
            now: () => new Date(2026, 8, 27, 8, 5, 9),
        }),
    );
    app.get("/v1/models", (context) => context.json({ ok: true }));

    await app.request(
        "http://localhost/v1/models",
        {},
        { remoteAddr: { hostname: "10.0.0.7" } } as never,
    );
    await app.request("http://localhost/chat/completions", { method: "POST" });

    assertEquals(lines.length, 2);
    // Fields run time → status → method → path → latency → ip.
    assertEquals(lines[0]!.startsWith("08:05:09 200 GET"), true);
    assertStringIncludes(lines[0]!, "/v1/models");
    assertStringIncludes(lines[0]!, "10.0.0.7");
    // A path with no route is still logged with its 404 status.
    assertStringIncludes(lines[1]!, "404");
    assertStringIncludes(lines[1]!, "POST");
    assertStringIncludes(lines[1]!, "/chat/completions");
});

Deno.test("access log shows a proxy target in place of the opaque bridge path", async () => {
    const lines: string[] = [];
    const app = new Hono<{ Variables: { accessLogTarget?: string } }>();
    app.use(
        "*",
        createAccessLog({
            log: (line) => lines.push(line),
            color: false,
            now: () => new Date(2026, 8, 27, 8, 5, 9),
        }),
    );
    // A bridge-style endpoint names the management target it dispatched.
    app.post("/admin/ui/request", (context) => {
        context.set("accessLogTarget", "GET /api/admin/system-logs");
        return context.json({ ok: true });
    });

    await app.request("http://localhost/admin/ui/request", { method: "POST" });

    assertEquals(lines.length, 1);
    assertStringIncludes(lines[0]!, "PROXY");
    assertStringIncludes(lines[0]!, "→ GET /api/admin/system-logs");
    // The opaque bridge method and path are replaced, not appended.
    assertEquals(lines[0]!.includes("/admin/ui/request"), false);
    assertEquals(lines[0]!.includes("POST"), false);
});

Deno.test("access log omits ANSI codes when color is disabled", async () => {
    const lines: string[] = [];
    const app = new Hono();
    app.use(
        "*",
        createAccessLog({ log: (line) => lines.push(line), color: false }),
    );
    app.get("/", (context) => context.text("ok"));
    await app.request("http://localhost/");
    assertEquals(lines[0]!.includes("\x1b["), false);
});

Deno.test("access log lets a WebSocket upgrade complete instead of discarding it", async () => {
    // Regression: wrapping the native upgrade response in the log's
    // try/next()/finally crashed the handshake with Deno's
    // "Upgrade response was not returned from callback".
    const lines: string[] = [];
    const app = new Hono();
    app.use(
        "*",
        createAccessLog({ log: (line) => lines.push(line), color: false }),
    );
    app.get(
        "/socket",
        upgradeWebSocket(() => ({
            onOpen: (_event, socket) => socket.close(),
        })),
    );
    const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        app.fetch,
    );
    try {
        const socket = new WebSocket(
            `ws://127.0.0.1:${server.addr.port}/socket`,
        );
        const result = await new Promise<string>((resolve) => {
            socket.addEventListener("open", () => resolve("open"));
            socket.addEventListener("error", () => resolve("error"));
            setTimeout(() => resolve("timeout"), 4000);
        });
        assertEquals(result, "open");
        socket.close();
        assertEquals(lines.some((line) => line.includes("101")), true);
        assertEquals(
            lines.some((line) =>
                line.includes("101") && line.includes("/socket")
            ),
            true,
        );
    } finally {
        await server.shutdown();
    }
});
