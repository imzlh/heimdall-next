import { assertEquals } from "@std/assert";
import { createAdminAssetRoutes } from "@heimdall/core/http/admin-assets.ts";

Deno.test("Hono serves only self-hosted browser build outputs", async () => {
    const root = await Deno.makeTempDir({ prefix: "heimdall-web-assets-" });
    try {
        await Deno.writeTextFile(
            `${root}/console.js`,
            "export const ready = true;",
        );
        await Deno.writeTextFile(
            `${root}/console.css`,
            "body { color: black; }",
        );
        await Deno.writeTextFile(`${root}/private.json`, "secret");
        await Deno.writeTextFile(`${root}/source-setup.js`, "retired");
        await Deno.writeTextFile(`${root}/source-setup.css`, "retired");
        await Deno.writeTextFile(
            `${root}/chat.js`,
            "export const chat = true;",
        );
        await Deno.writeTextFile(
            `${root}/chat.css`,
            ".chat-app { display: grid; }",
        );
        const app = createAdminAssetRoutes(root);
        const script = await app.request("/admin/assets/console.js");
        assertEquals(script.status, 200);
        assertEquals(
            script.headers.get("content-type"),
            "text/javascript; charset=utf-8",
        );
        assertEquals(script.headers.get("cache-control"), "no-cache");
        assertEquals(await script.text(), "export const ready = true;");
        assertEquals(
            (await app.request("/admin/assets/console.css")).status,
            200,
        );
        assertEquals((await app.request("/admin/assets/chat.js")).status, 200);
        assertEquals((await app.request("/admin/assets/chat.css")).status, 200);
        for (const name of ["source-setup.js", "source-setup.css"]) {
            assertEquals(
                (await app.request(`/admin/assets/${name}`)).status,
                404,
            );
        }
        assertEquals(
            (await app.request("/admin/assets/private.json")).status,
            404,
        );
        assertEquals((await app.request("/index.html")).status, 404);
        assertEquals(
            app.routes.some((route) => route.path.includes("*")),
            false,
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("plugin assets serve only the exact host-allowlisted JS and HTML files", async () => {
    const root = await Deno.makeTempDir({ prefix: "heimdall-plugin-assets-" });
    try {
        await Deno.mkdir(`${root}/plugins/demo/nested`, { recursive: true });
        const modulePath = "/admin/assets/plugins/demo/widget.js";
        const documentPath = "/admin/assets/plugins/demo/nested/panel.html";
        const module = "export function mount() {}";
        const document = "<!doctype html><p>Sandbox panel</p>";
        await Deno.writeTextFile(`${root}/plugins/demo/widget.js`, module);
        await Deno.writeTextFile(
            `${root}/plugins/demo/nested/panel.html`,
            document,
        );
        for (
            const name of [
                "widget.js.map",
                "private.js",
                "private.html",
                "manifest.json",
                "nested/private.js",
            ]
        ) {
            await Deno.writeTextFile(`${root}/plugins/demo/${name}`, "private");
        }
        const app = createAdminAssetRoutes(root, {
            trustedModules: { "demo:widget": modulePath },
            sandboxDocuments: { "demo:panel": documentPath },
            allowedActions: { "demo:widget": ["refresh"] },
        });
        const script = await app.request(modulePath);
        assertEquals(script.status, 200);
        assertEquals(
            script.headers.get("content-type"),
            "text/javascript; charset=utf-8",
        );
        assertEquals(script.headers.get("cache-control"), "no-cache");
        assertEquals(script.headers.get("x-content-type-options"), "nosniff");
        assertEquals(await script.text(), module);

        const page = await app.request(documentPath);
        assertEquals(page.status, 200);
        assertEquals(
            page.headers.get("content-type"),
            "text/html; charset=utf-8",
        );
        assertEquals(page.headers.get("cache-control"), "no-cache");
        assertEquals(page.headers.get("x-content-type-options"), "nosniff");
        assertEquals(
            page.headers.get("content-security-policy")?.split("; ").sort(),
            [
                "default-src 'none'",
                "script-src 'self' 'unsafe-inline'",
                "style-src 'unsafe-inline'",
                "img-src data:",
                "connect-src 'none'",
                "form-action 'none'",
                "base-uri 'none'",
                "frame-ancestors 'self'",
                "sandbox allow-scripts",
            ].sort(),
        );
        assertEquals(await page.text(), document);

        for (
            const name of [
                "widget.js.map",
                "private.js",
                "private.html",
                "manifest.json",
                "nested/private.js",
                "missing.js",
                "widget.js/extra",
                "Widget.js",
            ]
        ) {
            const response = await app.request(
                `/admin/assets/plugins/demo/${name}`,
            );
            assertEquals(response.status, 404, name);
            await response.body?.cancel();
        }
        assertEquals(
            app.routes.map((route) => route.path).sort(),
            [
                "/admin/assets/chat.css",
                "/admin/assets/chat.js",
                "/admin/assets/console.js",
                "/admin/assets/console.css",
                modulePath,
                documentPath,
            ].sort(),
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("plugin assets remain private without an asset allowlist", async () => {
    const root = await Deno.makeTempDir({ prefix: "heimdall-private-assets-" });
    try {
        await Deno.mkdir(`${root}/plugins/demo`, { recursive: true });
        await Deno.writeTextFile(`${root}/plugins/demo/widget.js`, "private");
        await Deno.writeTextFile(`${root}/plugins/demo/panel.html`, "private");
        const app = createAdminAssetRoutes(root, {
            allowedActions: { "demo:widget": ["refresh"] },
        });
        for (const name of ["widget.js", "panel.html"]) {
            const response = await app.request(
                `/admin/assets/plugins/demo/${name}`,
            );
            assertEquals(response.status, 404, name);
            await response.body?.cancel();
        }
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("plugin asset routes reject noncanonical paths and wrong extensions", async () => {
    const root = await Deno.makeTempDir({ prefix: "heimdall-invalid-assets-" });
    try {
        await Deno.mkdir(`${root}/plugins/demo`, { recursive: true });
        await Deno.writeTextFile(`${root}/private.js`, "private");
        await Deno.writeTextFile(`${root}/plugins/demo/widget.js`, "private");
        await Deno.writeTextFile(`${root}/plugins/demo/panel.html`, "private");
        await Deno.writeTextFile(`${root}/plugins/demo/style.css`, "private");
        const invalidModules = [
            "https://external.invalid/widget.js",
            "//external.invalid/widget.js",
            "/admin/assets/private.js",
            "/admin/assets/plugins/../../private.js",
            "/admin/assets/plugins/demo/../widget.js",
            "/admin/assets/plugins/demo/%2e%2e/widget.js",
            "/admin/assets/plugins/demo/%77idget.js",
            "/admin/assets/plugins/demo//widget.js",
            "/admin/assets/plugins/demo\\widget.js",
            "/admin/assets/plugins/demo/widget.js?debug=1",
            "/admin/assets/plugins/demo/widget.js#module",
            "/admin/assets/plugins/demo/panel.html",
            "/admin/assets/plugins/demo/style.css",
            "/admin/assets/plugins/demo/*.js",
        ];
        const app = createAdminAssetRoutes(root, {
            trustedModules: Object.fromEntries(
                invalidModules.map((
                    path,
                    index,
                ) => [`demo:invalid-${index}`, path]),
            ),
            sandboxDocuments: {
                "demo:wrong-extension": "/admin/assets/plugins/demo/widget.js",
            },
        });
        assertEquals(
            app.routes.map((route) => route.path).sort(),
            [
                "/admin/assets/chat.css",
                "/admin/assets/chat.js",
                "/admin/assets/console.css",
                "/admin/assets/console.js",
            ],
        );
        for (
            const path of [
                ...invalidModules.filter((path) => path.startsWith("/admin/")),
                "/admin/assets/plugins/demo/widget.js",
            ]
        ) {
            const response = await app.request(path);
            assertEquals(response.status, 404, path);
            await response.body?.cancel();
        }
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("allowlisted plugin paths cannot escape the asset root through a directory link", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-linked-assets-",
    });
    const root = `${directory}/assets`;
    // A sibling with the same prefix also checks the realpath directory boundary.
    const outside = `${directory}/assets-private`;
    try {
        await Deno.mkdir(`${root}/plugins`, { recursive: true });
        await Deno.mkdir(outside);
        await Deno.writeTextFile(`${outside}/widget.js`, "private module");
        await Deno.writeTextFile(`${outside}/panel.html`, "private document");
        await Deno.symlink(outside, `${root}/plugins/linked`, {
            type: Deno.build.os === "windows" ? "junction" : "dir",
        });
        const app = createAdminAssetRoutes(root, {
            trustedModules: {
                "demo:widget": "/admin/assets/plugins/linked/widget.js",
                "demo:missing": "/admin/assets/plugins/missing.js",
            },
            sandboxDocuments: {
                "demo:panel": "/admin/assets/plugins/linked/panel.html",
            },
        });
        for (
            const path of [
                "/admin/assets/plugins/linked/widget.js",
                "/admin/assets/plugins/linked/panel.html",
                "/admin/assets/plugins/missing.js",
            ]
        ) {
            const response = await app.request(path);
            assertEquals(response.status, 404, path);
            assertEquals(await response.text(), "404 Not Found");
        }
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
});
