import { assert, assertEquals, assertRejects } from "@std/assert";
import type {
    UiAction,
    UiContext,
    UiContribution,
} from "@heimdall/admin-contracts/ui.ts";
import {
    sendUiAction,
    sessionFetch,
} from "@heimdall/core/web/client/session.ts";

const origin = "https://console.example.test";

interface FetchCall {
    readonly input: RequestInfo | URL;
    readonly init?: RequestInit;
}

/** Tests in this module run sequentially and always restore both globals. */
async function withBrowser(
    run: (calls: FetchCall[]) => Promise<void>,
    respond: () => Response = () => Response.json({ ok: true }),
): Promise<void> {
    const originalFetch = globalThis.fetch;
    const originalLocation = Object.getOwnPropertyDescriptor(
        globalThis,
        "location",
    );
    const calls: FetchCall[] = [];
    Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: { origin },
    });
    globalThis.fetch = (input, init) => {
        calls.push({ input, init });
        return Promise.resolve(respond());
    };
    try {
        await run(calls);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalLocation !== undefined) {
            Object.defineProperty(globalThis, "location", originalLocation);
        } else {
            Reflect.deleteProperty(globalThis, "location");
        }
    }
}

function envelope(call: FetchCall, requestId?: string): unknown {
    assertEquals(call.input, "/admin/ui/request");
    assertEquals(call.init?.method, "POST");
    assertEquals(call.init?.credentials, "same-origin");
    const headers = new Headers(call.init?.headers);
    assertEquals([...headers], [
        ["content-type", "application/json"],
        ...(requestId === undefined ? [] : [["x-request-id", requestId]]),
    ]);
    assert(typeof call.init?.body === "string");
    return JSON.parse(call.init.body);
}

Deno.test("sessionFetch sends tokenless bridge envelopes with JSON and concurrency headers", async () => {
    await withBrowser(async (calls) => {
        const controller = new AbortController();
        const result = await sessionFetch(
            "/api/admin/source-config?id=source%2Fone",
            {
                method: "PUT",
                headers: {
                    "If-Match": '"version-7"',
                    "X-Request-Id": "request-7",
                    authorization: "Bearer must-stay-out",
                    cookie: "must-stay-out=1",
                    "content-type": "text/plain",
                    "x-untrusted": "must-stay-out",
                },
                credentials: "include",
                signal: controller.signal,
                body: JSON.stringify({
                    config: { priority: 7, enabled: true },
                }),
            },
        );
        assertEquals(result.status, 200);
        assertEquals(calls.length, 1);
        assertEquals(envelope(calls[0]!, "request-7"), {
            path: "/api/admin/source-config?id=source%2Fone",
            method: "PUT",
            headers: {
                "if-match": '"version-7"',
                "x-request-id": "request-7",
            },
            body: { config: { priority: 7, enabled: true } },
        });
        controller.abort();
        assertEquals(calls[0]!.init?.signal?.aborted, true);
        assertEquals(
            String(calls[0]!.init?.body).includes("must-stay-out"),
            false,
        );
    });
});

Deno.test("sessionFetch defaults to GET and omits an absent body", async () => {
    await withBrowser(async (calls) => {
        await sessionFetch(new URL("/api/admin/settings", origin));
        assertEquals(envelope(calls[0]!), {
            path: "/api/admin/settings",
            method: "GET",
            headers: {},
        });
    });
});

Deno.test("sessionFetch preserves direct health requests", async () => {
    await withBrowser(async (calls) => {
        const controller = new AbortController();
        const request = new Request(`${origin}/health?probe=1`, {
            headers: { "x-request-id": "health-1" },
            signal: controller.signal,
        });
        const init: RequestInit = { cache: "no-store" };
        await sessionFetch(request, init);
        assertEquals(calls.length, 1);
        assert(calls[0]!.input === request);
        assert(calls[0]!.init === init);
    });
});

Deno.test("sessionFetch rejects external and non-management paths before fetching", async () => {
    await withBrowser(async (calls) => {
        for (
            const path of [
                "https://attacker.example.test/api/admin/settings",
                "//attacker.example.test/api/admin/settings",
                "https://attacker.example.test/health",
                "/api/chat",
                "/api/chat/conversations",
                "/admin/settings",
                "/api/admin/../chat",
            ]
        ) {
            await assertRejects(() => sessionFetch(path));
        }
        assertEquals(calls.length, 0);
    });
});

