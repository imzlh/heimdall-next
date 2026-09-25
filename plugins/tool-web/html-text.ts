/**
 * Reduce fetched HTML to bounded plain text a model can read. Pure and
 * network-free: script/style/head noise and their content go, tags are stripped,
 * a small set of common entities is decoded, whitespace is collapsed, and the
 * result is capped. Malformed markup degrades to best-effort text rather than
 * throwing, because the alternative is failing on a page a browser renders.
 */

/** Elements dropped together with everything inside them: code and machine data. */
const DROPPED_ELEMENTS = [
    "script",
    "style",
    "head",
    "noscript",
    "template",
    "svg",
];

/** Entity names that actually occur in prose; `nbsp` folds to an ordinary space. */
const NAMED_ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
};

/** A character reference: `&#NN;`, `&#xNN;`, or a short named entity. */
const ENTITY_PATTERN = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,10});/g;

/**
 * Remove script/style/head noise and tags, decode common entities, collapse
 * whitespace, and return at most `maxChars` characters.
 */
export function htmlToText(html: string, maxChars: number): string {
    if (typeof html !== "string" || html.length === 0) return "";
    let text = html.replace(/<!--[\s\S]*?-->/g, " ");
    for (const tag of DROPPED_ELEMENTS) {
        // `(?:</tag>|$)` also drops an unterminated element to end of input, as a
        // browser does, so its raw-text body never reaches the output as prose.
        text = text.replace(
            new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:</${tag}\\s*>|$)`, "gi"),
            " ",
        );
    }
    text = text.replace(/<[^>]+>/g, " ");
    text = decodeEntities(text);
    text = text.replace(/\s+/g, " ").trim();
    return truncate(text, maxChars);
}

/** First `<title>` text, decoded and trimmed, or undefined when absent or empty. */
export function extractTitle(html: string): string | undefined {
    if (typeof html !== "string") return undefined;
    const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
    if (!match) return undefined;
    const title = decodeEntities(match[1] ?? "").replace(/\s+/g, " ").trim();
    return title.length > 0 ? title : undefined;
}

/**
 * Decode character references, leaving anything unrecognised exactly as written:
 * inventing a character the page never wrote is worse than showing its source.
 */
function decodeEntities(text: string): string {
    if (!text.includes("&")) return text;
    return text.replace(ENTITY_PATTERN, (match, body: string) => {
        if (body.charCodeAt(0) === 0x23) {
            const hex = body.charCodeAt(1) === 0x78 ||
                body.charCodeAt(1) === 0x58;
            const code = Number.parseInt(
                body.slice(hex ? 2 : 1),
                hex ? 16 : 10,
            );
            if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) {
                return match;
            }
            if (code >= 0xd800 && code <= 0xdfff) return match; // lone surrogate
            try {
                return String.fromCodePoint(code);
            } catch {
                return match;
            }
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    });
}

/** Cut to `maxChars`, never splitting a surrogate pair. */
function truncate(text: string, maxChars: number): string {
    const limit = Number.isFinite(maxChars) ? Math.floor(maxChars) : 0;
    if (limit <= 0) return "";
    if (text.length <= limit) return text;
    let cut = limit;
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    return text.slice(0, cut).trimEnd();
}
