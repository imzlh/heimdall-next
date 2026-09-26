import { assertEquals, assertThrows } from "@std/assert";
import type { InferenceSource } from "@heimdall/contracts";
import { SourceRegistry } from "@heimdall/kernel";
import { createServer } from "../main.ts";
import {
    probeSources,
    readProbeInterval,
} from "@heimdall/core/composition/probe-loop.ts";
import {
    advertisedCapabilities,
    validateOpenAICompatibleSourceConfig,
} from "../plugins/openai-source/config.ts";
import { OpenAICompatibleSource } from "../plugins/openai-source/mod.ts";

const baseUrl = "https://provider.example/v1";

Deno.test("OpenAI compat profiles filter advertised operations", () => {
    const chat = validateOpenAICompatibleSourceConfig({
        baseUrl,
        compat: "chat",
    });
    assertEquals(chat.compat, "chat");
    assertEquals(
        advertisedCapabilities(chat).map((capability) => capability.operation),
        ["generation.create", "completion.create"],
    );
    assertEquals(
        advertisedCapabilities(validateOpenAICompatibleSourceConfig({
            baseUrl,
            compat: "embeddings",
        })).map((capability) => capability.operation),
        ["embedding.create"],
    );
    assertEquals(
        advertisedCapabilities(validateOpenAICompatibleSourceConfig({
            baseUrl,
            compat: "images",
        })).map((capability) => capability.operation),
        ["image.generate", "image.edit"],
    );
    assertEquals(
        validateOpenAICompatibleSourceConfig({ baseUrl }).compat,
        "full",
    );
    assertThrows(
        () =>
            validateOpenAICompatibleSourceConfig({
                baseUrl,
                compat: "responses",
            } as never),
        TypeError,
    );
});

Deno.test("OpenAI source probe GETs /models and omits the api key", async () => {
    const apiKey = "sk-probe-secret";
    const seen: { url?: string; init?: RequestInit } = {};
    const source = new OpenAICompatibleSource({
        baseUrl: `${baseUrl}/`,
        apiKey,
        headers: { "x-tenant": "acme" },
    }, {
        fetch: (input, init) => {
            seen.url = String(input);
            seen.init = init;
            return Promise.resolve(
                new Response(JSON.stringify({ data: [{ id: apiKey }] }), {
                    status: 200,
                }),
            );
        },
    });
    const signal = new AbortController().signal;
    const result = await source.probe(signal);
    assertEquals(seen.url, `${baseUrl}/models`);
    assertEquals(seen.init?.method, "GET");
    assertEquals(seen.init?.body, undefined);
    assertEquals(seen.init?.redirect, "error");
    // The provider combines request cancellation with its operation lifetime.
    assertEquals(seen.init?.signal?.aborted, true);
    assertEquals(signal.aborted, false);
    const headers = new Headers(seen.init?.headers);
    assertEquals(headers.get("accept"), "application/json");
    assertEquals(headers.get("authorization"), `Bearer ${apiKey}`);
    assertEquals(headers.get("x-tenant"), "acme");
    assertEquals(result, { ok: true, message: "models endpoint reachable" });
    assertEquals(JSON.stringify(result).includes(apiKey), false);
});

Deno.test("OpenAI source probe reports status and transport failures", async () => {
    const apiKey = "sk-probe-secret";
    const failed = new OpenAICompatibleSource({
        baseUrl,
        apiKey,
    }, {
        fetch: () =>
            Promise.resolve(
                new Response(JSON.stringify({ error: apiKey }), {
                    status: 503,
                }),
            ),
    });
    assertEquals(await failed.probe(new AbortController().signal), {
        ok: false,
        message: "models probe failed with status 503",
    });

    const thrown = new OpenAICompatibleSource({
        baseUrl,
        apiKey,
    }, {
        fetch: () => {
            throw new Error(`network down ${apiKey}`);
        },
    });
    const result = await thrown.probe(new AbortController().signal);
    assertEquals(result.ok, false);
    assertEquals(result.message.includes(apiKey), false);
    assertEquals(result.message.includes("network down"), true);
});

