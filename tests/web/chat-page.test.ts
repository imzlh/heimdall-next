import {
    assert,
    assertEquals,
    assertFalse,
    assertStringIncludes,
} from "@std/assert";
import { Hono } from "hono";
import { createServerApp } from "@heimdall/core/http/app.ts";
import type {
    ChatInitial,
    ChatMessage,
} from "@heimdall/admin-contracts/chat.ts";

const secret = "chat-page-private-token";
const conversation = {
    id: "test-chat",
    title: "用户私有会话标题",
    createdAt: "2026-09-24T00:00:00Z",
    updatedAt: "2026-09-24T00:00:00Z",
};

function app(messages?: ChatMessage[]) {
    const chatRoutes = new Hono();
    chatRoutes.get(
        "/conversations",
        (context) => context.json({ conversations: [conversation] }),
    );
    chatRoutes.get(
        "/conversation",
        (context) =>
            context.json({
                conversation,
                messages: messages ?? [{
                    id: "message",
                    conversationId: conversation.id,
                    role: "assistant",
                    text: "<script>private()</script>",
                    createdAt: conversation.createdAt,
                }],
            }),
    );
    return createServerApp({
        adminAuthToken: secret,
        chatRoutes,
        models: () => ({
            object: "list",
            data: [{ id: "private-choice-model" }],
        }),
    });
}

function boot(html: string): ChatInitial {
    const match =
        /<script id="heimdall-chat-boot" type="application\/json">([\s\S]*?)<\/script>/
            .exec(html);
    assert(match);
    return JSON.parse(match[1]!);
}

Deno.test("standalone chat SSR provides a login view and preserves canonical history links", async () => {
    const server = app();
    const redirect = await server.request("/chat?id=test-chat");
    assertEquals(redirect.status, 303);
    assertEquals(redirect.headers.get("location"), "/admin/chat?id=test-chat");
    const response = await server.request("/admin/chat?id=test-chat");
    const html = await response.text();
    assertEquals(response.status, 200);
    assertStringIncludes(html, 'action="/admin/session"');
    assertStringIncludes(html, 'name="returnTo" value="/admin/chat"');
    assertStringIncludes(html, 'id="heimdall-chat"');
    assertStringIncludes(html, "/admin/assets/chat.js");
    assertStringIncludes(html, "/admin/assets/chat.css");
    assertFalse(html.includes("用户私有会话标题"));
    assertFalse(html.includes("private-choice-model"));
    assertFalse(html.includes("/admin/assets/console.js"));
    assertEquals(boot(html).authenticated, false);
    assertEquals(boot(html).messages, []);
});

Deno.test("standalone chat SSR safely serializes selected history and self-hosted runtime", async () => {
    const server = app();
    const response = await server.request("/admin/chat?id=test-chat", {
        headers: { authorization: `Bearer ${secret}` },
    });
    const html = await response.text();
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertStringIncludes(
        response.headers.get("content-security-policy")!,
        "script-src 'self'",
    );
    assertStringIncludes(html, "用户私有会话标题");
    assertStringIncludes(html, "&lt;script&gt;private()&lt;/script&gt;");
    assertFalse(html.includes("<script>private()</script>"));
    assertFalse(html.includes(secret));
    const initial = boot(html);
    assertEquals(initial.authenticated, true);
    assertEquals(initial.available, true);
    assertEquals(initial.conversation?.id, conversation.id);
    assertEquals(initial.models, ["private-choice-model"]);
    assertEquals(initial.messages[0]?.text, "<script>private()</script>");
});

Deno.test("chat page stays readable when chat routes are not configured", async () => {
    const response = await createServerApp().request("/admin/chat");
    assertEquals(response.status, 200);
    const initial = boot(await response.text());
    assertEquals(initial.available, false);
    assertEquals(initial.messages, []);
});

