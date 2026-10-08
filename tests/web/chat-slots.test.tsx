/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import {
    assert,
    assertEquals,
    assertFalse,
    assertRejects,
    assertStringIncludes,
    assertThrows,
} from "@std/assert";
import { render, useEffect, useState } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import { Hono } from "hono";
import {
    buildChatExtensions,
    CHAT_TOOL_TOGGLE,
    chatUiContext,
    parseChatExtensions,
} from "@heimdall/admin-contracts/chat-ui.ts";
import type { ChatInitial } from "@heimdall/admin-contracts/chat.ts";
import {
    isUiJsonObject,
    parseManifestUi,
    parseUiContributions,
    resolveUiBlock,
    type UiContribution,
} from "@heimdall/admin-contracts/ui.ts";
import { ChatPageView } from "@heimdall/core/web/pages/chat.tsx";
import { ChatApp } from "@heimdall/core/web/client/chat-app.tsx";
import { createChatController } from "@heimdall/core/web/client/chat/controller.ts";
import { createChatApi } from "@heimdall/core/web/client/chat/api.ts";
import {
    ChatClientSlots,
    runChatSlotAction,
    useChatExtensions,
} from "@heimdall/core/web/client/chat/extensions.tsx";
import { notifyPluginCatalogChanged } from "@heimdall/core/web/client/plugin-events.ts";
import { createAdminWebRoutes } from "@heimdall/core/http/admin-web.tsx";
import { installTestDom } from "./helpers/jsx-dom.ts";
import webManifest from "../../plugins/tool-web/manifest.json" with {
    type: "json",
};

const tool = {
    id: "example.tool",
    name: "示例能力",
    description: "按需提供辅助能力",
};
const conversation = {
    id: "one",
    title: "会话",
    createdAt: "2026-09-29T00:00:00Z",
    updatedAt: "2026-09-29T00:00:00Z",
    disabledTools: [tool.id],
    systemPrompt: "不得进入插件上下文",
};
function initial(patch: Partial<ChatInitial> = {}): ChatInitial {
    return {
        conversations: [conversation],
        conversation,
        messages: [],
        models: ["public-model"],
        tools: [tool],
        available: true,
        authenticated: true,
        ...patch,
    };
}
const sidebar: UiContribution = {
    pluginId: tool.id,
    id: "information",
    slot: "chat.sidebar",
    title: "能力信息",
    schema: {
        blocks: [{
            kind: "text",
            text: "状态未知",
            textFrom: ["tool", "state"],
        }],
    },
};

Deno.test("Chat slots are declared by actual tool manifests and unknown tools receive a host control", () => {
    const declared = parseManifestUi(webManifest);
    assertEquals(declared.map((item) => item.slot), [
        "chat.composer",
        "chat.sidebar",
    ]);
    const extensions = buildChatExtensions(declared, [{
        id: webManifest.id,
        name: webManifest.name,
    }, tool]);
    assertEquals(
        extensions.contributions.filter((item) => item.slot === "chat.composer")
            .length,
        2,
    );
    assertEquals(
        parseChatExtensions(JSON.parse(JSON.stringify(extensions))),
        extensions,
    );
    const toggle = extensions.contributions.find((item) =>
        item.pluginId === tool.id
    )!;
    assertEquals(
        extensions.policy.allowedActions?.[`${tool.id}:${toggle.id}`],
        [CHAT_TOOL_TOGGLE],
    );
    assertThrows(() =>
        parseUiContributions([{
            ...sidebar,
            schema: {
                blocks: [{
                    kind: "toggle",
                    label: "非法",
                    checked: "true",
                    action: { id: CHAT_TOOL_TOGGLE, payload: {} },
                }],
            },
        }])
    );
});

