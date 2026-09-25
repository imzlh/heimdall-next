/** Server tools for bounded public page fetching and optional web search. */
import type {
    PluginManifest,
    ServerTool,
    ToolExecutionContext,
    ToolInvocation,
    ToolOutcome,
    ToolPlugin,
    ToolPluginFactory,
} from "@heimdall/contracts";
import {
    FETCH_PAGE_MAX_BYTES,
    MAX_FETCH_URL_CHARS,
    MAX_PAGE_FETCHES_PER_RUN,
    MAX_SEARCH_QUERY_CHARS,
    MAX_TOOL_ARGUMENT_CHARS,
    MAX_TOOL_TEXT_CHARS,
    MAX_WEB_SEARCH_RESULTS,
    MAX_WEB_SEARCHES_PER_RUN,
    UNTRUSTED_PREFIX,
} from "./constants.ts";
import { type FetchedPage, fetchPage, FetchPageError } from "./fetch-page.ts";
import manifest from "./manifest.json" with { type: "json" };
import {
    SearchError,
    type SearchResult,
    searchWeb,
} from "./search-provider.ts";

export interface WebToolPluginDeps {
    /** Injectable network seam; defaults to the global fetch. */
    readonly fetch?: typeof fetch;
    /** Tavily key. When empty, web_search is not offered. */
    readonly tavilyApiKey?: string;
    /** Lets offline tests fetch loopback hosts; production leaves it off. */
    readonly allowLoopbackForTesting?: boolean;
}

export const webToolManifest = manifest as PluginManifest;

/** Entry point for the host's module loader; environment policy stays here. */
export const toolPlugin: ToolPluginFactory = {
    manifest: webToolManifest,
    create({ env }): ToolPlugin {
        return createWebToolPlugin({
            tavilyApiKey: env("HEIMDALL_TAVILY_KEY")?.trim() ||
                env("TAVILY_API_KEY")?.trim(),
        });
    },
};

export function createWebToolPlugin(
    deps: WebToolPluginDeps = {},
): ToolPlugin {
    const tools: ServerTool[] = [];
    const searchKey = deps.tavilyApiKey?.trim() ?? "";
    if (searchKey.length > 0) {
        tools.push({
            definition: {
                name: "web_search",
                description:
                    "Search the web for recent or factual information. Returns result titles, URLs and snippets.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "The search query.",
                        },
                    },
                    required: ["query"],
                    additionalProperties: false,
                },
                execution: "server",
            },
            execute: (call, context) =>
                runSearch(call, context, deps, searchKey),
        });
    }
    tools.push({
        definition: {
            name: "fetch_url",
            description:
                "Fetch a public https web page and return its readable text. Only public URLs are allowed.",
            inputSchema: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "An https URL to fetch.",
                    },
                },
                required: ["url"],
                additionalProperties: false,
            },
            execution: "server",
        },
        execute: (call, context) => runFetch(call, context, deps),
    });
    return { manifest: webToolManifest, tools };
}

async function runSearch(
    call: ToolInvocation,
    context: ToolExecutionContext,
    deps: WebToolPluginDeps,
    searchKey: string,
): Promise<ToolOutcome> {
    const invalid = validateInvocation(call, "web_search");
    if (invalid) return invalid;
    const args = parseArguments(call.argumentsText);
    if (args === undefined) {
        return fail("web_search arguments must be a JSON object");
    }
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query.length === 0) return fail("web_search requires a query string");
    if (query.length > MAX_SEARCH_QUERY_CHARS) {
        return fail("search query is too long");
    }
    if (!context.budget.consume("search", MAX_WEB_SEARCHES_PER_RUN)) {
        return fail("web search budget exhausted for this run");
    }
    try {
        const results = await searchWeb(query, {
            fetch: deps.fetch,
            apiKey: searchKey,
            maxResults: MAX_WEB_SEARCH_RESULTS,
        }, context.signal);
        return ok(formatSearch(query, results));
    } catch (error) {
        if (error instanceof SearchError) {
            return fail(`web search failed (${error.code}): ${error.message}`);
        }
        throw error;
    }
}

async function runFetch(
    call: ToolInvocation,
    context: ToolExecutionContext,
    deps: WebToolPluginDeps,
): Promise<ToolOutcome> {
    const invalid = validateInvocation(call, "fetch_url");
    if (invalid) return invalid;
    const args = parseArguments(call.argumentsText);
    if (args === undefined) {
        return fail("fetch_url arguments must be a JSON object");
    }
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (url.length === 0) return fail("fetch_url requires a url string");
    if (url.length > MAX_FETCH_URL_CHARS) return fail("url is too long");
    if (!context.budget.consume("fetch", MAX_PAGE_FETCHES_PER_RUN)) {
        return fail("page fetch budget exhausted for this run");
    }
    try {
        const page = await fetchPage(url, {
            fetch: deps.fetch,
            allowLoopbackForTesting: deps.allowLoopbackForTesting,
            maxBytes: FETCH_PAGE_MAX_BYTES,
            maxChars: MAX_TOOL_TEXT_CHARS,
        }, context.signal);
        return ok(formatPage(page));
    } catch (error) {
        if (error instanceof FetchPageError) {
            return fail(`page fetch failed (${error.code}): ${error.message}`);
        }
        throw error;
    }
}

function validateInvocation(
    call: ToolInvocation,
    name: string,
): ToolOutcome | undefined {
    if (call.argumentsText.length > MAX_TOOL_ARGUMENT_CHARS) {
        return fail("tool arguments are too large");
    }
    if (call.name !== name) return fail(`unknown tool: ${call.name}`);
    return undefined;
}

function parseArguments(text: string): Record<string, unknown> | undefined {
    const trimmed = text.trim();
    if (trimmed.length === 0) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return undefined;
    }
    if (
        parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    ) {
        return undefined;
    }
    return parsed as Record<string, unknown>;
}

function ok(body: string): ToolOutcome {
    const capped = body.length > MAX_TOOL_TEXT_CHARS
        ? body.slice(0, MAX_TOOL_TEXT_CHARS)
        : body;
    return { text: `${UNTRUSTED_PREFIX}${capped}`, isError: false };
}

function fail(message: string): ToolOutcome {
    return { text: message, isError: true };
}

function formatSearch(query: string, results: readonly SearchResult[]): string {
    if (results.length === 0) return `No web results for "${query}".`;
    return results
        .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`)
        .join("\n\n");
}

function formatPage(page: FetchedPage): string {
    const header = page.title === undefined
        ? `${page.url}\n\n`
        : `${page.title}\n${page.url}\n\n`;
    const suffix = page.truncated ? "\n\n[content truncated]" : "";
    return `${header}${page.text}${suffix}`;
}
