import type { ListedPlugin } from "@heimdall/admin-contracts/console.ts";

export const MAX_PLUGIN_PACKAGE_BYTES = 2 * 1024 * 1024;

export interface PluginPackagePreview {
    readonly input: Record<string, unknown>;
    readonly plugin: ListedPlugin;
    readonly digest: string;
    readonly bytes: number;
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read metadata only. Host verification owns the manifest and checksum verdict. */
export async function readPluginPackage(
    file: File,
): Promise<PluginPackagePreview> {
    if (file.size > MAX_PLUGIN_PACKAGE_BYTES) {
        throw new Error("插件包不能超过 2 MiB。");
    }
    let input: unknown;
    try {
        const bytes = await file.arrayBuffer();
        input = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
    } catch {
        throw new Error("请提供有效的 UTF-8 JSON 插件包。");
    }
    if (
        !record(input) || input.format !== "heimdall-plugin/v1" ||
        input.entrypoint !== "plugin.js" || typeof input.code !== "string" ||
        typeof input.digest !== "string" || !input.digest.trim() ||
        !record(input.manifest) || typeof input.manifest.id !== "string" ||
        !input.manifest.id.trim()
    ) {
        throw new Error("插件包缺少格式、清单、入口代码或 SHA-256 校验和。");
    }
    const manifest = input.manifest;
    if (manifest.kind !== "tool" || manifest.trust !== "isolated") {
        throw new Error("当前支持安装隔离运行的工具插件。");
    }
    const codeBytes = new TextEncoder().encode(input.code).length;
    if (codeBytes < 1 || codeBytes > 1024 * 1024) {
        throw new Error("插件入口代码必须介于 1 字节和 1 MiB 之间。");
    }
    // sessionFetch reserializes the package; account for compact JSON as well as file size.
    if (
        new TextEncoder().encode(JSON.stringify(input)).length >
            MAX_PLUGIN_PACKAGE_BYTES
    ) {
        throw new Error("插件包不能超过 2 MiB。");
    }
    const text = (value: unknown) =>
        typeof value === "string" ? value : undefined;
    const strings = (value: unknown): string[] =>
        Array.isArray(value)
            ? value.filter((item): item is string => typeof item === "string")
            : [];
    return {
        input,
        bytes: file.size,
        digest: input.digest,
        plugin: {
            id: manifest.id as string,
            name: text(manifest.name),
            description: text(manifest.description),
            version: text(manifest.version),
            kind: manifest.kind,
            trust: manifest.trust,
            capabilities: strings(manifest.capabilities),
            dependencies: strings(manifest.dependencies),
        },
    };
}
