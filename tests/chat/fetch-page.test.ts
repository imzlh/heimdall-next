import { assert, assertEquals, assertRejects } from "@std/assert";
import {
    fetchPage,
    FetchPageError,
} from "../../plugins/tool-web/fetch-page.ts";

function htmlDoc(title: string, body: string): string {
    return `<html><head><title>${title}</title></head><body>${body}</body></html>`;
}

function htmlResponse(body: string, status = 200): Response {
    return new Response(body, {
        status,
        headers: { "content-type": "text/html; charset=utf-8" },
    });
}

/** A fetch stand-in that records every requested URL and init it is handed. */
function recordingFetch(
    handler: (url: string, init?: RequestInit) => Response,
): {
    fetch: typeof fetch;
    calls: string[];
    inits: (RequestInit | undefined)[];
} {
    const calls: string[] = [];
    const inits: (RequestInit | undefined)[] = [];
    const fn: typeof fetch = (input, init) => {
        const url = typeof input === "string"
            ? input
            : input instanceof URL
            ? input.href
            : input.url;
        calls.push(url);
        inits.push(init);
        return Promise.resolve(handler(url, init));
    };
    return { fetch: fn, calls, inits };
}

Deno.test("fetchPage returns extracted text and title for a 200 html page", async () => {
    const { fetch, calls, inits } = recordingFetch(() =>
        htmlResponse(
            htmlDoc("Doc", "<p>Hello world</p><script>var s = 1;</script>"),
        )
    );
    const page = await fetchPage("https://example.com/a", { fetch });
    assertEquals(page.url, "https://example.com/a");
    assertEquals(page.title, "Doc");
    assertEquals(page.text, "Hello world");
    assertEquals(page.truncated, false);
    assertEquals(calls, ["https://example.com/a"]);
    assertEquals(inits[0]?.redirect, "manual");
});

Deno.test("fetchPage blocks a private host without calling fetch", async () => {
    const { fetch, calls } = recordingFetch(() =>
        htmlResponse("should not be reached")
    );
    const error = await assertRejects(
        () => fetchPage("https://10.0.0.1/secret", { fetch }),
        FetchPageError,
    );
    assertEquals(error.code, "blocked_url");
    assertEquals(calls, []);
});

Deno.test("fetchPage follows a public redirect and re-gates the target", async () => {
    const { fetch, calls } = recordingFetch((url) => {
        if (url === "https://example.com/start") {
            return new Response(null, {
                status: 302,
                headers: { location: "https://elsewhere.example/final" },
            });
        }
        return htmlResponse(htmlDoc("Final", "<p>arrived</p>"));
    });
    const page = await fetchPage("https://example.com/start", { fetch });
    assertEquals(page.url, "https://elsewhere.example/final");
    assertEquals(page.title, "Final");
    assertEquals(page.text, "arrived");
    assertEquals(calls, [
        "https://example.com/start",
        "https://elsewhere.example/final",
    ]);
});

Deno.test("fetchPage blocks a redirect that points at a private host", async () => {
    const { fetch, calls } = recordingFetch(() =>
        new Response(null, {
            status: 302,
            headers: { location: "https://169.254.169.254/latest/meta-data" },
        })
    );
    const error = await assertRejects(
        () => fetchPage("https://example.com/start", { fetch }),
        FetchPageError,
    );
    assertEquals(error.code, "blocked_url");
    // The public first hop was requested; the private target never was.
    assertEquals(calls, ["https://example.com/start"]);
});

Deno.test("fetchPage rejects a body larger than maxBytes", async () => {
    const { fetch } = recordingFetch(() => htmlResponse("x".repeat(5000)));
    const error = await assertRejects(
        () => fetchPage("https://example.com/big", { fetch, maxBytes: 100 }),
        FetchPageError,
    );
    assertEquals(error.code, "too_large");
});

Deno.test("fetchPage maps a non-2xx status to http_error", async () => {
    const { fetch } = recordingFetch(() => htmlResponse("boom", 500));
    const error = await assertRejects(
        () => fetchPage("https://example.com/err", { fetch }),
        FetchPageError,
    );
    assertEquals(error.code, "http_error");
});

Deno.test("fetchPage truncates text and reports it", async () => {
    const { fetch } = recordingFetch(() =>
        htmlResponse(htmlDoc("T", "<p>abcdefghij</p>"))
    );
    const page = await fetchPage("https://example.com/t", {
        fetch,
        maxChars: 4,
    });
    assert(page.text.length <= 4);
    assertEquals(page.truncated, true);
});

Deno.test("fetchPage serves loopback only under allowLoopbackForTesting", async () => {
    const { fetch, calls } = recordingFetch(() =>
        htmlResponse(htmlDoc("Local", "<p>local page</p>"))
    );
    const page = await fetchPage("https://127.0.0.1/", {
        fetch,
        allowLoopbackForTesting: true,
    });
    assertEquals(page.title, "Local");
    assertEquals(page.text, "local page");
    assertEquals(calls, ["https://127.0.0.1/"]);
});
