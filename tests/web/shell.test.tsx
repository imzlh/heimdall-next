import { assertMatch, assertStringIncludes } from "@std/assert";
import { AdminShell } from "@heimdall/core/web/components/shell.tsx";

Deno.test("AdminShell renders SSR HTML with nav and active state", () => {
    const html = (
        <AdminShell
            title="Heimdall"
            active="overview"
            nav={[
                { id: "overview", label: "总览", href: "/admin" },
                { id: "channels", label: "渠道", href: "/admin/channels" },
            ]}
        >
            <p>hello world</p>
        </AdminShell>
    ).toString();
    assertStringIncludes(html, "<title>Heimdall</title>");
    assertStringIncludes(html, "总览");
    assertStringIncludes(html, "渠道");
    assertMatch(html, /<a\b[^>]*href="\/admin"[^>]*aria-current="page"/);
    assertStringIncludes(html, "<p>hello world</p>");
});
