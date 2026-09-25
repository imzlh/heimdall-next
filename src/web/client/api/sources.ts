import { AdminApiError, performRequest, request } from "./transport.ts";
import type {
    ListedSource,
    SourceConfigEnvelope,
    SourceConfigInput,
} from "./types.ts";
import type {
    CreateSourceInput,
    UpdateSourceInput,
} from "@heimdall/admin-contracts";

/** Read the current revision before resolving an edit conflict. */
export async function loadSourceMetadata(
    sourceId: string,
): Promise<ListedSource> {
    const result = await request<{ sources?: ListedSource[] }>(
        "/api/admin/sources",
    );
    const source = result.sources?.find((item) => item.id === sourceId);
    if (!source) {
        throw new AdminApiError("渠道已不存在，请刷新列表。", { status: 404 });
    }
    return source;
}

/** Update instance metadata without replacing provider configuration. */
export function updateSource(
    sourceId: string,
    input: UpdateSourceInput,
    versionstamp = "",
): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (versionstamp) headers["If-Match"] = versionstamp;
    return request(`/api/admin/sources?id=${encodeURIComponent(sourceId)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.priority !== undefined
                ? { priority: input.priority }
                : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        }),
    });
}

export function deleteSource(
    sourceId: string,
    versionstamp = "",
): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (versionstamp) headers["If-Match"] = versionstamp;
    return request(`/api/admin/sources?id=${encodeURIComponent(sourceId)}`, {
        method: "DELETE",
        headers,
    });
}

/** Create a distinct channel; never overwrite an existing source's configuration. */
export function createSource(input: CreateSourceInput): Promise<unknown> {
    return request("/api/admin/sources", {
        method: "POST",
        body: JSON.stringify({
            id: input.id,
            name: input.name,
            priority: input.priority,
            sourcePluginId: input.sourcePluginId,
            ...(input.presetId ? { presetId: input.presetId } : {}),
            config: input.config,
        }),
    });
}

function withEtag(data: unknown, etag: string): SourceConfigEnvelope {
    return { ...(data as Record<string, unknown>), etag };
}

export async function loadSourceConfig(
    sourceId = "openai-compatible",
): Promise<SourceConfigEnvelope> {
    const result = await performRequest(
        `/api/admin/source-config?id=${encodeURIComponent(sourceId)}`,
    );
    return withEtag(result.data, result.etag);
}

export function validateSourceConfig(
    sourceId: string,
    config: SourceConfigInput,
): Promise<unknown> {
    return request(
        `/api/admin/source-config/validate?id=${encodeURIComponent(sourceId)}`,
        { method: "POST", body: JSON.stringify({ config }) },
    );
}

export async function saveSourceConfig(
    sourceId: string,
    config: SourceConfigInput,
    versionstamp = "",
): Promise<SourceConfigEnvelope> {
    const headers: Record<string, string> = {};
    if (versionstamp) headers["If-Match"] = versionstamp;
    const result = await performRequest(
        `/api/admin/source-config?id=${encodeURIComponent(sourceId)}`,
        { method: "PUT", headers, body: JSON.stringify({ config }) },
    );
    return withEtag(result.data, result.etag);
}

export function previewPreset(
    presetId: string,
    config: SourceConfigInput,
): Promise<unknown> {
    return request("/api/admin/preset-preview", {
        method: "POST",
        body: JSON.stringify({ presetId, config }),
    });
}

export async function applyPreset(
    presetId: string,
    config: SourceConfigInput,
    versionstamp = "",
): Promise<SourceConfigEnvelope> {
    const headers: Record<string, string> = {};
    if (versionstamp) headers["If-Match"] = versionstamp;
    const result = await performRequest("/api/admin/preset-apply", {
        method: "POST",
        headers,
        body: JSON.stringify({ presetId, config }),
    });
    return withEtag(result.data, result.etag);
}
