import { request } from "./transport.ts";
import { notifyPluginCatalogChanged } from "../plugin-events.ts";

/** Package bytes are sent to the existing authenticated management boundary. */
export function installPluginPackage(input: unknown): Promise<unknown> {
    return request("/api/admin/plugin-package", {
        method: "POST",
        body: JSON.stringify(input),
    }).then((result) => {
        notifyPluginCatalogChanged();
        return result;
    });
}

export function upgradePluginPackage(
    pluginId: string,
    revision: string,
    input: unknown,
): Promise<unknown> {
    return request("/api/admin/plugin-package", {
        method: "PATCH",
        body: JSON.stringify({ pluginId, revision, package: input }),
    }).then((result) => {
        notifyPluginCatalogChanged();
        return result;
    });
}

export function rollbackPluginPackage(
    pluginId: string,
    revision: string,
): Promise<unknown> {
    return request("/api/admin/plugin-rollback", {
        method: "POST",
        body: JSON.stringify({ pluginId, revision }),
    }).then((result) => {
        notifyPluginCatalogChanged();
        return result;
    });
}
