import type { ToolConfigDto } from "@heimdall/admin-contracts";
import {
    isUiJsonObject,
    type UiJsonObject,
} from "@heimdall/admin-contracts/ui.ts";
import { notifyPluginCatalogChanged } from "../plugin-events.ts";
import { AdminApiError, request } from "./transport.ts";

function checkedConfig(value: ToolConfigDto, pluginId: string): ToolConfigDto {
    if (
        !value || value.pluginId !== pluginId ||
        !isUiJsonObject(value.config) || !isUiJsonObject(value.configSchema) ||
        !(value.revision === null ||
            (typeof value.revision === "string" && value.revision.trim()))
    ) {
        throw new AdminApiError("插件配置响应无效，请重新加载配置。", {
            code: "invalid_response",
        });
    }
    return value;
}

/** Configuration is scoped to the selected plugin and uses its own revision. */
export async function loadToolConfig(
    pluginId: string,
    signal?: AbortSignal,
): Promise<ToolConfigDto> {
    return checkedConfig(
        await request<ToolConfigDto>(
            `/api/admin/tool-config?pluginId=${encodeURIComponent(pluginId)}`,
            { signal },
        ),
        pluginId,
    );
}

export async function saveToolConfig(
    pluginId: string,
    config: UiJsonObject,
    revision: string | null,
): Promise<ToolConfigDto> {
    const saved = checkedConfig(
        await request<ToolConfigDto>("/api/admin/tool-config", {
            method: "PUT",
            body: JSON.stringify({ pluginId, config, revision }),
        }),
        pluginId,
    );
    notifyPluginCatalogChanged();
    return saved;
}
