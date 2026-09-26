import type { ProxyPoolInput } from "@heimdall/admin-contracts/proxies.ts";
import {
    type ProxyPoolEnvelope,
    readProxyPoolView,
} from "../../shared/proxy-presentation.ts";
import { payloadRecord, performRequest } from "./transport.ts";

export type { ProxyPoolEnvelope } from "../../shared/proxy-presentation.ts";

export async function loadProxyPool(): Promise<ProxyPoolEnvelope> {
    const result = await performRequest("/api/admin/proxies");
    return {
        pool: readProxyPoolView(payloadRecord(result.data)?.pool),
        etag: result.etag,
    };
}

export async function saveProxyPool(
    input: ProxyPoolInput,
    etag: string,
): Promise<ProxyPoolEnvelope> {
    const result = await performRequest("/api/admin/proxies", {
        method: "PUT",
        headers: { "If-Match": etag },
        body: JSON.stringify({
            defaultProxyId: input.defaultProxyId,
            entries: input.entries.map((entry) => ({
                id: entry.id,
                name: entry.name,
                url: entry.url,
                enabled: entry.enabled,
                ...(entry.basicAuth !== undefined
                    ? { basicAuth: entry.basicAuth }
                    : {}),
            })),
        }),
    });
    return {
        pool: readProxyPoolView(payloadRecord(result.data)?.pool),
        etag: result.etag,
    };
}
