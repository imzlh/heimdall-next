/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { assert, assertEquals } from "@std/assert";
import { render, useState } from "hono/jsx/dom";
import {
    Console,
    type ConsoleProps,
} from "@heimdall/core/web/client/console.tsx";
import { installTestDom, type TestElement } from "./helpers/jsx-dom.ts";

const initial: NonNullable<ConsoleProps["initial"]> = {
    health: {},
    models: [],
    authRequired: true,
    status: { sources: [], plugins: [], managed: [], presets: [] },
    errors: { health: "", models: "", source: "", status: "", presets: "" },
};

async function setup(desktop = false) {
    const dom = installTestDom();
    let href = "http://localhost/admin?view=settings";
    const visited: string[] = [];
    Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: {
            get href() {
                return href;
            },
        },
    });
    globalThis.history.pushState = (_state, _title, url) => {
        href = new URL(String(url), href).href;
        visited.push(href);
    };
    Object.defineProperties(dom.document, {
        querySelector: {
            value: (selector: string) =>
                dom.document.body.querySelector(selector),
        },
        querySelectorAll: {
            value: (selector: string) =>
                dom.document.body.querySelectorAll(selector),
        },
        getElementById: {
            value: (id: string) =>
                dom.document.body.querySelector(`[id="${id}"]`),
        },
    });
    dom.root.setAttribute("id", "admin-main");
    const nav = dom.document.createElement("nav");
    const links = ["settings", "channels", "logs"].map((view) => {
        const link = dom.document.createElement("a");
        link.setAttribute("class", "admin-nav-link");
        link.setAttribute("href", `/admin?view=${view}`);
        Object.defineProperty(link, "closest", { value: () => link });
        nav.appendChild(link);
        return link;
    });
    dom.document.body.appendChild(nav);
    let unmount = () => {};
    function App() {
        const [mounted, setMounted] = useState(true);
        unmount = () => setMounted(false);
        return mounted
            ? (
                <Console
                    initial={initial}
                    page="settings"
                    authenticated
                    desktop={desktop}
                />
            )
            : null;
    }
    await dom.act(() => render(<App />, dom.root as unknown as HTMLElement));
    return {
        ...dom,
        links,
        visited,
        async click(
            link: TestElement,
            modifiers: Record<string, unknown> = {},
        ) {
            const event = new Event("click", { cancelable: true });
            Object.defineProperties(
                event,
                Object.fromEntries(
                    Object.entries({ target: link, button: 0, ...modifiers })
                        .map(
                            ([key, value]) => [key, { value }],
                        ),
                ),
            );
            await dom.act(() => dom.document.dispatchEvent(event));
            return event;
        },
        async pop(url: string) {
            href = new URL(url, href).href;
            await dom.act(() =>
                globalThis.dispatchEvent(new Event("popstate"))
            );
        },
        async dispose() {
            await dom.act(unmount);
            dom.restore();
        },
    };
}

Deno.test("console navigation adds history and moves keyboard focus to the new page", async () => {
    const test = await setup();
    try {
        assertEquals(document.title, "Heimdall · 设置");
        const event = await test.click(test.links[1]!);
        assert(event.defaultPrevented);
        assertEquals(test.visited, ["http://localhost/admin?view=channels"]);
        assertEquals(document.title, "Heimdall · 渠道");
        assertEquals(test.links[1]!.getAttribute("aria-current"), "page");
        assertEquals(
            test.document.activeElement,
            test.root.querySelector("h1"),
        );
        await test.click(test.links[1]!);
        assertEquals(
            test.visited.length,
            1,
            "The same route must not add duplicate history",
        );
    } finally {
        await test.dispose();
    }
});

Deno.test("console restores page content, title and active navigation on history traversal", async () => {
    const test = await setup();
    try {
        await test.click(test.links[1]!);
        await test.click(test.links[2]!);
        await test.pop("/admin?view=settings");
        assertEquals(test.root.querySelector("h1")?.textContent, "设置");
        assertEquals(document.title, "Heimdall · 设置");
        assertEquals(test.links[0]!.getAttribute("aria-current"), "page");
        assertEquals(test.links[2]!.getAttribute("aria-current"), null);
        assertEquals(
            test.visited.length,
            2,
            "History traversal must not create a new entry",
        );
    } finally {
        await test.dispose();
    }
});

Deno.test("console leaves modified clicks and external targets to the browser", async () => {
    const test = await setup();
    try {
        assertEquals(
            (await test.click(test.links[1]!, { ctrlKey: true }))
                .defaultPrevented,
            false,
        );
        test.links[1]!.setAttribute("target", "_blank");
        assertEquals(
            (await test.click(test.links[1]!)).defaultPrevented,
            false,
        );
        test.links[2]!.setAttribute(
            "href",
            "https://example.com/admin?view=logs",
        );
        assertEquals(
            (await test.click(test.links[2]!)).defaultPrevented,
            false,
        );
        assertEquals(test.visited, []);
        assertEquals(test.root.querySelector("h1")?.textContent, "设置");
    } finally {
        await test.dispose();
    }
});

Deno.test("desktop console keeps its local session while browser console offers logout", async () => {
    for (const desktop of [false, true]) {
        const test = await setup(desktop);
        try {
            assertEquals(
                test.root.querySelector('button[aria-label="退出登录"]') !==
                    null,
                !desktop,
            );
        } finally {
            await test.dispose();
        }
    }
});
