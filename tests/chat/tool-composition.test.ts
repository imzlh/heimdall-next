import { assert, assertEquals } from "@std/assert";
import type {
    GenerationRequest,
    InferenceSource,
    StreamFrame,
} from "@heimdall/contracts";
import { loadBuiltinComposition } from "@heimdall/core/composition/builtins.ts";
import { createServer } from "@heimdall/core/composition/server.ts";
import { DenoKvConfigStore } from "@heimdall/core/storage/deno-kv.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";

const clockId = "heimdall.tool.clock";

Deno.test("tool plugin state changes the next chat turn and survives composition restart", async () => {
    const kv = await Deno.openKv(":memory:");
    const store = openSqliteChatStore(":memory:");
    const builtins = await loadBuiltinComposition({
        configStore: new DenoKvConfigStore(kv),
        env: () => undefined,
    });
    const offered: string[][] = [];
    const source: InferenceSource = {
        id: "tool-composition-fixture",
        capabilities: [{ operation: "generation.create", streaming: false }],
        execute(input) {
            const request = input.payload as GenerationRequest;
            offered.push((request.tools ?? []).map((tool) => tool.name));
            const hasResult = request.messages.some((message) =>
                message.parts.some((part) => part.type === "tool_result")
            );
            const events: StreamFrame["event"][] = [
                { kind: "run.started", request: input },
                hasResult
                    ? {
                        kind: "part.delta",
                        messageId: "reply",
                        partId: "text",
                        delta: "plugin answered",
                    }
                    : {
                        kind: "tool.call",
                        messageId: "reply",
                        callId: "clock-call",
                        name: "current_time",
                        argumentsText: "{}",
                    },
                { kind: "run.completed" },
            ];
            return (async function* () {
                for (const [index, event] of events.entries()) {
                    yield {
                        version: 1 as const,
                        requestId: input.requestId,
                        streamId: `fixture:${input.requestId}`,
                        seq: index + 1,
                        eventId: `event:${index}`,
                        timestamp: new Date().toISOString(),
                        event,
                    };
                }
            })();
        },
    };
    const app = createServer({
        sources: [source],
        adminCatalog: builtins.catalog,
        adminManagement: builtins.management,
        chat: { store, tools: builtins.toolPlugins },
    });
    const ask = async () => {
        const created = await app.request("/api/chat/conversations", {
            method: "POST",
        });
        const conversationId = (await created.json()).conversation.id;
        const reply = await app.request("/api/chat/message", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId,
                model: "fixture",
                text: "time",
            }),
        });
        assertEquals(reply.status, 200);
        return await reply.json();
    };
    try {
        const initialCatalog = await (await app.request("/admin/plugins"))
            .json();
        assertEquals(
            initialCatalog.plugins.find((item: { id: string }) =>
                item.id === clockId
            )?.kind,
            "tool",
        );
        const first = await ask();
        assertEquals(first.toolCalls, []);
        assertEquals(first.messages.at(-1).text, "plugin answered");
        assert(offered[0]?.includes("current_time"));
        assertEquals(offered[0]?.includes("web_search"), false);

        const disabled = await app.request("/admin/plugin-state", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pluginId: clockId, enabled: false }),
        });
        assertEquals(disabled.status, 200);
        await disabled.body?.cancel();
        const next = await ask();
        assertEquals(
            next.toolCalls.map((call: { name: string }) => call.name),
            ["current_time"],
        );
        assertEquals(offered.at(-1)?.includes("current_time"), false);
        assertEquals(
            next.messages.some((item: { role: string }) =>
                item.role === "tool"
            ),
            false,
        );

        const restarted = await loadBuiltinComposition({
            configStore: new DenoKvConfigStore(kv),
            env: (name) =>
                name === "HEIMDALL_TAVILY_KEY"
                    ? "configured-test-key"
                    : undefined,
        });
        try {
            assertEquals(
                restarted.toolPlugins().some((item) =>
                    item.manifest.id === clockId
                ),
                false,
            );
            assert(
                restarted.toolPlugins().some((item) =>
                    item.tools.some((tool) =>
                        tool.definition.name === "web_search"
                    )
                ),
            );
            const context = {
                request: new Request("http://localhost"),
                requestId: "tool-restart",
            };
            const provider = restarted.catalog.plugins;
            const plugins = typeof provider === "function"
                ? await provider(context)
                : provider;
            assertEquals(
                plugins?.find((item) => item.id === clockId)?.enabled,
                false,
            );
            await restarted.management.setPluginEnabled?.(
                context,
                clockId,
                true,
            );
            assert(
                restarted.toolPlugins().some((item) =>
                    item.manifest.id === clockId
                ),
            );
        } finally {
            await restarted.close();
        }
    } finally {
        await builtins.close();
        store.close();
        kv.close();
    }
});
