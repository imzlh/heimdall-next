import { isAbsolute } from "node:path";
import type { JsonObject } from "@heimdall/contracts";

export interface WorkspaceConfig extends JsonObject {
    readonly root: string;
    readonly readOnly: boolean;
}

/** Configuration is supplied only by the host's persisted plugin settings. */
export function parseWorkspaceConfig(input: unknown = {}): WorkspaceConfig {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("工作区配置必须是对象。");
    }
    const config = input as Record<string, unknown>;
    if (
        Object.keys(config).some((key) => key !== "root" && key !== "readOnly")
    ) {
        throw new TypeError("工作区配置包含未知字段。");
    }
    const root = config.root === undefined ? "" : config.root;
    const readOnly = config.readOnly === undefined ? false : config.readOnly;
    if (
        typeof root !== "string" || root.length > 1_024 ||
        Array.from(root).some((character) => character.charCodeAt(0) < 32)
    ) {
        throw new TypeError("工作区路径必须是不超过 1024 字符的有效路径。");
    }
    if (root.trim() && !isAbsolute(root.trim())) {
        throw new TypeError("请填写服务器上的绝对工作区路径。");
    }
    if (typeof readOnly !== "boolean") {
        throw new TypeError("只读模式必须是布尔值。");
    }
    return { root: root.trim(), readOnly };
}

/** Validate before persistence so a failed save leaves the active workspace intact. */
export async function validateWorkspaceConfig(
    input: unknown,
): Promise<WorkspaceConfig> {
    const config = parseWorkspaceConfig(input);
    if (!config.root) return config;
    try {
        const root = await Deno.realPath(config.root);
        if (!(await Deno.stat(root)).isDirectory) {
            throw new Error("not a directory");
        }
        return { ...config, root };
    } catch {
        throw new TypeError(
            "工作区目录不存在或无法访问，请检查服务器上的路径。",
        );
    }
}
