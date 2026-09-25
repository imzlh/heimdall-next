import {
    assert,
    assertEquals,
    assertFalse,
    assertStringIncludes,
} from "@std/assert";
import { render } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import {
    createIconElement,
    Icon,
    type IconName,
    iconNode,
} from "../../src/web/shared/icons.tsx";
import { installTestDom } from "./helpers/jsx-dom.ts";

const svgNamespace = "http://www.w3.org/2000/svg";
const sharedAttributes = {
    xmlns: svgNamespace,
    viewBox: "0 0 24 24",
    stroke: "currentColor",
    "stroke-width": "1.7",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
};

function recordSvgCreations(
    document: ReturnType<typeof installTestDom>["document"],
) {
    const creations: { namespace: string; tag: string }[] = [];
    const createElementNS = document.createElementNS.bind(document);
    document.createElementNS = (namespace, tag) => {
        creations.push({ namespace, tag });
        return createElementNS(namespace, tag);
    };
    return creations;
}

function assertSvgAttributes(
    svg: Pick<Element, "getAttribute">,
    className = "icon",
    size = 18,
) {
    for (const [name, value] of Object.entries(sharedAttributes)) {
        assertEquals(svg.getAttribute(name), value, name);
    }
    assertEquals(svg.getAttribute("class"), className);
    assertEquals(svg.getAttribute("width"), String(size));
    assertEquals(svg.getAttribute("height"), String(size));
}

Deno.test("shared icons render decorative SVGs without replacing their button labels", () => {
    const names = [
        "plus",
        "close",
        "image",
        "send",
        "stop",
        "plugin",
        "settings",
        "sun",
        "moon",
        "check",
    ] satisfies IconName[];
    for (const name of names) {
        const html = (
            <button type="button" aria-label={`Action ${name}`}>
                <Icon name={name} />
            </button>
        ).toString();
        assertStringIncludes(html, `aria-label="Action ${name}"`);
        const svg = html.match(/<svg\b[^>]*>/)?.[0];
        assert(svg, name);
        for (const [attribute, value] of Object.entries(sharedAttributes)) {
            assertStringIncludes(svg, `${attribute}="${value}"`);
        }
        assertStringIncludes(svg, 'class="icon"');
        assertStringIncludes(svg, 'width="18"');
        assertStringIncludes(svg, 'height="18"');
        assertFalse(svg.includes("aria-label"));
        assert(iconNode(name).length > 0, `${name} has graphic nodes`);
        assertStringIncludes(html, "</svg></button>");
    }
});

Deno.test("shared icon SSR appends caller classes and applies the requested size", () => {
    const html = (<Icon name="plus" class="nav-icon selected" size={24} />)
        .toString();
    assertStringIncludes(html, 'class="icon nav-icon selected"');
    assertStringIncludes(html, 'width="24"');
    assertStringIncludes(html, 'height="24"');
    assertStringIncludes(html, 'viewBox="0 0 24 24"');
});

Deno.test("the SSR-compiled shared Icon renders and changes SVG node types in the DOM", async () => {
    const dom = installTestDom();
    const creations = recordSvgCreations(dom.document);
    const root = dom.root as unknown as HTMLElement;
    try {
        // This file and Icon use the default server JSX configuration. Rendering
        // those same nodes through Hono DOM catches an accidental SSR-only icon.
        await dom.act(() => render(<Icon name="image" />, root));
        const image = dom.root.querySelector("svg");
        assert(image);
        assertSvgAttributes(image);
        assertEquals(
            image.childNodes.map((node) => node.nodeName),
            ["RECT", "CIRCLE", "PATH"],
        );
        assertEquals(
            creations,
            ["svg", "rect", "circle", "path"].map(
                (tag) => ({ namespace: svgNamespace, tag }),
            ),
        );

        await dom.act(() =>
            render(<Icon name="close" class="dismiss-icon" size={20} />, root)
        );
        const close = dom.root.querySelector("svg");
        assert(close);
        assertEquals(dom.root.querySelectorAll("svg").length, 1);
        assertSvgAttributes(close, "icon dismiss-icon", 20);
        assertEquals(
            close.childNodes.map((node) => node.nodeName),
            ["PATH", "PATH"],
        );
        assertEquals(close.querySelectorAll("rect").length, 0);
        assertEquals(close.querySelectorAll("circle").length, 0);
        assertEquals(
            close.querySelectorAll("path").map((path) =>
                path.getAttribute("d")
            ),
            iconNode("close").map(([, attributes]) => String(attributes.d)),
        );
        assert(creations.every(({ namespace }) => namespace === svgNamespace));
    } finally {
        await dom.act(() => render(null, root));
        dom.restore();
    }
});

Deno.test("non-JSX icons use the supplied document and SVG namespace for every node", () => {
    const dom = installTestDom();
    const creations = recordSvgCreations(dom.document);
    const document = dom.document as unknown as Pick<
        Document,
        "createElementNS"
    >;
    // Retain only the explicit document; no global DOM remains installed.
    dom.restore();
    const image = createIconElement("image", document);
    assertSvgAttributes(image);
    assertEquals(
        Array.from(image.childNodes, (node) => node.nodeName),
        ["RECT", "CIRCLE", "PATH"],
    );
    assertEquals(
        creations,
        ["svg", "rect", "circle", "path"].map(
            (tag) => ({ namespace: svgNamespace, tag }),
        ),
    );

    const close = createIconElement("close", document, {
        class: "plugin-nav-icon",
        size: 22,
    });
    assertSvgAttributes(close, "icon plugin-nav-icon", 22);
    assertEquals(
        Array.from(close.childNodes, (node) => node.nodeName),
        ["PATH", "PATH"],
    );
    assert(creations.every(({ namespace }) => namespace === svgNamespace));
});
