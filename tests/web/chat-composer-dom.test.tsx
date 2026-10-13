/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { render, useState } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import { ChatComposer } from "../../src/web/client/chat/composer.tsx";
import type {
    ChatController,
    ChatState,
} from "../../src/web/client/chat/types.ts";
import { installTestDom, type TestElement } from "./helpers/jsx-dom.ts";

function initialState(patch: Partial<ChatState>): ChatState {
    return {
        conversations: [],
        conversation: null,
        selectedId: "demo",
        messages: [],
        models: ["example"],
        model: "example",
        tools: [],
        draft: "existing draft",
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
        suggestions: [],
        pendingEffort: "medium",
        error: "",
        available: true,
        authenticated: true,
        ...patch,
    };
}

async function composer(patch: Partial<ChatState> = {}) {
    const dom = installTestDom();
    const drafts: string[] = [];
    const uploads: File[][] = [];
    let sends = 0;
    let current = initialState(patch);
    let update = (_patch: Partial<ChatState>) => {};
    // Only actions used by these rendered composer interactions are mocked.
    const controller = {
        setDraft(text: string) {
            drafts.push(text);
            update({ draft: text });
        },
        addAttachments(files: readonly File[]) {
            uploads.push([...files]);
            return Promise.resolve();
        },
        send() {
            sends++;
            return Promise.resolve();
        },
    } as ChatController;
    function Fixture() {
        const [state, setState] = useState(current);
        current = state;
        update = (next) => setState((value) => ({ ...value, ...next }));
        return <ChatComposer state={state} controller={controller} />;
    }
    try {
        await dom.act(() =>
            render(<Fixture />, dom.root as unknown as HTMLElement)
        );
    } catch (error) {
        dom.restore();
        throw error;
    }
    const input = dom.root.querySelector("textarea");
    const form = dom.root.querySelector("form");
    assert(input);
    assert(form);
    return {
        dom,
        input,
        form,
        drafts,
        uploads,
        get sends() {
            return sends;
        },
        get state() {
            return current;
        },
        update: (next: Partial<ChatState>) => dom.act(() => update(next)),
        async dispose() {
            await dom.act(() =>
                render(null, dom.root as unknown as HTMLElement)
            );
            dom.restore();
        },
    };
}

function transfer(files: File[], text = "", itemsOnly = false) {
    return {
        files: itemsOnly ? [] : files,
        items: [
            { kind: "string", getAsFile: () => null },
            ...files.map((file) => ({ kind: "file", getAsFile: () => file })),
        ],
        types: files.length ? ["Files", "text/plain"] : ["text/plain"],
        getData: (format: string) => format === "text/plain" ? text : "",
        dropEffect: "none",
    };
}

function event(type: string, fields: Record<string, unknown>) {
    return Object.assign(new Event(type, { cancelable: true }), fields);
}

function selection(input: TestElement, start: number, end = start) {
    const replacements: unknown[][] = [];
    // The small DOM helper has no native textarea selection/default editing.
    // This mock verifies the component's range-edit call and state handoff.
    const field = Object.assign(input, {
        selectionStart: start,
        selectionEnd: end,
        setRangeText(text: string, from: number, to: number, mode: string) {
            replacements.push([text, from, to, mode]);
            input.value = input.value.slice(0, from) + text +
                input.value.slice(to);
            field.selectionStart = field.selectionEnd = from + text.length;
        },
    });
    return { field, replacements };
}

Deno.test("composer image paste uploads the file while preserving the existing draft", async () => {
    const view = await composer();
    const file = new File(["image"], "clipboard.png", { type: "image/png" });
    try {
        const paste = event("paste", { clipboardData: transfer([file]) });
        await view.dom.act(() => view.input.dispatchEvent(paste));
        assert(paste.defaultPrevented);
        assertEquals(view.uploads.length, 1);
        assertStrictEquals(view.uploads[0]![0], file);
        assertEquals(view.input.value, "existing draft");
        assertEquals(view.drafts, []);
        assertStrictEquals(view.dom.document.activeElement, view.input);
    } finally {
        await view.dispose();
    }
});

