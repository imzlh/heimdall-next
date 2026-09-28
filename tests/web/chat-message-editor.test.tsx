/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { assert, assertEquals } from "@std/assert";
import { render } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import type { ChatMessage } from "@heimdall/admin-contracts/chat.ts";
import { MessageEditor } from "../../src/web/client/chat/message-editor.tsx";
import { installTestDom } from "./helpers/jsx-dom.ts";

const user: ChatMessage = {
    id: "user-1",
    conversationId: "conversation",
    parentId: null,
    role: "user",
    text: "原始提问",
    createdAt: "2026-09-27T00:00:00Z",
};

Deno.test("message editor preserves original branch, validates text and waits for durable save", async () => {
    const dom = installTestDom();
    const saved: string[] = [];
    let dismissals = 0;
    let finish: (saved: boolean) => void = () => {};
    const submission = new Promise<boolean>((resolve) => finish = resolve);
    try {
        await dom.act(() =>
            render(
                <MessageEditor
                    message={user}
                    pending={false}
                    error=""
                    onSubmit={(text) => {
                        saved.push(text);
                        return submission;
                    }}
                    onDismiss={() => dismissals++}
                />,
                dom.root as unknown as HTMLElement,
            )
        );
        const dialog = dom.root.querySelector("dialog");
        const input = dom.root.querySelector("textarea");
        const submit = dom.root.querySelector('button[type="submit"]');
        assert(dialog && input && submit);
        assert(dialog.open);
        assertEquals(dom.document.activeElement, input);
        assert(dom.root.textContent.includes("原消息及后续对话会保留"));
        assertEquals(submit.textContent, "保存并生成");
        assert(submit.disabled);
        assertEquals(input.value, user.text);

        input.value = "  ";
        await dom.act(() => input.dispatchEvent(new Event("input")));
        await dom.act(() => submit.click());
        assertEquals(saved, []);
        assertEquals(
            dom.root.querySelector('[role="alert"]')?.textContent,
            "请输入消息内容。",
        );
        assertEquals(input.getAttribute("aria-invalid"), "true");

        input.value = "新提问";
        await dom.act(() => input.dispatchEvent(new Event("input")));
        await dom.act(() => submit.click());
        assertEquals(saved, ["新提问"]);
        assertEquals(dismissals, 0);
        assert(submit.disabled);
        assert(input.disabled);
        assertEquals(dialog.getAttribute("aria-busy"), "true");
        await dom.act(() =>
            dialog.dispatchEvent(new Event("cancel", { cancelable: true }))
        );
        assertEquals(dismissals, 0);
        await dom.act(() => submit.click());
        assertEquals(saved.length, 1);
        await dom.act(() => finish(true));
        assertEquals(dismissals, 1);
        assertEquals(user.text, "原始提问");
    } finally {
        finish(false);
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        dom.restore();
    }
});

Deno.test("assistant message editing creates a new version and retains failed edits", async () => {
    const dom = installTestDom();
    const saved: string[] = [];
    let dismissals = 0;
    try {
        await dom.act(() =>
            render(
                <MessageEditor
                    message={{
                        ...user,
                        id: "assistant-1",
                        role: "assistant",
                        text: "原始回复",
                    }}
                    pending={false}
                    error=""
                    onSubmit={(text) => {
                        saved.push(text);
                        return Promise.reject(new Error("offline"));
                    }}
                    onDismiss={() => dismissals++}
                />,
                dom.root as unknown as HTMLElement,
            )
        );
        const input = dom.root.querySelector("textarea");
        const submit = dom.root.querySelector('button[type="submit"]');
        assert(input && submit);
        assertEquals(submit.textContent, "保存新版本");
        assert(dom.root.textContent.includes("保存为这条回复的新版本"));
        input.value = "手动修正的 **回复**";
        await dom.act(() => input.dispatchEvent(new Event("input")));
        await dom.act(() => submit.click());
        assertEquals(saved, ["手动修正的 **回复**"]);
        assertEquals(input.value, "手动修正的 **回复**");
        assertEquals(dismissals, 0);
        assertEquals(
            dom.root.querySelector('[role="alert"]')?.textContent,
            "保存失败，编辑内容已保留，请重试。",
        );
        assert(!submit.disabled);
        const close = dom.root.querySelector('button[aria-label="关闭编辑"]');
        assert(close);
        await dom.act(() => close.click());
        assertEquals(dismissals, 1);
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        dom.restore();
    }
});

Deno.test("message editor keyboard save respects IME composition", async () => {
    const dom = installTestDom();
    const saved: string[] = [];
    try {
        await dom.act(() =>
            render(
                <MessageEditor
                    message={user}
                    pending={false}
                    error=""
                    onSubmit={(text) => {
                        saved.push(text);
                        return Promise.resolve(false);
                    }}
                    onDismiss={() => {}}
                />,
                dom.root as unknown as HTMLElement,
            )
        );
        const input = dom.root.querySelector("textarea");
        assert(input);
        input.value = "输入法中的提问";
        await dom.act(() => input.dispatchEvent(new Event("input")));
        const key = (isComposing: boolean) => {
            const event = new Event("keydown", { cancelable: true });
            Object.assign(event, { key: "Enter", ctrlKey: true, isComposing });
            return event;
        };
        await dom.act(() => input.dispatchEvent(key(true)));
        assertEquals(saved, []);
        await dom.act(() => input.dispatchEvent(key(false)));
        assertEquals(saved, ["输入法中的提问"]);
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        dom.restore();
    }
});