Deno.test("Chat slot context exposes only current conversation identity and its own tool status", () => {
    const extensions = buildChatExtensions([sidebar], [tool]);
    const context = chatUiContext({
        conversation,
        model: "public-model",
        messageCount: 2,
        busy: false,
        tools: [tool],
    }, sidebar);
    assert(isUiJsonObject(context));
    assertEquals(context.conversationId, "one");
    assertEquals(context.data.tool, {
        id: tool.id,
        name: tool.name,
        enabled: false,
        state: "本会话已停用",
    });
    assertFalse(JSON.stringify(context).includes(conversation.systemPrompt));
    const toggle = extensions.contributions.find((item) =>
        item.slot === "chat.composer"
    )!.schema.blocks[0]!;
    assertEquals(
        resolveUiBlock(toggle, context).kind === "toggle" &&
            (resolveUiBlock(toggle, context) as { checked: boolean }).checked,
        false,
    );
    assertEquals(
        chatUiContext({
            conversation,
            model: "public-model",
            messageCount: 2,
            busy: false,
            tools: [tool],
        }, { ...sidebar, pluginId: "other.plugin" }).data.tool,
        undefined,
    );
});

Deno.test("Chat SSR renders both slots and current toggle state without executable plugin code", () => {
    const extensions = buildChatExtensions([sidebar], [tool]);
    const html = ChatPageView({ initial: initial({ extensions }) }).toString();
    assertStringIncludes(html, 'data-ui-slot="chat.composer"');
    assertStringIncludes(html, 'data-ui-slot="chat.sidebar"');
    assertStringIncludes(html, "本会话已停用");
    assertStringIncludes(html, 'aria-checked="false"');
    assertStringIncludes(html, "disabled");
    assertStringIncludes(html, "chat-composer-input");
    assertFalse(
        ChatPageView({ initial: initial({ extensions, authenticated: false }) })
            .toString().includes("data-ui-slot"),
    );
});

Deno.test("ChatApp keeps both SSR slots after enhancement and updates their shared tool state", async () => {
    const dom = installTestDom();
    const previousFetch = globalThis.fetch;
    const snapshot = initial({
        conversation: null,
        conversations: [],
        extensions: buildChatExtensions([sidebar], [tool]),
    });
    globalThis.fetch = (input) => {
        assertEquals(input, "/admin/chat/ui");
        return Promise.resolve(Response.json(snapshot.extensions));
    };
    let unmount = () => {};
    function Root() {
        const [mounted, setMounted] = useState(true);
        unmount = () => setMounted(false);
        return mounted ? <ChatApp initial={snapshot} /> : null;
    }
    try {
        await dom.act(() =>
            render(<Root />, dom.root as unknown as HTMLElement)
        );
        const sidebarSlot = dom.root.querySelector(
            '[data-ui-slot="chat.sidebar"]',
        );
        const composerSlot = dom.root.querySelector(
            '[data-ui-slot="chat.composer"]',
        );
        assert(sidebarSlot, "The app must mount the sidebar slot after SSR");
        assert(composerSlot, "The composer must receive its plugin slot");
        assertStringIncludes(sidebarSlot.textContent, "本会话已启用");
        const toggle = composerSlot.querySelector('[role="switch"]');
        assert(toggle);
        assertFalse(toggle.disabled);
        assertEquals(toggle.getAttribute("aria-checked"), "true");
        await dom.act(() => toggle.click());
        assertEquals(toggle.getAttribute("aria-checked"), "false");
        assertStringIncludes(sidebarSlot.textContent, "本会话已停用");
    } finally {
        await dom.act(unmount);
        globalThis.fetch = previousFetch;
        dom.restore();
    }
});

Deno.test("Chat action bridge rejects stale conversations, peer-target payloads, disabled plugins and arbitrary actions", async () => {
    const extensions = buildChatExtensions([], [tool]);
    const contribution = extensions.contributions[0]!;
    const controller = createChatController({ initial: initial() });
    const context = chatUiContext({
        conversation,
        model: "public-model",
        messageCount: 0,
        busy: false,
        tools: [tool],
    }, contribution);
    const action = { id: CHAT_TOOL_TOGGLE, payload: { checked: true } };
    try {
        await assertRejects(() =>
            runChatSlotAction(controller, extensions, contribution, action, {
                ...context,
                conversationId: "stale",
            })
        );
        await assertRejects(() =>
            runChatSlotAction(controller, extensions, contribution, {
                ...action,
                payload: { checked: true, pluginId: "other" },
            }, context)
        );
        await assertRejects(() =>
            runChatSlotAction(controller, extensions, contribution, {
                ...action,
                id: "source.delete",
            }, context)
        );
        controller.replaceTools([]);
        await assertRejects(() =>
            runChatSlotAction(
                controller,
                extensions,
                contribution,
                action,
                context,
            )
        );
    } finally {
        controller.dispose();
    }
});

