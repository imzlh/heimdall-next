import type { ListedPlugin } from "@heimdall/admin-contracts/console.ts";

export const MAX_PLUGIN_PACKAGE_BYTES = 2 * 1024 * 1024;

export interface PluginPackagePreview {
    readonly input: Record<string, unknown>;
    readonly plugin: ListedPlugin;
    readonly digest: string;
    readonly bytes: number;
}

interface PackageVersion {
    core: string[];
    prerelease: string[];
}

function packageVersion(value?: string): PackageVersion | null {
    if (!value) return null;
    const match = value.match(
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    );
    if (!match || match[0] !== value) return null;
    const prerelease = match[4]?.split(".") ?? [];
    if (prerelease.some((part) => /^\d+$/.test(part) && /^0\d/.test(part))) {
        return null;
    }
    return { core: match.slice(1, 4), prerelease };
}

function compareNumericPart(left: string, right: string): number {
    return left.length - right.length ||
        (left === right ? 0 : left > right ? 1 : -1);
}

function comparePackageVersions(
    left: PackageVersion,
    right: PackageVersion,
): number {
    for (let index = 0; index < 3; index++) {
        const order = compareNumericPart(left.core[index]!, right.core[index]!);
        if (order) return order;
    }
    if (!left.prerelease.length || !right.prerelease.length) {
        return Number(!left.prerelease.length) -
            Number(!right.prerelease.length);
    }
    for (
        let index = 0;
        index < Math.max(left.prerelease.length, right.prerelease.length);
        index++
    ) {
        const a = left.prerelease[index];
        const b = right.prerelease[index];
        if (a === undefined) return -1;
        if (b === undefined) return 1;
        if (a === b) continue;
        const aNumeric = /^\d+$/.test(a);
        const bNumeric = /^\d+$/.test(b);
        if (aNumeric && bNumeric) return compareNumericPart(a, b);
        if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
        return a > b ? 1 : -1;
    }
    return 0;
}

/** Browser preflight only; the host verifies identity, revision and package bytes. */
export function pluginPackageUpgradeError(
    target: ListedPlugin,
    installed: ListedPlugin,
): string {
    if (installed.managed !== true) return "内置插件不能覆盖或升级。";
    if (target.id !== installed.id) {
        return "升级包的插件 ID 必须与当前插件一致。";
    }
    if (target.kind !== installed.kind || target.trust !== installed.trust) {
        return "升级包必须保持当前插件的类型和运行方式。";
    }
    if (!installed.revision?.trim()) {
        return "缺少当前插件的版本记录，无法升级，请刷新插件列表后重试。";
    }
    const currentVersion = packageVersion(installed.version);
    const targetVersion = packageVersion(target.version);
    if (!currentVersion || !targetVersion) {
        return "当前版本和目标版本必须是有效的 SemVer 版本号（例如 1.2.3）。";
    }
    if (comparePackageVersions(targetVersion, currentVersion) <= 0) {
        return "目标版本必须高于当前版本；如需恢复上一版本，请使用卡片中的回滚操作。";
    }
    return "";
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