Deno.test("sessionFetch rejects non-string bodies and malformed JSON before fetching", async () => {
    await withBrowser(async (calls) => {
        const bodies: BodyInit[] = [
            new URLSearchParams({ limitPerMinute: "5" }),
            new FormData(),
            new Blob(['{"limitPerMinute":5}']),
            new Uint8Array([1, 2]),
            "{malformed JSON",
        ];
        for (const body of bodies) {
            await assertRejects(() =>
                sessionFetch("/api/admin/settings", { method: "PUT", body })
            );
        }
        assertEquals(calls.length, 0);
    });
});

Deno.test("sessionFetch preserves method headers and JSON body from Request input", async () => {
    await withBrowser(async (calls) => {
        const request = new Request(`${origin}/api/admin/settings`, {
            method: "PUT",
            headers: {
                "content-type": "application/json",
                "if-match": '"request-version"',
                "x-request-id": "request-input-1",
                authorization: "Bearer excluded",
            },
            body: JSON.stringify({ limitPerMinute: 23 }),
        });
        await sessionFetch(request);
        assertEquals(envelope(calls[0]!, "request-input-1"), {
            path: "/api/admin/settings",
            method: "PUT",
            headers: {
                "if-match": '"request-version"',
                "x-request-id": "request-input-1",
            },
            body: { limitPerMinute: 23 },
        });
    });
});

Deno.test("sessionFetch preserves cancellation from Request input", async () => {
    await withBrowser(async (calls) => {
        const controller = new AbortController();
        const request = new Request(`${origin}/api/admin/settings`, {
            signal: controller.signal,
        });
        await sessionFetch(request);
        assert(calls[0]!.init?.signal !== undefined);
        controller.abort("operator cancelled");
        assertEquals(calls[0]!.init?.signal?.aborted, true);
        assertEquals(calls[0]!.init?.signal?.reason, "operator cancelled");
    });
});

Deno.test("sessionFetch replaces Request headers when init supplies a new header set", async () => {
    await withBrowser(async (calls) => {
        const request = new Request(`${origin}/api/admin/settings`, {
            method: "PUT",
            headers: { "if-match": '"stale-version"' },
            body: JSON.stringify({ limitPerMinute: 23 }),
        });
        await sessionFetch(request, {
            headers: { "x-request-id": "replacement" },
        });
        assertEquals(envelope(calls[0]!, "replacement"), {
            path: "/api/admin/settings",
            method: "PUT",
            headers: { "x-request-id": "replacement" },
            body: { limitPerMinute: 23 },
        });
    });
});

const contribution: UiContribution = {
    pluginId: "source.example",
    id: "health",
    slot: "source.status",
    title: "Source status",
    sourcePluginId: "source.example",
    schema: { blocks: [] },
};
const action: UiAction = { id: "refresh", payload: { includeQuota: true } };

Deno.test("sendUiAction sends only action identity and host context selectors", async () => {
    await withBrowser(async (calls) => {
        const context: UiContext = {
            locale: "zh",
            theme: "dark",
            sourceId: "channel-1",
            sourcePluginId: "source.example",
            data: { retainedInBrowser: "client snapshot", count: 12 },
        };
        await sendUiAction(contribution, action, context);
        assertEquals(calls.length, 1);
        const call = calls[0]!;
        assertEquals(call.input, "/admin/ui/action");
        assertEquals(call.init?.method, "POST");
        assertEquals(call.init?.credentials, "same-origin");
        assertEquals([...new Headers(call.init?.headers)], [
            ["content-type", "application/json"],
        ]);
        assert(typeof call.init?.body === "string");
        assertEquals(JSON.parse(call.init.body), {
            contributionId: "source.example:health",
            action,
            theme: "dark",
            sourceId: "channel-1",
        });
    });
});

Deno.test("sendUiAction omits absent source selectors and surfaces failed actions", async () => {
    await withBrowser(async (calls) => {
        await assertRejects(() =>
            sendUiAction(contribution, action, {
                locale: "zh",
                theme: "system",
                data: {},
            })
        );
        assertEquals(JSON.parse(String(calls[0]!.init?.body)), {
            contributionId: "source.example:health",
            action,
            theme: "system",
        });
    }, () => Response.json({ error: { code: "forbidden" } }, { status: 403 }));
});
