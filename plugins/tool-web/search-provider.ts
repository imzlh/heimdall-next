/**
 * Web search via Tavily: a query in, structured rows out. The API key travels in
 * the request body, which is what this endpoint expects and where it stays out of
 * proxy access logs. Nothing here formats results for a model or decides whether
 * the tool is offered. Failures are `SearchError`.
 */

import { MAX_WEB_SEARCH_RESULTS, TAVILY_SEARCH_ENDPOINT } from "./constants.ts";

export interface SearchResult {
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
}

export interface SearchDeps {
    readonly fetch?: typeof fetch;
    /** Tavily API key; required and non-empty. */
    readonly apiKey: string;
    readonly endpoint?: string;
    readonly maxResults?: number;
}

export class SearchError extends Error {
    override readonly name = "SearchError";
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
    }
}

/** Search the web via Tavily and return bounded, structured rows. */
export async function searchWeb(
    query: string,
    deps: SearchDeps,
    signal?: AbortSignal,
): Promise<SearchResult[]> {
    const apiKey = typeof deps.apiKey === "string" ? deps.apiKey.trim() : "";
    if (!apiKey) {
        throw new SearchError(
            "not_configured",
            "no Tavily API key is configured",
        );
    }
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    const endpoint = deps.endpoint ?? TAVILY_SEARCH_ENDPOINT;
    const maxResults = normalizeMaxResults(deps.maxResults);
    const body = JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        search_depth: "basic",
    });

    let response: Response;
    try {
        response = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json",
            },
            body,
            signal,
        });
    } catch (error) {
        throw new SearchError(
            "http_error",
            `Tavily could not be reached: ${describe(error)}`,
        );
    }
    if (!response.ok) {
        await response.body?.cancel();
        throw new SearchError(
            "http_error",
            `Tavily returned HTTP ${response.status}`,
        );
    }

    let payload: unknown;
    try {
        payload = await response.json();
    } catch {
        throw new SearchError(
            "bad_response",
            "Tavily returned a body that is not JSON",
        );
    }
    return parseResults(payload, maxResults);
}

/** Read rows out of a Tavily payload without trusting its shape. */
function parseResults(payload: unknown, maxResults: number): SearchResult[] {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new SearchError(
            "bad_response",
            "Tavily response is not an object",
        );
    }
    const results = (payload as Record<string, unknown>).results;
    if (!Array.isArray(results)) {
        throw new SearchError(
            "bad_response",
            "Tavily response has no results array",
        );
    }
    const out: SearchResult[] = [];
    for (const item of results) {
        if (out.length >= maxResults) break;
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const entry = item as Record<string, unknown>;
        const url = typeof entry.url === "string" ? entry.url.trim() : "";
        if (!url) continue; // the URL is the only field a caller can act on
        out.push({
            title: typeof entry.title === "string" ? entry.title : "",
            url,
            snippet: typeof entry.content === "string" ? entry.content : "",
        });
    }
    return out;
}

function normalizeMaxResults(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return MAX_WEB_SEARCH_RESULTS;
    }
    const floored = Math.floor(value);
    return floored < 1 ? 1 : floored;
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
