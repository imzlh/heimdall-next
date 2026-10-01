import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createAdminWebRoutes } from "@heimdall/core/http/admin-web.tsx";

function fixture() {
    const reads: URL[] = [];
    const app = createAdminWebRoutes({
        dispatch(request) {
            const url = new URL(request.url);
            reads.push(url);
            if (url.pathname === "/api/admin/system-logs") {
                return Response.json({
                    entries: [{
                        seq: 1,
                        time: "2026-09-28T10:00:00Z",
                        level: "info",
                        scope: "startup",
                        message: "服务启动完成",
                    }],
                    nextAfterSeq: 1,
                    dropped: 0,
                    capacity: 100,
                });
            }
            if (url.pathname === "/api/admin/requests") {
                return Response.json({
                    requests: [{
                        requestId: "request-private-body",
                        receivedAt: "2026-09-28T10:00:00Z",
                        status: "completed",
                        model: "fixture-model",
                    }],
                    nextCursor: null,
                });
            }
            return Response.json({});
        },
    });
    return { app, reads };
}

Deno.test("the log page contains only system events and never reads request history", async () => {
    const { app, reads } = fixture();
    // A stale or hand-written query must not turn logs into request history.
    const response = await app.request(
        "/admin?view=logs&log=requests&id=private",
    );
    const html = await response.text();
    assertEquals(response.status, 200);
    assertStringIncludes(html, "服务启动完成");
    assert(!html.includes("request-private-body"));
    assert(!html.includes("journal-search"));
    assert(!html.includes("log-nav-link"));
    assert(!reads.some((url) => url.pathname === "/api/admin/requests"));
    assert(reads.some((url) => url.pathname === "/api/admin/system-logs"));
});

Deno.test("request history has its own overview entry and preserves SSR filters", async () => {
    const { app, reads } = fixture();
    const overview = await (await app.request("/admin")).text();
    assertStringIncludes(overview, 'href="/admin?view=requests"');
    assertStringIncludes(
        overview,
        'href="/admin?view=requests&amp;id=request-private-body"',
    );
    reads.length = 0;
    const response = await app.request(
        "/admin?view=requests&q=model&status=error",
    );
    const html = await response.text();
    assertStringIncludes(html, "request-private-body");
    assertStringIncludes(html, 'name="view" value="requests"');
    assert(!html.includes("服务启动完成"));
    assert(!reads.some((url) => url.pathname === "/api/admin/system-logs"));
    const queries = reads.filter((url) =>
        url.pathname === "/api/admin/requests"
    );
    assertEquals(queries.length, 1);
    assertEquals(queries[0]!.searchParams.get("q"), "model");
    assertEquals(queries[0]!.searchParams.get("status"), "error");
    const logLink = [...html.matchAll(/<a\b[^>]+>/g)].map((match) => match[0])
        .find((tag) => tag.includes('href="/admin?view=logs"'));
    assert(logLink);
    assert(!logLink.includes('aria-current="page"'));
});

Deno.test("non-overview pages skip activity statistics without bootstrapping false load errors", async () => {
    for (const view of ["channels", "settings", "logs", "requests"]) {
        const { app, reads } = fixture();
        const html = await (await app.request(`/admin?view=${view}`)).text();
        assert(
            !reads.some((url) =>
                url.pathname.startsWith("/api/admin/stats") ||
                url.pathname === "/api/admin/usage"
            ),
        );
        if (view !== "requests") {
            assert(
                !reads.some((url) => url.pathname === "/api/admin/requests"),
            );
        }
        const bootText = html.match(
            /<script id="heimdall-boot" type="application\/json">([^<]+)<\/script>/,
        )?.[1];
        assert(bootText);
        const boot = JSON.parse(bootText);
        assertEquals(boot.initialPanels.stats, {
            overview: null,
            series: null,
            errors: { overview: "", series: "" },
        });
    }
});
