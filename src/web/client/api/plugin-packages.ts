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