Deno.test("chat SSR preserves the compact single-row composer before JavaScript loads", async () => {
    const response = await app().request("/admin/chat?id=test-chat", {
        headers: { authorization: `Bearer ${secret}` },
    });
    const html = await response.text();
    const composer = /<form\b[^>]*class="chat-composer"[^>]*>[\s\S]*?<\/form>/
        .exec(html)?.[0];
    assert(composer, "The no-JavaScript view includes the composer surface");
    assertStringIncludes(composer, 'class="chat-composer-input"');
    assertStringIncludes(composer, 'class="chat-composer-action-slot"');
    assertStringIncludes(composer, 'rows="1"');
    assertStringIncludes(composer, 'placeholder="发送消息给 Heimdall…"');
    assertStringIncludes(composer, 'aria-label="添加图片"');
    assertStringIncludes(composer, 'title="添加图片，最多 4 张，每张 5 MiB"');
    assertStringIncludes(composer, 'aria-label="发送消息"');
    assertStringIncludes(composer, 'aria-hidden="true" tabindex="-1" disabled');
    assertFalse(composer.includes("<select"));
    assertFalse(composer.includes("重新生成"));
    for (
        const [control] of composer.matchAll(
            /<(?:button|textarea|input)\b[^>]*>/g,
        )
    ) {
        assert(/\bdisabled(?:[\s=>]|$)/.test(control), control);
    }
    const header = /<header class="chat-header">[\s\S]*?<\/header>/
        .exec(html)?.[0];
    assert(header);
    assertStringIncludes(header, 'id="chat-model"');
    assertStringIncludes(header, "private-choice-model");
    assertStringIncludes(html, 'href="/admin/chat?id=test-chat"');
    assertStringIncludes(html, "已有会话仍可阅读");
    assertStringIncludes(html, "&lt;script&gt;private()&lt;/script&gt;");
});

Deno.test("chat SSR shows selected user and assistant versions and stored images without JavaScript", async () => {
    const assetId = "bd83bcca-c477-42e7-9ef7-09cf31b8c2d7";
    const messages: ChatMessage[] = [
        {
            id: "user-current",
            conversationId: conversation.id,
            role: "user",
            text: "",
            createdAt: conversation.createdAt,
            parentId: null,
            branch: {
                index: 1,
                count: 3,
                messageIds: ["user-before", "user-current", "user-after"],
            },
            attachments: [{ assetId, mediaType: "image/png" }],
        },
        {
            id: "assistant-current",
            conversationId: conversation.id,
            role: "assistant",
            text: "当前回复内容",
            createdAt: conversation.createdAt,
            parentId: "user-current",
            branch: {
                index: 1,
                count: 2,
                messageIds: ["assistant-before", "assistant-current"],
            },
        },
        {
            id: "single",
            conversationId: conversation.id,
            role: "user",
            text: "只有一个版本的提问",
            createdAt: conversation.createdAt,
            parentId: "assistant-current",
            branch: { index: 0, count: 1, messageIds: ["single"] },
        },
        {
            id: "plugin-call",
            conversationId: conversation.id,
            role: "assistant",
            callId: "call-1",
            name: "example-tool",
            text: "{}",
            createdAt: conversation.createdAt,
            parentId: "single",
            branch: {
                index: 1,
                count: 2,
                messageIds: ["plugin-old", "plugin-call"],
            },
        },
    ];
    const response = await app(messages).request("/admin/chat?id=test-chat", {
        headers: { authorization: `Bearer ${secret}` },
    });
    const html = await response.text();
    assertEquals(response.status, 200);
    assertStringIncludes(html, 'aria-label="第 2 个提问版本，共 3 个"');
    assertStringIncludes(html, 'aria-label="第 2 个回复版本，共 2 个"');
    const counters = [
        ...html.matchAll(
            /<span class="chat-branch-counter"[^>]*>([^<]*)<\/span>/g,
        ),
    ];
    assertEquals(counters.map((match) => match[1]), ["版本 2/3", "版本 2/2"]);
    assertStringIncludes(html, `src="/admin/chat/api/assets/${assetId}"`);
    assertStringIncludes(html, "当前回复内容");
    assertFalse(html.includes('aria-label="上一个提问版本"'));
    assertFalse(html.includes('aria-label="下一个回复版本"'));
    const initial = boot(html);
    assertEquals(initial.messages[0]?.branch, messages[0]!.branch);
    assertEquals(initial.messages[1]?.branch, messages[1]!.branch);
    assertEquals(initial.messages[0]?.attachments?.[0]?.assetId, assetId);
});
