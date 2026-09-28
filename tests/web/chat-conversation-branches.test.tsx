/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { assert, assertEquals } from "@std/assert";
import { render, useState } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import { ConversationBranches } from "../../src/web/client/chat/conversation-branches.tsx";
import { installTestDom } from "./helpers/jsx-dom.ts";

const branches = [
    { messageId: "remaining-user-root", label: "后续提问", selected: true },
    {
        messageId: "remaining-assistant-root",
        label: "保留的回复",
        selected: false,
    },
    {
        messageId: "edited-root",
        label: "另一版提问 <script>bad()</script>",
        selected: false,
    },
];

Deno.test("conversation branch menu reaches every surviving path including roots absent from inline version pagers", async () => {
    const dom = installTestDom();
    const selected: string[] = [];
    try {
        await dom.act(() =>
            render(
                <ConversationBranches
                    branches={branches}
                    disabled={false}
                    onSelectBranch={(messageId) => selected.push(messageId)}
                />,
                dom.root as unknown as HTMLElement,
            )
        );
        const trigger = dom.root.querySelector(
            'button[data-dropdown="chat-conversation-branches"]',
        );
        assert(trigger);
        assertEquals(trigger.getAttribute("aria-label"), "历史分支");
        assertEquals(trigger.getAttribute("data-value"), "remaining-user-root");
        for (const branch of branches.slice(1)) {
            await dom.act(() => trigger.click());
            const options = dom.root.querySelectorAll('button[role="option"]');
            assertEquals(options.length, 3);
            assertEquals(
                options.map((option) => option.getAttribute("data-value")),
                branches.map((entry) => entry.messageId),
            );
            assert(options[0]!.disabled);
            assertEquals(options[0]!.getAttribute("aria-selected"), "true");
            const target = options.find((option) =>
                option.getAttribute("data-value") === branch.messageId
            );
            assert(target);
            await dom.act(() => target.click());
            assertEquals(trigger.getAttribute("aria-expanded"), "false");
        }
        assertEquals(selected, ["remaining-assistant-root", "edited-root"]);
        await dom.act(() => trigger.click());
        assert(
            dom.root.textContent.includes("另一版提问 <script>bad()</script>"),
        );
        assertEquals(dom.root.querySelector("script"), null);
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        dom.restore();
    }
});

Deno.test("conversation branch menu disables already-open options while a mutation is in progress", async () => {
    const dom = installTestDom();
    const selected: string[] = [];
    let update: (disabled: boolean) => void = () => {};
    function Fixture() {
        const [disabled, setDisabled] = useState(false);
        update = setDisabled;
        return (
            <ConversationBranches
                branches={branches}
                disabled={disabled}
                onSelectBranch={(messageId) => selected.push(messageId)}
            />
        );
    }
    try {
        await dom.act(() =>
            render(<Fixture />, dom.root as unknown as HTMLElement)
        );
        const trigger = dom.root.querySelector(
            'button[data-dropdown="chat-conversation-branches"]',
        );
        assert(trigger);
        await dom.act(() => trigger.click());
        await dom.act(() => update(true));
        assert(trigger.disabled);
        const options = dom.root.querySelectorAll('button[role="option"]');
        assertEquals(options.length, 3);
        for (const option of options) {
            assert(option.disabled);
            await dom.act(() => option.click());
        }
        assertEquals(selected, []);
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        dom.restore();
    }
});

Deno.test("conversation branch menu stays absent for a single path", async () => {
    const dom = installTestDom();
    try {
        for (const value of [undefined, [], [branches[0]!]]) {
            await dom.act(() =>
                render(
                    <ConversationBranches
                        branches={value}
                        disabled={false}
                        onSelectBranch={() => {}}
                    />,
                    dom.root as unknown as HTMLElement,
                )
            );
            assertEquals(dom.root.querySelector("button"), null);
        }
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        dom.restore();
    }
});
