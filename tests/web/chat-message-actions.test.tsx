/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { render } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import type {
    ChatAttachment,
    ChatMessage,
} from "@heimdall/admin-contracts/chat.ts";
import { ChatMessages } from "../../src/web/client/chat/messages.tsx";
import type { ChatState } from "../../src/web/client/chat/types.ts";
import { installTestDom, type TestElement } from "./helpers/jsx-dom.ts";

const asset = {
    assetId: "bd83bcca-c477-42e7-9ef7-09cf31b8c2d7",
    mediaType: "image/png",
    url: "/admin/chat/api/assets/bd83bcca-c477-42e7-9ef7-09cf31b8c2d7",
} satisfies ChatAttachment;

function message(
    id: string,
    role: ChatMessage["role"],
    patch: Partial<ChatMessage> = {},
): ChatMessage {
    return {
        id,
        conversationId: "conversation-1",
        parentId: null,
        role,
        text: `正文 ${id}`,
        createdAt: "2026-09-27T00:00:00.000Z",
        ...patch,
    };
}

function state(
    messages: ChatMessage[],
    patch: Partial<ChatState> = {},
): ChatState {
    return {
        conversations: [],
        conversation: null,
        selectedId: "conversation-1",
        messages,
        models: ["example"],
        model: "example",
        tools: [],
        draft: "",
        attachments: [],
        loading: false,
        creating: false,
        managing: false,
        sending: false,
        stopping: false,
        attachmentsBusy: false,
        streamText: "",
        toolCalls: [],
        streamReasoning: "",
        streamActivity: [],
        streamCitations: [],
        streamQuota: null,
        suggestions: [],
        pendingEffort: "medium",
        error: "",
        available: true,
        authenticated: true,
        ...patch,
    };
}

function button(root: TestElement, label: string): TestElement {
    const element = root.querySelector(`button[aria-label="${label}"]`);
    assert(element, `Missing button: ${label}`);
    return element;
}

function fixture() {
    const dom = installTestDom();
    const retried: string[] = [];
    const continued: string[] = [];
    const edited: ChatMessage[] = [];
    const forked: string[] = [];
    const switched: string[] = [];
    const referenced: ChatAttachment[] = [];
    const deleted: string[] = [];
    return {
        dom,
        retried,
        continued,
        edited,
        forked,
        switched,
        referenced,
        deleted,
        draw(current: ChatState) {
            return dom.act(() =>
                render(
                    <ChatMessages
                        state={current}
                        onRetry={(id) => retried.push(id)}
                        onContinue={(id) => continued.push(id)}
                        onEditMessage={(value) => edited.push(value)}
                        onForkMessage={(id) => forked.push(id)}
                        onSwitchBranch={(id) => switched.push(id)}
                        onReference={(value) => referenced.push(value)}
                        onDeleteMessage={(id) => deleted.push(id)}
                    />,
                    dom.root as unknown as HTMLElement,
                )
            );
        },
        async dispose() {
            await dom.act(() =>
                render(null, dom.root as unknown as HTMLElement)
            );
            dom.restore();
        },
    };
}

Deno.test("chat message actions regenerate historical and latest replies by their actual message IDs", async () => {
    const view = fixture();
    try {
        await view.draw(state([
            message("question-1", "user"),
            message("reply-1", "assistant", { parentId: "question-1" }),
            message("question-2", "user", { parentId: "reply-1" }),
            message("call-2", "assistant", {
                parentId: "question-2",
                callId: "plugin-call",
                name: "example-tool",
            }),
            message("result-2", "tool", {
                parentId: "call-2",
                callId: "plugin-call",
            }),
            message("reply-2", "assistant", { parentId: "result-2" }),
        ]));
        const retry = view.dom.root.querySelectorAll(
            'button[aria-label="重新生成这条回复"]',
        );
        assertEquals(retry.length, 2);
        for (const action of retry) await view.dom.act(() => action.click());
        assertEquals(view.retried, ["reply-1", "reply-2"]);
        const articles = view.dom.root.querySelectorAll("article");
        for (const index of [3, 4]) {
            const article = articles[index]!;
            assertEquals(
                article.querySelector('button[aria-label="重新生成这条回复"]'),
                null,
            );
            assertEquals(
                article.querySelector(
                    'button[aria-label="编辑消息并新建分支"]',
                ),
                null,
            );
        }
    } finally {
        await view.dispose();
    }
});

