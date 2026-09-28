import { Lexer, type Token, type Tokens } from "marked";
import { decodeHTML } from "entities";

/**
 * Marked owns Markdown syntax; the host owns the renderable vocabulary. Only
 * this data crosses the SSR/island boundary, never library-produced HTML.
 */
export type MarkdownInline =
    | { kind: "text"; text: string }
    | { kind: "code"; text: string }
    | { kind: "break" }
    | { kind: "strong" | "em" | "del"; children: MarkdownInline[] }
    | { kind: "link"; href: string; children: MarkdownInline[] };

export type MarkdownBlock =
    | { kind: "paragraph"; children: MarkdownInline[] }
    | { kind: "heading"; level: number; children: MarkdownInline[] }
    | { kind: "code"; language: string; text: string }
    | { kind: "quote"; children: MarkdownBlock[] }
    | {
        kind: "list";
        start?: number;
        items: { blocks: MarkdownBlock[]; checked?: boolean }[];
    }
    | {
        kind: "table";
        align: ("left" | "center" | "right")[];
        header: MarkdownInline[][];
        rows: MarkdownInline[][][];
    }
    | { kind: "rule" };

/** Explicit schemes only; browsers must never infer a dangerous relative URL. */
export function markdownLink(raw: string): string | undefined {
    if (!raw || /[\s\\]/u.test(raw)) return;
    for (const char of raw) {
        const code = char.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) return;
    }
    if (!/^(?:https?:\/\/|mailto:)/i.test(raw)) return;
    try {
        const url = new URL(raw);
        if (url.protocol === "http:" || url.protocol === "https:") {
            if (!url.hostname || url.username || url.password) return;
        } else if (url.protocol !== "mailto:" || !url.pathname) return;
        return raw;
    } catch {
        return;
    }
}

const plain = (text: string): MarkdownInline => ({ kind: "text", text });
const paragraph = (text: string): MarkdownBlock => ({
    kind: "paragraph",
    children: [plain(text)],
});
const MAX_DEPTH = 24;

function inline(
    tokens: Token[],
    depth: number,
    links = true,
): MarkdownInline[] {
    if (depth > MAX_DEPTH) {
        return [plain(tokens.map((token) => token.raw).join(""))];
    }
    return tokens.flatMap((token): MarkdownInline[] => {
        switch (token.type) {
            case "br":
                return [{ kind: "break" }];
            case "codespan":
                return [{
                    kind: "code",
                    text: (token as Tokens.Codespan).text,
                }];
            case "strong":
            case "em":
            case "del":
                return [{
                    kind: token.type,
                    children: inline(
                        (token as Tokens.Strong).tokens,
                        depth + 1,
                        links,
                    ),
                }];
            case "link": {
                const link = token as Tokens.Link;
                const href = links
                    ? markdownLink(decodeHTML(link.href))
                    : undefined;
                return href
                    ? [{
                        kind: "link",
                        href,
                        children: inline(link.tokens, depth + 1, false),
                    }]
                    : [plain(link.raw)];
            }
            case "text": {
                const text = token as Tokens.Text;
                return text.tokens
                    ? inline(text.tokens, depth + 1, links)
                    : [plain(decodeHTML(text.text))];
            }
            case "escape":
                return [plain((token as Tokens.Escape).text)];
            // HTML remains visible text. Markdown images retain their source
            // notation, without loading remote or data URL resources.
            default:
                return [plain(token.raw)];
        }
    });
}