Deno.test("source registry probe failure cools a source and success clears it", () => {
    let now = Date.parse("2026-09-22T00:00:00.000Z");
    const registry = new SourceRegistry({
        now: () => new Date(now),
        cooldownMs: 30_000,
    });
    const source: InferenceSource = {
        id: "upstream",
        capabilities: [{ operation: "generation.create", streaming: true }],
        execute() {
            return (async function* () {})();
        },
    };
    registry.register(source);
    assertThrows(
        () => registry.recordProbe("missing", { ok: false, message: "nope" }),
        TypeError,
    );
    assertThrows(() => registry.probeOf("missing"), TypeError);
    assertEquals(registry.probeOf("upstream"), undefined);

    registry.recordProbe("upstream", { ok: false, message: "down" });
    assertEquals(registry.healthOf("upstream"), "cooldown");
    assertEquals(registry.probeOf("upstream"), {
        ok: false,
        checkedAt: "2026-09-22T00:00:00.000Z",
        message: "down",
    });

    now += 1_000;
    registry.recordProbe("upstream", {
        ok: true,
        message: "models endpoint reachable",
    });
    assertEquals(registry.healthOf("upstream"), "ready");
    assertEquals(registry.probeOf("upstream"), {
        ok: true,
        checkedAt: "2026-09-22T00:00:01.000Z",
        message: "models endpoint reachable",
    });
});

Deno.test("admin source probe uses a fixed route", async () => {
    let calls = 0;
    const fake: InferenceSource = {
        id: "demo",
        capabilities: [{ operation: "generation.create", streaming: false }],
        execute() {
            return (async function* () {})();
        },
        probe(signal) {
            calls += 1;
            assertEquals(signal.aborted, false);
            return Promise.resolve({
                ok: true,
                message: "models endpoint reachable",
            });
        },
    };
    const idle = createServer({ sources: [fake] });
    assertEquals(calls, 0);
    const unavailable = await idle.request(
        "http://localhost/admin/source-probe",
        {
            method: "POST",
            body: JSON.stringify({ sourceId: "demo" }),
        },
    );
    assertEquals(unavailable.status, 501);
    assertEquals(calls, 0);

    const app = createServer({
        sources: [fake],
        adminManagement: {
            probeSource: (_context, sourceId) => {
                if (fake.probe === undefined) {
                    throw new Error("probe is not installed");
                }
                return fake.probe(new AbortController().signal).then((
                    result,
                ) => ({
                    sourceId,
                    ok: result.ok,
                    message: result.message,
                    health: "ready" as const,
                }));
            },
        },
    });
    const response = await app.request("http://localhost/admin/source-probe", {
        method: "POST",
        body: JSON.stringify({ sourceId: "demo" }),
    });
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
        probe: {
            sourceId: "demo",
            ok: true,
            message: "models endpoint reachable",
            health: "ready",
        },
    });
    assertEquals(calls, 1);

    const missing = await app.request("http://localhost/admin/source-probe", {
        method: "POST",
        body: JSON.stringify({}),
    });
    assertEquals(missing.status, 400);
});

Deno.test("probe loop records sources that implement probe", async () => {
    const registry = new SourceRegistry();
    registry.register({
        id: "live",
        capabilities: [{ operation: "generation.create", streaming: true }],
        execute() {
            return (async function* () {})();
        },
        probe() {
            return Promise.resolve({
                ok: true,
                message: " models endpoint reachable ",
            });
        },
    });
    registry.register({
        id: "silent",
        capabilities: [{ operation: "generation.create", streaming: true }],
        execute() {
            return (async function* () {})();
        },
    });
    await probeSources(registry, 1_000);
    assertEquals(registry.probeOf("live")?.ok, true);
    assertEquals(
        registry.probeOf("live")?.message,
        "models endpoint reachable",
    );
    assertEquals(registry.probeOf("silent"), undefined);
    assertEquals(readProbeInterval(undefined), 300_000);
    assertEquals(readProbeInterval("0"), 0);
});

Deno.test("a successful models probe fills the public catalog without restricting routing", async () => {
    const source = new OpenAICompatibleSource({
        baseUrl,
        apiKey: "sk-probe-secret",
    }, {
        fetch: () =>
            Promise.resolve(
                new Response(
                    JSON.stringify({
                        data: [
                            { id: "beta" },
                            { id: " alpha " },
                            { id: "sk-probe-secret" },
                            { id: "" },
                        ],
                    }),
                    { status: 200 },
                ),
            ),
    });
    const result = await source.probe(new AbortController().signal);
    assertEquals(result.models, ["beta", "alpha"]);
    assertEquals(JSON.stringify(result).includes("sk-probe-secret"), false);

    const registry = new SourceRegistry();
    registry.register(source);
    registry.recordProbe(source.id, result);
    assertEquals(registry.discoveredModels(source.id), ["alpha", "beta"]);
    const app = createServer({ sourceRegistry: registry });
    const listed = await (await app.request("http://localhost/v1/models"))
        .json();
    assertEquals(listed.data.map((model: { id: string }) => model.id), [
        "alpha",
        "beta",
    ]);
    assertEquals(
        registry.select({
            version: 1,
            requestId: "req-models",
            operation: "generation.create",
            payload: { messages: [], model: "not-in-the-catalog" },
            traits: { model: "not-in-the-catalog", streaming: true },
        }).id,
        source.id,
    );
});
