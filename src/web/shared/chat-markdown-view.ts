import type { MarkdownBlock, MarkdownInline } from "./chat-markdown.ts";

/** Only host-chosen tags/attributes are emitted. Each runtime owns its JSX. */
export interface MarkdownRenderer<Node> {
    text(value: string): Node;
    element(
        tag: string,
        props: Record<string, string | number>,
        children: Node[],
    ): Node;
    code(block: Extract<MarkdownBlock, { kind: "code" }>, key: string): Node;
}

export function renderChatMarkdown<Node>(
    blocks: MarkdownBlock[],
    renderer: MarkdownRenderer<Node>,
): Node[] {
    const el = renderer.element;
    const inline = (nodes: MarkdownInline[]): Node[] =>
        nodes.map((node) => {
            if (node.kind === "text") return renderer.text(node.text);
            if (node.kind === "break") return el("br", {}, []);
            if (node.kind === "code") {
                return el("code", { class: "chat-inline-code" }, [
                    renderer.text(node.text),
                ]);
            }
            if (node.kind === "link") {
                return el("a", {
                    href: node.href,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    referrerpolicy: "no-referrer",
                }, inline(node.children));
            }
            return el(node.kind, {}, inline(node.children));
        });
    const render = (items: MarkdownBlock[], path: string): Node[] =>
        items.map((block, index) => {
            const key = `${path}-${index}`;
            switch (block.kind) {
                case "paragraph":
                    return el("p", { key }, inline(block.children));
                case "heading":
                    return el(
                        `h${block.level}`,
                        { key },
                        inline(block.children),
                    );
                case "rule":
                    return el("hr", { key }, []);
                case "code":
                    return renderer.code(block, key);
                case "quote":
                    return el(
                        "blockquote",
                        { key },
                        render(block.children, key),
                    );
                case "list":
                    return el(
                        block.start === undefined ? "ul" : "ol",
                        block.start === undefined
                            ? { key }
                            : { key, start: block.start },
                        block.items.map((item, itemIndex) =>
                            el(
                                "li",
                                {
                                    key: `${key}-${itemIndex}`,
                                    class: item.checked === undefined
                                        ? ""
                                        : "chat-task-item",
                                },
                                [
                                    ...(item.checked === undefined ? [] : [el(
                                        "span",
                                        {
                                            class: "chat-task-state",
                                            role: "img",
                                            "aria-label": item.checked
                                                ? "已完成"
                                                : "未完成",
                                        },
                                        [renderer.text(
                                            item.checked ? "☑" : "☐",
                                        )],
                                    )]),
                                    ...render(
                                        item.blocks,
                                        `${key}-${itemIndex}`,
                                    ),
                                ],
                            )
                        ),
                    );
                case "table":
                    return el("div", {
                        key,
                        class: "chat-table-scroll",
                        role: "region",
                        "aria-label": "消息表格",
                        tabindex: 0,
                    }, [el("table", {}, [
                        el("thead", {}, [
                            el(
                                "tr",
                                {},
                                block.header.map((cell, column) =>
                                    el("th", {
                                        scope: "col",
                                        class: `chat-align-${
                                            block.align[column]
                                        }`,
                                    }, inline(cell))
                                ),
                            ),
                        ]),
                        el(
                            "tbody",
                            {},
                            block.rows.map((row, rowIndex) =>
                                el(
                                    "tr",
                                    { key: rowIndex },
                                    row.map((cell, column) =>
                                        el("td", {
                                            class: `chat-align-${
                                                block.align[column]
                                            }`,
                                        }, inline(cell))
                                    ),
                                )
                            ),
                        ),
                    ])]);
            }
        });
    return render(blocks, "md");
}
