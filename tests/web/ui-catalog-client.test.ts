import { assertEquals, assertRejects } from "@std/assert";
import {
    EMPTY_UI_CATALOG,
    UI_CATALOG_LIMITS,
} from "@heimdall/admin-contracts/ui-catalog.ts";
import type { UiContribution } from "@heimdall/admin-contracts/ui.ts";
import { loadUiCatalog } from "@heimdall/core/web/client/ui-catalog.ts";
import { syncPluginNavigation } from "@heimdall/core/web/client/plugin-navigation.ts";

async function withFetch(
    fetcher: typeof fetch,
    run: () => Promise<void>,
) {
    const previous = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
        await run();
    } finally {
        globalThis.fetch = previous;
    }
}

Deno.test("browser UI catalog refresh uses the web session and validates returned JSON", async () => {
    await withFetch((input, init) => {
        assertEquals(input, "/admin/ui/catalog");
        assertEquals(init?.credentials, "same-origin");
        assertEquals(init?.cache, "no-store");
        assertEquals([...new Headers(init?.headers)], [[
            "accept",
            "application/json",
        ]]);
        return Promise.resolve(Response.json(EMPTY_UI_CATALOG));
    }, async () => {
        assertEquals(await loadUiCatalog(), EMPTY_UI_CATALOG);
    });
    for (
        const response of [
            () => Response.json({}, { status: 401 }),
            () =>
                Response.json({
                    contributions: [],
                    schemas: {},
                    sourcePluginIds: { a: "invalid/owner" },
                }),
            () => new Response("{invalid"),
        ]
    ) {
        await withFetch(() => Promise.resolve(response()), async () => {
            await assertRejects(loadUiCatalog);
        });
    }
});

Deno.test("browser UI catalog cancels oversized streams before parsing", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array(UI_CATALOG_LIMITS.bytes + 1));
        },
        cancel() {
            cancelled = true;
        },
    });
    await withFetch(() => Promise.resolve(new Response(stream)), async () => {
        await assertRejects(loadUiCatalog, Error, "插件目录超出大小限制");
    });
    assertEquals(cancelled, true);
});

class NavigationElement {
    readonly dataset: Record<string, string> = {};
    readonly attributes: Record<string, string> = {};
    hidden = false;
    href = "";
    className = "";
    textContent = "";
    children: NavigationElement[] = [];
    replacements = 0;
    constructor(readonly tag = "div", readonly namespace?: string) {}
    setAttribute(name: string, value: string) {
        this.attributes[name] = value;
    }
    append(...nodes: NavigationElement[]) {
        this.children.push(...nodes);
    }
    appendChild(node: NavigationElement) {
        this.append(node);
        return node;
    }
    replaceChildren(...nodes: NavigationElement[]) {
        this.children = nodes;
        this.replacements++;
    }
}

Deno.test("plugin navigation refresh adds and removes only plugin links and preserves unchanged nodes", () => {
    const region = new NavigationElement();
    const document = {
        querySelector(selector: string) {
            assertEquals(selector, "[data-plugin-navigation]");
            return region;
        },
        createElement(tag: string) {
            return new NavigationElement(tag);
        },
        createElementNS(namespace: string, tag: string) {
            return new NavigationElement(tag, namespace);
        },
    } as unknown as Pick<
        Document,
        "querySelector" | "createElement" | "createElementNS"
    >;
    const tab: UiContribution = {
        id: "page",
        pluginId: "sample",
        slot: "nav.tab",
        title: "<img onerror=alert(1)>",
        schema: { blocks: [{ kind: "text", text: "内容" }] },
    };
    syncPluginNavigation(
        [tab, { ...tab, id: "card", slot: "dashboard.widget" }],
        "sample:page",
        document,
    );
    assertEquals(region.children.length, 1);
    const link = region.children[0]!;
    assertEquals(link.href, "/admin?view=plugin&tab=sample%3Apage");
    assertEquals(link.attributes["aria-current"], "page");
    assertEquals(link.className, "admin-nav-link active");
    assertEquals(link.children[0]?.tag, "svg");
    assertEquals(link.children[0]?.namespace, "http://www.w3.org/2000/svg");
    assertEquals(link.children[0]?.attributes["aria-hidden"], "true");
    assertEquals(link.children[1]?.textContent, tab.title);
    assertEquals(region.hidden, false);
    syncPluginNavigation([{ ...tab }], "sample:page", document);
    assertEquals(region.replacements, 1);
    assertEquals(region.children[0], link);
    syncPluginNavigation([], "sample:page", document);
    assertEquals(region.children, []);
    assertEquals(region.hidden, true);
});