Deno.test("composer mixed paste replaces the selection and reads files from transfer items", async () => {
    const view = await composer({ draft: "hello OLD world" });
    const file = new File(["image"], "clipboard.png", { type: "image/png" });
    try {
        const { field, replacements } = selection(view.input, 6, 9);
        const paste = event("paste", {
            clipboardData: transfer([file], "new\ncaption", true),
        });
        await view.dom.act(() => view.input.dispatchEvent(paste));
        assert(paste.defaultPrevented);
        assertEquals(replacements, [["new\ncaption", 6, 9, "end"]]);
        assertEquals(view.drafts, ["hello new\ncaption world"]);
        assertEquals(view.state.draft, "hello new\ncaption world");
        assertEquals(field.selectionStart, 17);
        assertEquals(field.selectionEnd, 17);
        assertEquals(view.uploads.length, 1);
        assertStrictEquals(view.uploads[0]![0], file);
    } finally {
        await view.dispose();
    }
});

Deno.test("composer leaves plain text paste available to the browser default action", async () => {
    const view = await composer();
    try {
        const paste = event("paste", {
            clipboardData: transfer([], "ordinary pasted text"),
        });
        await view.dom.act(() => view.input.dispatchEvent(paste));
        assertEquals(paste.defaultPrevented, false);
        assertEquals(view.uploads, []);
        assertEquals(view.drafts, []);
        // Native text insertion is not implemented by the test DOM.
    } finally {
        await view.dispose();
    }
});

for (const busy of ["sending", "attachmentsBusy"] as const) {
    Deno.test(`composer preserves pasted text but blocks every file entry while ${busy}`, async () => {
        const view = await composer({ [busy]: true, draft: "next: " });
        const file = new File(["image"], "clipboard.png", {
            type: "image/png",
        });
        try {
            assertEquals(view.input.disabled, false);
            selection(view.input, 6);
            const paste = event("paste", {
                clipboardData: transfer([file], "caption"),
            });
            await view.dom.act(() => view.input.dispatchEvent(paste));
            assert(paste.defaultPrevented);
            assertEquals(view.state.draft, "next: caption");
            const notice = view.dom.root.querySelector(
                '[id="chat-composer-notice"]',
            );
            assert(notice);
            assertEquals(notice.getAttribute("role"), "status");
            assertEquals(
                notice.textContent,
                busy === "sending"
                    ? "请等待当前回复完成后再添加图片"
                    : "图片正在上传，请稍后再添加",
            );
            const dataTransfer = transfer([file]);
            const drag = event("dragover", { dataTransfer });
            const drop = event("drop", { dataTransfer });
            await view.dom.act(() => {
                view.form.dispatchEvent(event("dragenter", { dataTransfer }));
                view.form.dispatchEvent(drag);
                view.form.dispatchEvent(drop);
            });
            assert(drag.defaultPrevented);
            assert(drop.defaultPrevented);
            assertEquals(dataTransfer.dropEffect, "none");
            assertEquals(view.form.getAttribute("data-dragging"), "false");
            const picker = view.dom.root.querySelector('input[type="file"]');
            assert(picker);
            assert(picker.disabled);
            Object.assign(picker, { files: [file], value: "picked.png" });
            // Hono maps onChange to input. Exercise a late queued picker event.
            await view.dom.act(() => picker.dispatchEvent(new Event("input")));
            assertEquals(picker.value, "");
            assertEquals(view.uploads, []);
            await view.update({ [busy]: false });
            assertEquals(
                view.dom.root.querySelector('[id="chat-composer-notice"]'),
                null,
            );
        } finally {
            await view.dispose();
        }
    });
}

