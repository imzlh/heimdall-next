import {
    computePluginArtifactDigest,
    validatePluginManifest,
    verifyPluginArtifact,
} from "@heimdall/plugin-host";
import type { ManagedPluginPackage } from "../src/composition/managed-plugins.ts";

/** Package prebundled ESM without importing or evaluating plugin code. */
export async function packagePlugin(
    manifestInput: unknown,
    code: string,
): Promise<string> {
    const manifest = validatePluginManifest(manifestInput);
    if (manifest.kind !== "tool" || manifest.trust !== "isolated") {
        throw new TypeError(
            "动态安装当前支持隔离工具插件（kind: tool, trust: isolated）。",
        );
    }
    const bytes = new TextEncoder().encode(code);
    if (bytes.length === 0 || bytes.length > 1024 * 1024) {
        throw new RangeError("插件 ESM 必须介于 1 字节和 1 MiB 之间。");
    }
    const artifact = {
        manifest,
        entrypoint: "plugin.js" as const,
        bytes,
        digest: await computePluginArtifactDigest(bytes),
    };
    await verifyPluginArtifact(artifact, {
        allowUnsigned: true,
        maxBytes: 1024 * 1024,
    });
    const output: ManagedPluginPackage = {
        format: "heimdall-plugin/v1",
        manifest,
        entrypoint: artifact.entrypoint,
        code,
        digest: artifact.digest,
    };
    const json = JSON.stringify(output, null, 2) + "\n";
    if (new TextEncoder().encode(json).length > 2 * 1024 * 1024) {
        throw new RangeError("JSON 插件包不能超过 2 MiB，请先压缩入口代码。");
    }
    return json;
}

if (import.meta.main) {
    if (Deno.args.length !== 3) {
        console.error(
            "用法：deno task plugin:package <manifest.json> <已打包的 ESM.js> <输出.json>",
        );
        Deno.exitCode = 1;
    } else {
        try {
            const [manifestPath, codePath, outputPath] = Deno.args as [
                string,
                string,
                string,
            ];
            const [manifest, code] = await Promise.all([
                Deno.readTextFile(manifestPath).then((text) =>
                    JSON.parse(text)
                ),
                Deno.readTextFile(codePath),
            ]);
            const output = await packagePlugin(manifest, code);
            // A package command must never overwrite its sources or an existing release.
            await Deno.writeTextFile(outputPath, output, { createNew: true });
            console.log(
                `插件包已写入 ${outputPath}，可在管理端“安装插件”中选择。`,
            );
        } catch (error) {
            console.error(
                error instanceof Error ? error.message : String(error),
            );
            Deno.exitCode = 1;
        }
    }
}
