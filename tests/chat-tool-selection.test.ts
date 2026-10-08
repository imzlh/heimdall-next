import {
    assert,
    assertEquals,
    assertRejects,
    assertStringIncludes,
    assertThrows,
} from "@std/assert";
import {
    MAX_CHAT_TOOLS,
    parseChatDisabledTools,
} from "@heimdall/admin-contracts/chat.ts";
import {
    buildChatExtensions,
    projectChatTools,
} from "@heimdall/admin-contracts/chat-ui.ts";
import { createServer } from "../main.ts";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";
import { createChatController } from "@heimdall/core/web/client/chat/controller.ts";
import { createChatApi } from "@heimdall/core/web/client/chat/api.ts";
import { loadChatSnapshot } from "@heimdall/core/web/server/chat-snapshot.ts";

const catalog = Array.from({ length: MAX_CHAT_TOOLS }, (_, index) => ({
    id: `example.tool.${index}`,
    name: `工具 ${index}`,
    kind: "tool",
    enabled: true,
}));
const tools = projectChatTools(catalog);
const ids = tools.map((tool) => tool.id);

Deno.test("Chat counts enabled tool plugins after filtering the mixed catalog", () => {
    assertEquals(
        projectChatTools([
            ...catalog.map((item) => ({ ...item, kind: "source" })),
            ...catalog.map((item) => ({ ...item, enabled: false })),
            ...catalog,
            ...catalog,
            { ...catalog[0], id: "one.more.tool" },
        ]),
        tools,
    );
    assertEquals(
        buildChatExtensions([], tools).contributions.length,
        MAX_CHAT_TOOLS,
    );
    assertEquals(parseChatDisabledTools(ids), ids);
    assertThrows(
        () => parseChatDisabledTools([...ids, "one.more.tool"]),
        TypeError,
    );
    for (const invalid of [null, "tool", [""], [1], ["a".repeat(129)]]) {
        assertThrows(() => parseChatDisabledTools(invalid), TypeError);
    }
});

Deno.test("all visible Chat tools persist before first send and survive API, SSR, forks and reopening SQLite", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-chat-tool-limit-",
    });
    const path = `${directory}/chat.sqlite`;
    let store = openSqliteChatStore(path);
    let app = createServer({ chat: { store } });
    const previousFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (input, init) => {
        requests++;
        const request = input instanceof Request
            ? input
            : new Request(new URL(String(input), "http://localhost"), init);
        if (request.method !== "GET" && request.method !== "HEAD") {
            request.headers.set("origin", "http://localhost");
        }
        return Promise.resolve(app.fetch(request));
    };
    let opened = 0;
    const controller = createChatController({
        initial: {
            authenticated: true,
            available: true,
            conversation: null,
            conversations: [],
            messages: [],
            models: ["model"],
            tools,
        },
        api: {
            ...createChatApi(),
            open(command) {
                opened++;
                assertEquals(
                    store.getConversation(command.conversationId)
                        ?.disabledTools,
                    ids,
                );
                return {
                    finished: Promise.resolve("done"),
                    stop() {},
                    close() {},
                };
            },
        },
    });
    try {
        for (const id of ids) {
            assertEquals(await controller.setToolEnabled(id, false), true);
        }
        assertEquals(requests, 0);
        assertEquals(controller.getState().pendingDisabledTools, ids);
        controller.setDraft("hello");
        await controller.send();
        assertEquals(controller.getState().error, "");
        assertEquals(opened, 1);
        const id = controller.getState().selectedId;
        assert(id);
        assertEquals(controller.getState().conversation?.disabledTools, ids);
        assertEquals(controller.getState().pendingDisabledTools, []);

        assertEquals(await controller.setToolEnabled(ids[0]!, true), true);
        assertEquals(store.getConversation(id)?.disabledTools, ids.slice(1));
        assertEquals(await controller.setToolEnabled(ids[0]!, false), true);
        const savedIds = [...ids.slice(1), ids[0]!];
        assertEquals(store.getConversation(id)?.disabledTools, savedIds);

        const rejected = await app.request(`/api/chat/conversation?id=${id}`, {
            method: "PATCH",
            body: JSON.stringify({
                disabledTools: [...savedIds, "extra.tool"],
            }),
        });
        assertEquals(rejected.status, 400);
        assertEquals(store.getConversation(id)?.disabledTools, savedIds);
        const requestsBeforeInvalid = requests;
        await assertRejects(() =>
            createChatApi().updateSettings(id, {
                disabledTools: [...savedIds, "extra.tool"],
            }), TypeError);
        assertEquals(requests, requestsBeforeInvalid);

        // Retired plugin choices are retained. An overflowing new choice fails
        // immediately instead of claiming success and breaking the next send.
        controller.replaceTools([...tools, {
            id: "extra.tool",
            name: "extra",
        }]);
        assertEquals(
            await controller.setToolEnabled("extra.tool", false),
            false,
        );
        assertStringIncludes(
            controller.getState().error,
            String(MAX_CHAT_TOOLS),
        );
        assertEquals(store.getConversation(id)?.disabledTools, savedIds);

        const time = "2026-10-01T00:00:00.000Z";
        store.addMessage({
            id: "root",
            conversationId: id,
            role: "user",
            text: "hello",
            createdAt: time,
        });
        const fork = store.forkConversation(id, "root", time);
        assertEquals(fork.disabledTools, savedIds);
        store.close();
        store = openSqliteChatStore(path);
        app = createServer({ chat: { store } });
        assertEquals(store.getConversation(id)?.disabledTools, savedIds);
        assertEquals(store.getConversation(fork.id)?.disabledTools, savedIds);
        assertEquals(
            (await createChatApi().load(id)).conversation.disabledTools,
            savedIds,
        );
        const snapshot = await loadChatSnapshot({
            authorized: true,
            available: true,
            conversationId: id,
            dispatch: (request) =>
                new URL(request.url).pathname === "/admin/plugins"
                    ? Response.json({ plugins: catalog })
                    : app.fetch(request),
        });
        assertEquals(snapshot.error, undefined);
        assertEquals(snapshot.conversation?.disabledTools, savedIds);
        assertEquals(
            snapshot.conversations.find((item) => item.id === fork.id)
                ?.disabledTools,
            savedIds,
        );
        assertEquals(snapshot.tools?.length, MAX_CHAT_TOOLS);
    } finally {
        controller.dispose();
        globalThis.fetch = previousFetch;
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("pending Chat tool choices reject overflow before creating a conversation", async () => {
    const controller = createChatController({
        initial: {
            authenticated: true,
            available: true,
            conversation: null,
            conversations: [],
            messages: [],
            models: [],
            tools: [...tools, { id: "extra.tool", name: "extra" }],
        },
    });
    try {
        for (const id of ids) {
            assertEquals(await controller.setToolEnabled(id, false), true);
        }
        assertEquals(
            await controller.setToolEnabled("extra.tool", false),
            false,
        );
        assertEquals(controller.getState().pendingDisabledTools, ids);
        assertEquals(await controller.setToolEnabled(ids[0]!, true), true);
        assertEquals(
            await controller.setToolEnabled("extra.tool", false),
            true,
        );
        assertEquals(controller.getState().pendingDisabledTools, [
            ...ids.slice(1),
            "extra.tool",
        ]);
    } finally {
        controller.dispose();
    }
});