Deno.test("composer file drops prevent navigation and clear nested drag highlighting", async () => {
    const view = await composer();
    const file = new File(["image"], "drop.png", { type: "image/png" });
    const dataTransfer = transfer([file]);
    try {
        await view.dom.act(() => {
            view.form.dispatchEvent(event("dragenter", { dataTransfer }));
            view.form.dispatchEvent(event("dragenter", { dataTransfer }));
            view.form.dispatchEvent(event("dragleave", { dataTransfer }));
        });
        assertEquals(view.form.getAttribute("data-dragging"), "true");
        const drag = event("dragover", { dataTransfer });
        await view.dom.act(() => view.form.dispatchEvent(drag));
        assert(drag.defaultPrevented);
        assertEquals(dataTransfer.dropEffect, "copy");
        const drop = event("drop", { dataTransfer });
        await view.dom.act(() => view.form.dispatchEvent(drop));
        assert(drop.defaultPrevented);
        assertEquals(view.form.getAttribute("data-dragging"), "false");
        assertEquals(view.uploads.length, 1);
        assertStrictEquals(view.uploads[0]![0], file);

        // A cancelled drag can end outside the composer without dragleave.
        for (const type of ["dragend", "drop", "blur"]) {
            await view.dom.act(() =>
                view.form.dispatchEvent(event("dragenter", { dataTransfer }))
            );
            assertEquals(view.form.getAttribute("data-dragging"), "true");
            await view.dom.act(() => globalThis.dispatchEvent(new Event(type)));
            assertEquals(view.form.getAttribute("data-dragging"), "false");
        }
        const unreadable = event("drop", {
            dataTransfer: { ...transfer([]), types: ["Files"] },
        });
        await view.dom.act(() => view.form.dispatchEvent(unreadable));
        assert(unreadable.defaultPrevented);
        assertEquals(view.uploads.length, 1);
    } finally {
        await view.dispose();
    }
});

Deno.test("composer prevents repeated Enter and leaves IME confirmation untouched", async () => {
    const view = await composer();
    const enter = { key: "Enter", keyCode: 13, isComposing: false };
    try {
        const repeated = event("keydown", { ...enter, repeat: true });
        await view.dom.act(() => view.input.dispatchEvent(repeated));
        assert(repeated.defaultPrevented);
        assertEquals(view.sends, 0);
        for (
            const fields of [
                { ...enter, isComposing: true },
                { ...enter, keyCode: 229 },
            ]
        ) {
            const confirmation = event("keydown", fields);
            await view.dom.act(() => view.input.dispatchEvent(confirmation));
            assertEquals(confirmation.defaultPrevented, false);
            assertEquals(view.sends, 0);
        }
        assertEquals(view.state.draft, "existing draft");
        assertEquals(view.drafts, []);
        const send = event("keydown", enter);
        await view.dom.act(() => view.input.dispatchEvent(send));
        assert(send.defaultPrevented);
        assertEquals(view.sends, 1);
        assertStrictEquals(view.dom.document.activeElement, view.input);
    } finally {
        await view.dispose();
    }
});

Deno.test("composer keeps the next draft editable while an active send creates or reloads history", async () => {
    for (const pending of ["creating", "loading"] as const) {
        const view = await composer({ sending: true, [pending]: true });
        try {
            assertEquals(view.input.disabled, false);
            await view.dom.act(() => {
                view.input.value = "next message";
                view.input.dispatchEvent(new Event("input"));
            });
            assertEquals(view.state.draft, "next message");
            const enter = event("keydown", { key: "Enter", keyCode: 13 });
            await view.dom.act(() => view.input.dispatchEvent(enter));
            assert(enter.defaultPrevented);
            assertEquals(view.sends, 0);
            assertEquals(view.state.draft, "next message");
            assert(
                view.dom.root.querySelector('[id="chat-composer-hint"]')
                    ?.textContent.includes("可继续编辑下一条消息"),
            );
            await view.update({ sending: false });
            assert(view.input.disabled);
        } finally {
            await view.dispose();
        }
    }
});

Deno.test("composer suggestions cannot replace the draft while history is loading", async () => {
    const view = await composer({
        loading: true,
        suggestions: ["Suggested next question"],
    });
    try {
        const suggestion = view.dom.root.querySelector(
            'button[class="chat-suggestion"]',
        );
        assert(suggestion);
        assert(suggestion.disabled);
        await view.dom.act(() => suggestion.click());
        assertEquals(view.drafts, []);
        assertEquals(view.state.draft, "existing draft");
        await view.update({ loading: false });
        assertEquals(suggestion.disabled, false);
        await view.dom.act(() => suggestion.click());
        assertEquals(view.state.draft, "Suggested next question");
        assertStrictEquals(view.dom.document.activeElement, view.input);
    } finally {
        await view.dispose();
    }
});