Deno.test("chat continues only the final assistant message when it has content", async () => {
    const view = fixture();
    try {
        await view.draw(state([
            message("question", "user"),
            message("historical-reply", "assistant"),
            message("partial-reply", "assistant", { status: "stopped" }),
        ]));
        const actions = view.dom.root.querySelectorAll(
            'button[aria-label="继续生成这条回复"]',
        );
        assertEquals(actions.length, 1);
        await view.dom.act(() => actions[0]!.click());
        assertEquals(view.continued, ["partial-reply"]);
        for (
            const last of [
                message("empty", "assistant", { text: "" }),
                message("blank", "assistant", { text: " \n " }),
                message("question-2", "user"),
                message("call", "assistant", { callId: "plugin-call" }),
                message("result", "tool"),
            ]
        ) {
            await view.draw(state([
                message("historical-reply", "assistant"),
                last,
            ]));
            assertEquals(
                view.dom.root.querySelector(
                    'button[aria-label="继续生成这条回复"]',
                ),
                null,
                `Unexpected continue action for ${last.id}`,
            );
        }
    } finally {
        await view.dispose();
    }
});

Deno.test("chat edit, fork and delete target the selected user or assistant instead of the latest message", async () => {
    const view = fixture();
    const messages = [
        message("question-1", "user"),
        message("reply-1", "assistant"),
        message("question-2", "user"),
        message("reply-2", "assistant"),
    ];
    try {
        await view.draw(state(messages));
        const articles = view.dom.root.querySelectorAll("article");
        for (let index = 0; index < messages.length; index++) {
            const article = articles[index]!;
            await view.dom.act(() =>
                button(article, "编辑消息并新建分支").click()
            );
            assertStrictEquals(view.edited[index], messages[index]);
            await view.dom.act(() =>
                button(article, "从此处创建新会话").click()
            );
            await view.dom.act(() =>
                button(
                    article,
                    `删除这条${
                        messages[index]!.role === "user" ? "提问" : "回复"
                    }`,
                ).click()
            );
        }
        assertEquals(view.forked, messages.map((value) => value.id));
        assertEquals(view.deleted, messages.map((value) => value.id));
    } finally {
        await view.dispose();
    }
});

Deno.test("chat version arrows choose actual sibling IDs and disable first and last boundaries", async () => {
    const view = fixture();
    try {
        for (const role of ["user", "assistant"] as const) {
            const noun = role === "user" ? "提问" : "回复";
            const ids = [`${role}-old`, `${role}-current`, `${role}-new`];
            for (let index = 0; index < ids.length; index++) {
                await view.draw(state([
                    message(ids[index]!, role, {
                        branch: { index, count: 3, messageIds: ids },
                    }),
                ]));
                const previous = button(
                    view.dom.root,
                    `上一个${noun}版本`,
                );
                const next = button(view.dom.root, `下一个${noun}版本`);
                assertEquals(
                    view.dom.root.querySelector(
                        `[aria-label="第 ${index + 1} 个${noun}版本，共 3 个"]`,
                    )?.textContent,
                    `${index + 1}/3`,
                );
                assertEquals(previous.disabled, index === 0);
                assertEquals(next.disabled, index === ids.length - 1);
                const before = view.switched.length;
                await view.dom.act(() => previous.click());
                await view.dom.act(() => next.click());
                assertEquals(
                    view.switched.slice(before),
                    [ids[index - 1], ids[index + 1]].filter((id) =>
                        id !== undefined
                    ),
                );
            }
        }
    } finally {
        await view.dispose();
    }
});

Deno.test("chat history remains editable and forkable when its former model is unavailable, but generation is disabled", async () => {
    const view = fixture();
    const question = message("question", "user");
    const reply = message("reply", "assistant");
    try {
        await view.draw(state([question, reply], { model: "removed-model" }));
        const userArticle = view.dom.root.querySelector(
            'article[data-message-id="question"]',
        );
        const assistantArticle = view.dom.root.querySelector(
            'article[data-message-id="reply"]',
        );
        assert(userArticle);
        assert(assistantArticle);
        assertEquals(
            button(userArticle, "编辑消息并新建分支").disabled,
            true,
        );
        assertEquals(
            button(assistantArticle, "重新生成这条回复").disabled,
            true,
        );
        assertEquals(
            button(assistantArticle, "继续生成这条回复").disabled,
            true,
        );
        const editReply = button(assistantArticle, "编辑消息并新建分支");
        const forkQuestion = button(userArticle, "从此处创建新会话");
        assertEquals(editReply.disabled, false);
        assertEquals(forkQuestion.disabled, false);
        await view.dom.act(() => editReply.click());
        await view.dom.act(() => forkQuestion.click());
        assertStrictEquals(view.edited[0], reply);
        assertEquals(view.forked, [question.id]);
    } finally {
        await view.dispose();
    }
});

