import { assertEquals, assertRejects } from "@std/assert";
import {
    SearchError,
    searchWeb,
} from "../../plugins/tool-web/search-provider.ts";

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
    });
}

/** A fetch stand-in that records each URL and the request body it is handed. */
function recordingFetch(
    handler: (url: string, init?: RequestInit) => Response,
): {
    fetch: typeof fetch;
    calls: string[];
    bodies: (string | undefined)[];
} {
    const calls: string[] = [];
    const bodies: (string | undefined)[] = [];
    const fn: typeof fetch = (input, init) => {
        const url = typeof input === "string"
            ? input
            : input instanceof URL
            ? input.href
            : input.url;
        calls.push(url);
        bodies.push(typeof init?.body === "string" ? init.body : undefined);
        return Promise.resolve(handler(url, init));
    };
    return { fetch: fn, calls, bodies };
}

Deno.test("searchWeb maps Tavily rows and carries query + key in the body", async () => {
    const { fetch, calls, bodies } = recordingFetch(() =>
        jsonResponse({
            results: [
                {
                    title: "One",
                    url: "https://a.example/1",
                    content: "first snippet",
                },
                {
                    title: "Two",
                    url: "https://b.example/2",
                    content: "second snippet",
                },
                {
                    title: "Three",
                    url: "https://c.example/3",
                    content: "third snippet",
                },
            ],
        })
    );
    const results = await searchWeb("deno testing", {
        fetch,
        apiKey: "secret-key",
        maxResults: 2,
    });
    assertEquals(results.length, 2);
    assertEquals(results[0], {
        title: "One",
        url: "https://a.example/1",
        snippet: "first snippet",
    });
    assertEquals(results[1]?.url, "https://b.example/2");
    // Default endpoint, and the query + key travel in the JSON body, not the URL.
    assertEquals(calls, ["https://api.tavily.com/search"]);
    const sent = JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>;
    assertEquals(sent.query, "deno testing");
    assertEquals(sent.api_key, "secret-key");
    assertEquals(sent.max_results, 2);
    assertEquals(sent.search_depth, "basic");
});

Deno.test("searchWeb reports not_configured for an empty apiKey and never calls fetch", async () => {
    const { fetch, calls } = recordingFetch(() =>
        jsonResponse({ results: [] })
    );
    const error = await assertRejects(
        () => searchWeb("q", { fetch, apiKey: "   " }),
        SearchError,
    );
    assertEquals(error.code, "not_configured");
    assertEquals(calls, []);
});

Deno.test("searchWeb maps a non-200 response to http_error", async () => {
    const { fetch } = recordingFetch(() =>
        jsonResponse({ error: "nope" }, 401)
    );
    const error = await assertRejects(
        () => searchWeb("q", { fetch, apiKey: "k" }),
        SearchError,
    );
    assertEquals(error.code, "http_error");
});

Deno.test("searchWeb reports bad_response when the body is not JSON", async () => {
    const { fetch } = recordingFetch(() =>
        new Response("<html>not json</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
        })
    );
    const error = await assertRejects(
        () => searchWeb("q", { fetch, apiKey: "k" }),
        SearchError,
    );
    assertEquals(error.code, "bad_response");
});

Deno.test("searchWeb reports bad_response when the results array is missing", async () => {
    const { fetch } = recordingFetch(() =>
        jsonResponse({ answer: "no rows here" })
    );
    const error = await assertRejects(
        () => searchWeb("q", { fetch, apiKey: "k" }),
        SearchError,
    );
    assertEquals(error.code, "bad_response");
});

Deno.test("searchWeb skips rows without a usable url", async () => {
    const { fetch } = recordingFetch(() =>
        jsonResponse({
            results: [
                { title: "no url", content: "skip me" },
                { title: "ok", url: "https://ok.example/", content: "keep me" },
            ],
        })
    );
    const results = await searchWeb("q", { fetch, apiKey: "k" });
    assertEquals(results.length, 1);
    assertEquals(results[0], {
        title: "ok",
        url: "https://ok.example/",
        snippet: "keep me",
    });
});
