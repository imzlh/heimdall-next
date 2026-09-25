import { Hono } from "hono";
import { serveStatic } from "hono/deno";
import type { ServerApp, ServerEnv } from "./app.ts";
import type { UiPolicy } from "@heimdall/admin-contracts/ui.ts";
import { safeUiAssetPath } from "@heimdall/admin-contracts/ui.ts";

/** Only build outputs are public; source, manifest and runtime data stay private. */
export function createAdminAssetRoutes(
    root?: string,
    policy: UiPolicy = {},
): ServerApp {
    const app = new Hono<ServerEnv>();
    const directory = root ?? defaultAssetRoot();
    const paths = new Set([
        "/admin/assets/console.js",
        "/admin/assets/console.css",
        "/admin/assets/chat.js",
        "/admin/assets/chat.css",
    ]);
    for (const path of Object.values(policy.trustedModules ?? {})) {
        if (safeUiAssetPath(path, "js")) paths.add(path);
    }
    for (const path of Object.values(policy.sandboxDocuments ?? {})) {
        if (safeUiAssetPath(path, "html")) paths.add(path);
    }
    for (const path of paths) {
        const name = path.slice("/admin/assets/".length);
        const serve = serveStatic({
            root: directory,
            rewriteRequestPath: () => `/${name}`,
        });
        app.get(path, async (context, next) => {
            if (name.startsWith("plugins/")) {
                if (!await isInsideRoot(directory, name)) {
                    return context.notFound();
                }
                if (name.endsWith(".html")) {
                    context.header(
                        "content-security-policy",
                        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts",
                    );
                }
            }
            context.header("cache-control", "no-cache");
            context.header("x-content-type-options", "nosniff");
            return await serve(context, next);
        });
    }
    return app;
}

async function isInsideRoot(root: string, name: string): Promise<boolean> {
    try {
        const [directory, file] = await Promise.all([
            Deno.realPath(root),
            Deno.realPath(`${root}/${name}`),
        ]);
        const normalize = (path: string) => {
            const value = path.replaceAll("\\", "/").replace(/\/$/, "");
            return Deno.build.os === "windows" ? value.toLowerCase() : value;
        };
        return normalize(file).startsWith(`${normalize(directory)}/`);
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
    }
}

function defaultAssetRoot(): string {
    const url = new URL("../../public/assets/", import.meta.url);
    const path = decodeURIComponent(url.pathname);
    return Deno.build.os === "windows"
        ? path.slice(1).replaceAll("/", "\\")
        : path;
}
