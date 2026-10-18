import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { computePluginArtifactDigest } from "@heimdall/plugin-host";
import { buildChatExtensions } from "@heimdall/admin-contracts/chat-ui.ts";
import { resolveUiRender } from "@heimdall/admin-contracts/ui.ts";
import { loadBuiltinComposition } from "@heimdall/core/composition/builtins.ts";
import { loadRuntimeUiContributions } from "@heimdall/core/composition/ui-contributions.ts";
import { createManagedPlugins } from "@heimdall/core/composition/managed-plugins.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";
import { ChatSlots } from "@heimdall/core/web/components/chat-slots.tsx";

Deno.test("offline installed plugin declares real Chat slots that restore, disable and uninstall with its lifecycle", async () => {
    const kv = await Deno.openKv(":memory:");
    const store = new DenoKvConfigStore(kv);
    const options = {
        pluginRoot: new URL("./missing-plugin-ui-directory/", import.meta.url),
        env: () => undefined,
    };
    let composition = await loadBuiltinComposition({
        ...options,
        configStore: store,
    });
    const manager = createManagedPlugins(store, () => [], () => []);
    const id = "test.dynamic.ui";
    const code =
        `export function invoke(method) { if(method === "tools.list") return [{name:"dynamic_ui",description:"Dynamic capability",inputSchema:{type:"object"}}]; return {text:"ok"}; }`;
    const input = {
        format: "heimdall-plugin/v1",
        entrypoint: "plugin.js",
        code,
        digest: await computePluginArtifactDigest(
            new TextEncoder().encode(code),
        ),
        manifest: {
            id,
            name: "动态会话插件",
            version: "1.0.0",
            apiVersion: "1",
            kind: "tool",
            trust: "isolated",
            ui: [{
                pluginId: id,
                id: "details",
                slot: "chat.sidebar",
                title: "动态功能已就绪",
                render: {
                    kind: "trusted",
                    modulePath: "/admin/assets/plugins/dynamic/ui.js",
                },
                schema: {
                    blocks: [{
                        kind: "text",
                        text: "来自离线安装包的能力说明",
                    }],
                },
            }],
        },
    };
    try {
        await manager.install(input);
        assertEquals(
            await loadRuntimeUiContributions(composition.pluginHost, options),
            [],
        );
        await composition.pluginHost.enable(id);
        let declared = await loadRuntimeUiContributions(
            composition.pluginHost,
            options,
        );
        assertEquals(declared.length, 1);
        assertEquals(resolveUiRender(declared[0]!), { kind: "schema" });
        const extensions = buildChatExtensions(declared, [{
            id,
            name: "动态会话插件",
        }]);
        // Exercise the installed contribution's schema renderer directly;
        // the Chat page no longer duplicates capability cards in its sidebar.
        const html = ChatSlots({
            slot: "chat.sidebar",
            initial: {
                conversations: [],
                conversation: null,
                messages: [],
                models: ["model"],
                authenticated: true,
                available: true,
                extensions,
            },
        })!.toString();
        assertStringIncludes(html, "来自离线安装包的能力说明");
        assertStringIncludes(html, 'data-ui-mode="schema"');
        assertFalse(html.includes("<script"));
        await composition.close();
        composition = await loadBuiltinComposition({
            ...options,
            configStore: store,
        });
        declared = await loadRuntimeUiContributions(
            composition.pluginHost,
            options,
        );
        assertEquals(declared.length, 1);
        await composition.pluginHost.disable(id);
        assertEquals(
            await loadRuntimeUiContributions(composition.pluginHost, options),
            [],
        );
        await composition.pluginHost.enable(id);
        await composition.pluginHost.uninstall(id);
        assertEquals(
            await loadRuntimeUiContributions(composition.pluginHost, options),
            [],
        );
    } finally {
        await manager.host.close?.();
        await composition.close();
        kv.close();
    }
});

Deno.test("invalid installed slot declarations cannot suppress a healthy plugin's content", async () => {
    const warnings: string[] = [];
    const good = {
        id: "good",
        version: "1.0.0",
        apiVersion: "1" as const,
        kind: "tool" as const,
        trust: "isolated" as const,
        name: "good",
        ui: [{
            pluginId: "good",
            id: "status",
            slot: "chat.sidebar",
            title: "Healthy",
            schema: { blocks: [{ kind: "text", text: "Available" }] },
        }],
    };
    const host = {
        list: () =>
            Promise.resolve([
                {
                    manifest: { ...good, id: "bad" },
                    enabled: true,
                    isolated: true,
                    installedAt: "now",
                    updatedAt: "now",
                    signatureVerified: false,
                },
                {
                    manifest: good,
                    enabled: true,
                    isolated: true,
                    installedAt: "now",
                    updatedAt: "now",
                    signatureVerified: false,
                },
            ]),
    };
    const items = await loadRuntimeUiContributions(host, {
        pluginRoot: new URL("./missing-plugin-ui-directory/", import.meta.url),
        warn: (message) => warnings.push(message),
    });
    assertEquals(items.map((item) => item.pluginId), ["good"]);
    assertEquals(warnings.length, 1);
});