function blocks(tokens: Token[], depth = 0): MarkdownBlock[] {
    if (depth > MAX_DEPTH) {
        return [paragraph(tokens.map((token) => token.raw).join(""))];
    }
    return tokens.flatMap((token): MarkdownBlock[] => {
        switch (token.type) {
            case "space":
            case "def":
                return [];
            case "hr":
                return [{ kind: "rule" }];
            case "paragraph":
            case "text": {
                const text = token as Tokens.Paragraph | Tokens.Text;
                return [{
                    kind: "paragraph",
                    children: text.tokens
                        ? inline(text.tokens, depth + 1)
                        : [plain(text.text)],
                }];
            }
            case "heading": {
                const heading = token as Tokens.Heading;
                return [{
                    kind: "heading",
                    level: Math.min(6, Math.max(1, heading.depth)),
                    children: inline(heading.tokens, depth + 1),
                }];
            }
            case "code": {
                const code = token as Tokens.Code;
                const requested = code.lang?.trim().split(/\s/, 1)[0] ?? "";
                return [{
                    kind: "code",
                    language: /^[\w.+#-]{1,32}$/.test(requested)
                        ? requested
                        : "text",
                    text: code.text,
                }];
            }
            case "blockquote":
                return [{
                    kind: "quote",
                    children: blocks(
                        (token as Tokens.Blockquote).tokens,
                        depth + 1,
                    ),
                }];
            case "list": {
                const list = token as Tokens.List;
                return [{
                    kind: "list",
                    start: list.ordered ? Number(list.start) : undefined,
                    items: list.items.map((item) => ({
                        blocks: blocks(item.tokens, depth + 1),
                        checked: item.task ? Boolean(item.checked) : undefined,
                    })),
                }];
            }
            case "table": {
                const table = token as Tokens.Table;
                return [{
                    kind: "table",
                    align: table.align.map((align) => align ?? "left"),
                    header: table.header.map((cell) =>
                        inline(cell.tokens, depth + 1)
                    ),
                    rows: table.rows.map((row) =>
                        row.map((cell) => inline(cell.tokens, depth + 1))
                    ),
                }];
            }
            default:
                return [paragraph(token.raw)];
        }
    });
}

export function parseChatMarkdown(text: string): MarkdownBlock[] {
    if (!text) return [];
    // Preserve unusually large replies as text rather than blocking a stream on
    // Markdown work. There is no truncation or hidden content in this fallback.
    if (text.length > 100_000) return [paragraph(text)];
    // Unmatched runs of emphasis markers can make even a mature lexer expensive.
    // Apply the budget before lexing, including on short but very dense input.
    const emphasisMarkers = text.match(/[*_~]/g)?.length ?? 0;
    if (
        emphasisMarkers > 1_000 ||
        (emphasisMarkers > 500 && emphasisMarkers / text.length > .1)
    ) return [paragraph(text)];
    try {
        return blocks(Lexer.lex(text, { gfm: true, breaks: true }));
    } catch {
        return [paragraph(text)];
    }
}

export interface ChatCitationItem {
    readonly verb: string;
    readonly index: string;
    /** Full marker id (e.g. `turn1search42`) tying the badge to its source. */
    readonly id: string;
}

export type ChatCitationPart =
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "cites"; readonly items: readonly ChatCitationItem[] };

/**
 * One citation run: a single `cite` prefix followed by one or more
 * `turn<round><verb><index>` entries, e.g. `citeturn1search1turn1search6`.
 */
const CITATION_RUN = /cite(?:turn(\d+)([a-z]+)(\d+))+/g;
const CITATION_ENTRY = /turn(\d+)([a-z]+)(\d+)/g;

const CITATION_VERBS: Record<string, string> = {
    search: "检索",
    browser: "浏览",
    fetch: "抓取",
    files: "文件",
};

function chatCitationVerb(verb: string): string {
    return CITATION_VERBS[verb] ?? verb;
}

/** "检索 1 · 6" for one verb, "检索 1 · 浏览 2" when the run mixes verbs. */
export function chatCitationLabel(items: readonly ChatCitationItem[]): string {
    const verbs = new Set(items.map((item) => item.verb));
    if (verbs.size === 1) {
        const verb = items[0]?.verb ?? "";
        return `${chatCitationVerb(verb)} ${
            items.map((item) => item.index).join(" · ")
        }`;
    }
    return items.map((item) => `${chatCitationVerb(item.verb)} ${item.index}`)
        .join(" · ");
}

export function chatCitationAria(items: readonly ChatCitationItem[]): string {
    return `引用${
        items.map((item) => `${chatCitationVerb(item.verb)}结果 ${item.index}`)
            .join("、")
    }`;
}

/**
 * Upstream citation markers arrive as plain text. Split each `cite…` run into
 * a renderable badge; surrounding whitespace belongs to the prose, never the
 * badge.
 */
export function splitChatCitations(
    text: string,
): readonly ChatCitationPart[] {
    if (!text.includes("cite")) return [{ kind: "text", text }];
    const parts: ChatCitationPart[] = [];
    const pushText = (value: string) => {
        if (value) parts.push({ kind: "text", text: value });
    };
    let cursor = 0;
    for (const run of text.matchAll(CITATION_RUN)) {
        const start = run.index ?? 0;
        pushText(text.slice(cursor, start).replace(/\s+$/, ""));
        parts.push({
            kind: "cites",
            items: [...run[0].matchAll(CITATION_ENTRY)].map((entry) => ({
                verb: entry[2] ?? "",
                index: entry[3] ?? "",
                id: entry[0],
            })),
        });
        cursor = start + run[0].length;
    }
    pushText(text.slice(cursor));
    return parts;
}