Deno.test("chat busy operations disable every message mutation while preserving whole-message copy", async () => {
    const view = fixture();
    const copied: string[] = [];
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            clipboard: {
                writeText(text: string) {
                    copied.push(text);
                    return Promise.resolve();
                },
            },
        },
    });
    try {
        for (
            const busy of [
                "sending",
                "loading",
                "creating",
                "managing",
                "attachmentsBusy",
            ] as const
        ) {
            const reply = message(`reply-${busy}`, "assistant", {
                text: `**原始 Markdown ${busy}**`,
                branch: {
                    index: 1,
                    count: 3,
                    messageIds: ["old", `reply-${busy}`, "new"],
                },
                attachments: [asset],
            });
            await view.draw(state([reply], { [busy]: true }));
            const article = view.dom.root.querySelectorAll("article")[0]!;
            const mutations = [
                "重新生成这条回复",
                "继续生成这条回复",
                "编辑消息并新建分支",
                "从此处创建新会话",
                "删除这条回复",
                "上一个回复版本",
                "下一个回复版本",
                "将第 1 张图片作为参考图",
            ];
            for (const label of mutations) {
                const action = button(article, label);
                assertEquals(action.disabled, true, `${busy}: ${label}`);
                await view.dom.act(() => action.click());
            }
            const copy = button(article, "复制消息");
            assertEquals(copy.disabled, false);
            await view.dom.act(() => copy.click());
            assertEquals(copied.at(-1), reply.text);
        }
        assertEquals(view.retried, []);
        assertEquals(view.continued, []);
        assertEquals(view.edited, []);
        assertEquals(view.forked, []);
        assertEquals(view.switched, []);
        assertEquals(view.referenced, []);
        assertEquals(view.deleted, []);
        assertEquals(copied.length, 5);
    } finally {
        await view.dispose();
        if (original) Object.defineProperty(globalThis, "navigator", original);
        else Reflect.deleteProperty(globalThis, "navigator");
    }
});

Deno.test("chat reference-image action passes stored attachment identity without converting inline history", async () => {
    const view = fixture();
    const legacy: ChatAttachment = {
        mediaType: "image/png",
        dataBase64: "YQ==",
    };
    try {
        await view.draw(state([
            message("images", "assistant", {
                attachments: [legacy, asset],
            }),
        ]));
        const images = view.dom.root.querySelectorAll("img");
        assertEquals(images.map((image) => image.getAttribute("src")), [
            "data:image/png;base64,YQ==",
            "/admin/chat/api/assets/bd83bcca-c477-42e7-9ef7-09cf31b8c2d7",
        ]);
        assertEquals(
            view.dom.root.querySelector(
                'button[aria-label="将第 1 张图片作为参考图"]',
            ),
            null,
        );
        await view.dom.act(() =>
            button(view.dom.root, "将第 2 张图片作为参考图").click()
        );
        assertEquals(view.referenced.length, 1);
        assertStrictEquals(view.referenced[0], asset);
    } finally {
        await view.dispose();
    }
});

Deno.test("chat attachment rendering derives local image routes from validated asset IDs instead of trusting URLs", async () => {
    const view = fixture();
    try {
        const attachments: ChatAttachment[] = [
            { ...asset, url: "javascript:alert(1)" },
            { ...asset, url: "https://untrusted.example/tracker.png" },
            { ...asset, assetId: "../../secret" },
            { ...asset, assetId: "%2e%2e%2fsecret" },
            { ...asset, mediaType: "image/svg+xml" },
        ];
        await view.draw(state([
            message("untrusted-images", "assistant", { attachments }),
        ]));
        assertEquals(
            view.dom.root.querySelectorAll("img").map((image) =>
                image.getAttribute("src")
            ),
            [asset.url, asset.url],
        );
        for (const index of [3, 4, 5]) {
            assertEquals(
                view.dom.root.querySelector(
                    `button[aria-label="将第 ${index} 张图片作为参考图"]`,
                ),
                null,
            );
        }
        assertEquals(view.referenced, []);
    } finally {
        await view.dispose();
    }
});