Deno.test("Chat DOM toggles before creation, rebinds conversation state, and removes old listeners when a plugin unloads", async () => {
    const dom = installTestDom();
    let extensions = buildChatExtensions([sidebar], [tool]);
    const controller = createChatController({
        initial: initial({ conversation: null }),
        api: {
            ...createChatApi(),
            load: () => Promise.resolve({ conversation, messages: [] }),
        },
    });
    function App() {
        const [state, setState] = useState(controller.getState());
        useEffect(() => controller.subscribe(setState), []);
        return (
            <ChatClientSlots
                slot="chat.composer"
                extensions={extensions}
                state={state}
                controller={controller}
                theme="dark"
            />
        );
    }
    try {
        await dom.act(() =>
            render(<App />, dom.root as unknown as HTMLElement)
        );
        const button = dom.root.querySelector("[data-ui-action-index]");
        assert(button);
        assertFalse(button.disabled);
        assertEquals(button.getAttribute("aria-checked"), "true");
        await dom.act(() => button.dispatchEvent(new Event("click")));
        assertEquals(controller.getState().pendingDisabledTools, [tool.id]);
        assertEquals(
            dom.root.querySelector("[data-ui-action-index]")?.getAttribute(
                "aria-checked",
            ),
            "false",
        );
        await controller.select("one");
        await dom.act();
        assertEquals(
            dom.root.querySelector("[data-ui-action-index]")?.getAttribute(
                "aria-checked",
            ),
            "false",
        );
        const old = dom.root.querySelector("[data-ui-action-index]")!;
        extensions = buildChatExtensions([], []);
        await dom.act(() => {
            controller.replaceTools([]);
        });
        assertEquals(dom.root.querySelector("[data-ui-action-index]"), null);
        await dom.act(() => old.dispatchEvent(new Event("click")));
        assertEquals(controller.getState().conversation?.disabledTools, [
            tool.id,
        ]);
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        controller.dispose();
        dom.restore();
    }
});

Deno.test("Chat extension endpoint and SSR project only enabled declarations and refresh after disabling", async () => {
    let enabled = true;
    const plugins = () => [{ ...tool, kind: "tool", enabled }];
    const app = createAdminWebRoutes({
        chatRoutes: new Hono(),
        contributions: [sidebar],
        dispatch: (request) => {
            const path = new URL(request.url).pathname;
            if (path === "/admin/plugins") {
                return Response.json({ plugins: plugins() });
            }
            if (path === "/admin/status") {
                return Response.json({ plugins: plugins(), presets: [] });
            }
            if (path === "/admin/models") {
                return Response.json({ data: [{ id: "public-model" }] });
            }
            if (path === "/api/chat/conversations") {
                return Response.json({ conversations: [conversation] });
            }
            if (path === "/api/chat/conversation") {
                return Response.json({ conversation, messages: [] });
            }
            return new Response("missing", { status: 404 });
        },
    });
    const html = await (await app.request("/admin/chat?id=one")).text();
    assertStringIncludes(html, "本会话已停用");
    const response = await app.request("/admin/chat/ui");
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals((await response.json()).contributions.length, 2);
    enabled = false;
    assertEquals(
        (await (await app.request("/admin/chat/ui")).json()).contributions,
        [],
    );
    assertEquals(
        (await app.request("/admin/chat/ui", {
            headers: { origin: "https://foreign.invalid" },
        })).status,
        403,
    );
    const locked = createAdminWebRoutes({
        adminAuthToken: "private-token",
        dispatch: () => {
            throw new Error("Unauthorized read");
        },
    });
    assertEquals((await locked.request("/admin/chat/ui")).status, 401);
});

