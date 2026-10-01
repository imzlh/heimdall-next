import { assertEquals, assertRejects } from "@std/assert";
import { packagePlugin } from "../scripts/package-plugin.ts";
import { createManagedPlugins } from "../src/composition/managed-plugins.ts";
import { DenoKvConfigStore } from "../src/storage/deno-kv.ts";

const manifest = {
    id: "test.packaged",
    name: "离线回声",
    version: "1.0.0",
    apiVersion: "1",
    kind: "tool",
    trust: "isolated",
};
const code = `export function invoke(method, payload) {
    if (method === "tools.list") return [{ name: "offline_echo", description: "回声", inputSchema: { type: "object" } }];
    return { text: payload.argumentsText, isError: false };
}`;

Deno.test("packaged ESM installs through the real managed host and executes offline", async () => {
    const input = JSON.parse(await packagePlugin(manifest, code));
    using kv = await Deno.openKv(":memory:");
    const plugins = createManagedPlugins(
        new DenoKvConfigStore(kv),
        () => [],
        () => [],
    );
    try {
        await assertRejects(() =>
            plugins.install({ ...input, code: input.code + "tampered" })
        );
        assertEquals(await plugins.host.list(), []);
        await plugins.install(input);
        assertEquals((await plugins.host.get(manifest.id))?.enabled, false);
        await plugins.host.enable(manifest.id);
        assertEquals(
            plugins.tools()[0]?.tools[0]?.definition.name,
            "offline_echo",
        );
        assertEquals(
            await plugins.host.invoke(manifest.id, {
                method: "tools.execute",
                payload: { argumentsText: "你好" },
            }),
            { text: "你好", isError: false },
        );
    } finally {
        await plugins.host.close?.();
    }
});

Deno.test("packaging checks install policy and sizes without evaluating the entrypoint", async () => {
    const input = JSON.parse(
        await packagePlugin(
            manifest,
            'throw new Error("never execute during packaging");',
        ),
    );
    assertEquals(input.entrypoint, "plugin.js");
    await assertRejects(() =>
        packagePlugin({ ...manifest, kind: "source" }, code)
    );
    await assertRejects(() =>
        packagePlugin({ ...manifest, permissions: { network: true } }, code)
    );
    await assertRejects(() => packagePlugin(manifest, ""));
    await assertRejects(() =>
        packagePlugin(manifest, "x".repeat(1024 * 1024 + 1))
    );
    await assertRejects(() =>
        packagePlugin(manifest, "\n".repeat(1024 * 1024))
    );
});
