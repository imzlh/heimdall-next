/**
 * HTTPS-only, host-gated page fetch for the assistant. The gate runs before the
 * first request and again on every redirect target, with `redirect: "manual"`, so
 * a public first hop cannot bounce the fetcher to loopback, a private range or the
 * cloud metadata endpoint. Work is bounded: a byte ceiling on the body and a
 * character ceiling on the extracted text. Failures are `FetchPageError`.
 */

import { isPubliclyRoutableUrl } from "./host-gate.ts";
import { extractTitle, htmlToText } from "./html-text.ts";
import {
    FETCH_PAGE_MAX_BYTES,
    FETCH_PAGE_MAX_REDIRECTS,
    MAX_TOOL_TEXT_CHARS,
} from "./constants.ts";

/** Statuses whose `Location` header names the next hop. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Declared content types this module is willing to read as text. */
const READABLE_PREFIXES = ["text/"];
const READABLE_TYPES = new Set([
    "application/xhtml+xml",
    "application/xml",
    "application/json",
]);

export interface FetchPageDeps {
    readonly fetch?: typeof fetch;
    readonly allowLoopbackForTesting?: boolean;
    readonly maxBytes?: number;
    readonly maxChars?: number;
    readonly maxRedirects?: number;
}

export interface FetchedPage {
    /** The final URL after redirects. */
    readonly url: string;
    readonly title?: string;
    readonly text: string;
    /** True when `text` was cut at `maxChars`. */
    readonly truncated: boolean;
}

export class FetchPageError extends Error {
    override readonly name = "FetchPageError";
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
    }
}

/** Fetch a URL and return its readable text, gating every hop. */
export async function fetchPage(
    url: string,
    deps: FetchPageDeps = {},
    signal?: AbortSignal,
): Promise<FetchedPage> {
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    const maxBytes = deps.maxBytes ?? FETCH_PAGE_MAX_BYTES;
    const maxChars = deps.maxChars ?? MAX_TOOL_TEXT_CHARS;
    const maxRedirects = deps.maxRedirects ?? FETCH_PAGE_MAX_REDIRECTS;
    const gate = {
        allowLoopbackForTesting: deps.allowLoopbackForTesting === true,
    };

    let current = url;
    const visited = new Set<string>();
    for (let hop = 0;; hop++) {
        // Gate before every request, including each redirect target: a first hop
        // that passes says nothing about where it points.
        if (!isPubliclyRoutableUrl(current, gate)) {
            throw new FetchPageError(
                "blocked_url",
                `refused to fetch ${current}`,
            );
        }
        if (visited.has(current)) {
            throw new FetchPageError(
                "redirect_loop",
                `redirect loops back to ${current}`,
            );
        }
        visited.add(current);
        const response = await fetchImpl(current, {
            redirect: "manual",
            signal,
        });

        if (REDIRECT_STATUSES.has(response.status)) {
            await response.body?.cancel();
            const location = response.headers.get("location");
            if (!location) {
                throw new FetchPageError(
                    "http_error",
                    `${current} returned HTTP ${response.status} with no location`,
                );
            }
            if (hop >= maxRedirects) {
                throw new FetchPageError(
                    "redirect_loop",
                    `exceeded ${maxRedirects} redirects fetching ${url}`,
                );
            }
            try {
                current = new URL(location, current).href;
            } catch {
                throw new FetchPageError(
                    "blocked_url",
                    `redirect from ${current} names an invalid location`,
                );
            }
            continue;
        }

        if (!response.ok) {
            await response.body?.cancel();
            throw new FetchPageError(
                "http_error",
                `${current} returned HTTP ${response.status}`,
            );
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!isReadableContentType(contentType)) {
            await response.body?.cancel();
            throw new FetchPageError(
                "unsupported_content",
                `${current} is ${
                    contentType || "of unknown type"
                }, which cannot be read as text`,
            );
        }

        const bytes = await readCapped(response, maxBytes, current);
        const html = new TextDecoder().decode(bytes);
        const full = htmlToText(html, Number.MAX_SAFE_INTEGER);
        const title = extractTitle(html);
        if (full.length <= maxChars) {
            return { url: current, title, text: full, truncated: false };
        }
        let cut = maxChars;
        const code = full.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
        return {
            url: current,
            title,
            text: full.slice(0, cut).trimEnd(),
            truncated: true,
        };
    }
}

/** Whether a declared content type is text this module will extract. */
function isReadableContentType(header: string): boolean {
    const type = (header.split(";", 1)[0] ?? "").trim().toLowerCase();
    if (type === "") return true; // no declaration: assume markup, decode decides
    if (READABLE_TYPES.has(type)) return true;
    return READABLE_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/**
 * Read the body, refusing to buffer more than `maxBytes`. A `content-length` past
 * the ceiling is rejected before the body is read; otherwise the read is capped
 * incrementally, so a chunked response with no declared length is still bounded.
 */
async function readCapped(
    response: Response,
    maxBytes: number,
    url: string,
): Promise<Uint8Array> {
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel();
        throw new FetchPageError(
            "too_large",
            `${url} declares more than ${maxBytes} bytes`,
        );
    }
    if (!response.body) return new Uint8Array(0);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > maxBytes) {
            throw new FetchPageError(
                "too_large",
                `${url} is larger than ${maxBytes} bytes`,
            );
        }
        chunks.push(chunk);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