Deno.test("Chat metadata invalidation refreshes after an in-flight read, unloads slots and aborts on disposal", async () => {
    const dom = installTestDom();
    const previousFetch = globalThis.fetch;
    const snapshot = initial({
        conversation: null,
        extensions: buildChatExtensions([sidebar], [tool]),
    });
    const controller = createChatController({ initial: snapshot });
    const reads: {
        complete: (response: Response) => void;
        signal: AbortSignal | null | undefined;
    }[] = [];
    globalThis.fetch = (_input, init) =>
        new Promise((complete) => {
            reads.push({ complete, signal: init?.signal });
        });
    function App() {
        const plugins = useChatExtensions(snapshot, controller);
        const [state, setState] = useState(controller.getState());
        useEffect(() => controller.subscribe(setState), []);
        return (
            <ChatClientSlots
                slot="chat.sidebar"
                extensions={plugins.extensions}
                state={state}
                controller={controller}
                theme="light"
            />
        );
    }
    let unmount = () => {};
    function Root() {
        const [mounted, setMounted] = useState(true);
        unmount = () => setMounted(false);
        return mounted ? <App /> : null;
    }
    try {
        await dom.act(() =>
            render(<Root />, dom.root as unknown as HTMLElement)
        );
        assertEquals(reads.length, 1);
        notifyPluginCatalogChanged();
        assertEquals(reads.length, 1);
        reads[0]!.complete(Response.json(snapshot.extensions));
        await dom.act();
        await dom.act();
        assertEquals(reads.length, 2);
        reads[1]!.complete(Response.json(buildChatExtensions([], [])));
        await dom.act();
        await dom.act();
        assertEquals(controller.getState().tools, []);
        assertEquals(dom.root.querySelector("[data-ui-extension]"), null);
        notifyPluginCatalogChanged();
        assertEquals(reads.length, 3);
        await dom.act(unmount);
        assertEquals(reads[2]!.signal?.aborted, true);
        reads[2]!.complete(Response.json(snapshot.extensions));
        await dom.act();
        await dom.act();
        assertEquals(controller.getState().tools, []);
    } finally {
        await dom.act(unmount);
        globalThis.fetch = previousFetch;
        controller.dispose();
        dom.restore();
    }
});

Deno.test("Chat extensions recover the original catalog after a session expires and signs in again", async () => {
    const dom = installTestDom();
    const previousFetch = globalThis.fetch;
    const snapshot = initial({
        conversation: null,
        extensions: buildChatExtensions([sidebar], [tool]),
    });
    const controller = createChatController({ initial: snapshot });
    let authenticated = false;
    globalThis.fetch = () =>
        Promise.resolve(
            authenticated
                ? Response.json(snapshot.extensions)
                : new Response(null, { status: 401 }),
        );
    let unmount = () => {};
    function App() {
        const plugins = useChatExtensions(snapshot, controller);
        const [state, setState] = useState(controller.getState());
        useEffect(() => controller.subscribe(setState), []);
        return (
            <>
                <p role="status">{plugins.error}</p>
                <ChatClientSlots
                    slot="chat.sidebar"
                    extensions={plugins.extensions}
                    state={state}
                    controller={controller}
                    theme="light"
                />
            </>
        );
    }
    function Root() {
        const [mounted, setMounted] = useState(true);
        unmount = () => setMounted(false);
        return mounted ? <App /> : null;
    }
    try {
        await dom.act(() =>
            render(<Root />, dom.root as unknown as HTMLElement)
        );
        await dom.act();
        assertEquals(controller.getState().tools, []);
        assertEquals(dom.root.querySelector("[data-ui-extension]"), null);
        assertStringIncludes(dom.root.textContent, "插件能力暂不可用");

        authenticated = true;
        await dom.act(() => notifyPluginCatalogChanged());
        await dom.act();
        assertEquals(controller.getState().tools, [tool]);
        assert(dom.root.querySelector("[data-ui-extension]"));
        assertStringIncludes(dom.root.textContent, "本会话已启用");
        assertFalse(dom.root.textContent.includes("插件能力暂不可用"));
    } finally {
        await dom.act(unmount);
        globalThis.fetch = previousFetch;
        controller.dispose();
        dom.restore();
    }
});
