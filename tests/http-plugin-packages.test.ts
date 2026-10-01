import { assert, assertEquals, assertFalse } from "@std/assert";
import { packagePlugin } from "../scripts/package-plugin.ts";
import { loadBuiltinComposition } from "../src/composition/builtins.ts";
import { createServer } from "../src/composition/server.ts";
import { createServerApp } from "../src/http/app.ts";
import { DenoKvConfigStore } from "../src/storage/deno-kv.ts";
import { openSqliteChatStore } from "../src/storage/sqlite-chat.ts";
import type { InferenceSource } from "@heimdall/contracts";
import type { GenerationRequest, StreamFrame } from "@heimdall/hip";

const origin = "http://localhost";
const adminToken = "plugin-integration-admin-secret";
const manifest = {
    id: "test.http-package",
    name: "离线回声",
    version: "1.0.0",
    apiVersion: "1",
    kind: "tool",
    trust: "isolated",
};
const code = `export function invoke(method, payload) {
    if (method === "tools.list") return [{ name: "offline_echo", description: "回声", inputSchema: { type: "object" } }];
    if (method === "tools.execute") return { text: "工具回答：" + JSON.parse(payload.argumentsText).text, isError: false };
    throw new Error("unsupported method");
}`;

Deno.test("cookie management installs a real offline worker, Chat invokes it, and restart restores its lifecycle", async () => {
    using kv = await Deno.openKv(":memory:");
    const configStore = new DenoKvConfigStore(kv);
    const chat = openSqliteChatStore(":memory:");
    const options = {
        configStore,
        pluginRoot: new URL("./missing-plugin-directory/", import.meta.url),
        env: () => undefined,
    };
    let composition = await loadBuiltinComposition(options);
    const payloads: GenerationRequest[] = [];
    const source: InferenceSource = {
        id: "integration-source",
        capabilities: [{
            operation: "generation.create",
            models: ["test-model"],
            streaming: false,
        }],
        async *execute(request): AsyncIterable<StreamFrame> {
            const payload = request.payload as GenerationRequest;
            payloads.push(payload);
            const frame = (
                seq: number,
                event: StreamFrame["event"],
            ): StreamFrame => ({
                version: 1,
                streamId: "integration",
                requestId: request.requestId,
                seq,
                eventId: `event-${seq}`,
                timestamp: new Date().toISOString(),
                event,
            });
            yield frame(1, { kind: "run.started", request });
            if (payloads.length === 1) {
                yield frame(2, {
                    kind: "tool.call",
                    messageId: "m",
                    callId: "echo-1",
                    name: "offline_echo",
                    argumentsText: '{"text":"你好"}',
                });
            } else {
                yield frame(2, {
                    kind: "part.delta",
                    messageId: "m",
                    partId: "p",
                    delta: "收到工具结果",
                });
            }
            yield frame(3, { kind: "run.completed" });
        },
    };
    function server() {
        return createServer({
            adminAuthToken: adminToken,
            adminCatalog: composition.catalog,
            adminManagement: composition.management,
            sources: [source],
            chat: { store: chat, tools: composition.toolPlugins },
        });
    }
    let app = server();
    async function login() {
        const response = await app.request(`${origin}/admin/session`, {
            method: "POST",
            headers: { origin },
            body: new URLSearchParams({ token: adminToken }),
        });
        assertEquals(response.status, 303);
        const cookie = response.headers.get("set-cookie")?.split(";")[0];
        assert(cookie);
        return cookie;
    }
    let cookie = await login();
    function bridge(
        path: string,
        method = "GET",
        body?: unknown,
        authenticated = true,
    ) {
        return app.request(`${origin}/admin/ui/request`, {
            method: "POST",
            headers: {
                origin,
                "content-type": "application/json",
                ...(authenticated ? { cookie } : {}),
            },
            body: JSON.stringify({
                path: `/api/admin/${path}`,
                method,
                ...(body === undefined ? {} : { body }),
            }),
        });
    }
    try {
        const input = JSON.parse(await packagePlugin(manifest, code));
        assertEquals(
            (await bridge("plugin-package", "POST", input, false)).status,
            401,
        );
        assertEquals(
            (await bridge("plugin-package", "POST", {
                ...input,
                code: code + "tampered",
            })).status,
            400,
        );
        const installed = await bridge("plugin-package", "POST", input);
        assertEquals(installed.status, 201, await installed.clone().text());
        assertEquals((await installed.json()).plugin.enabled, false);
        assertEquals(composition.toolPlugins(), []);
        assertEquals(
            (await bridge("plugin-package", "POST", input)).status,
            409,
        );
        const toggle = (enabled: boolean) =>
            bridge("plugin-state", "POST", { pluginId: manifest.id, enabled });
        assertEquals((await toggle(true)).status, 200);
        const catalog = await (await bridge("plugins")).json();
        assertEquals(catalog.plugins[0].managed, true);
        assertEquals(catalog.plugins[0].enabled, true);
        assertFalse(JSON.stringify(catalog).includes("export function invoke"));
        const conversation = await app.request(
            `${origin}/admin/chat/api/conversations`,
            {
                method: "POST",
                headers: { origin, cookie },
            },
        );
        assertEquals(conversation.status, 201);
        const conversationId = (await conversation.json()).conversation.id;
        const reply = await app.request(`${origin}/admin/chat/api/message`, {
            method: "POST",
            headers: { origin, cookie, "content-type": "application/json" },
            body: JSON.stringify({
                conversationId,
                model: "test-model",
                text: "调用回声",
            }),
        });
        assertEquals(reply.status, 200, await reply.clone().text());
        assertEquals((await reply.json()).messages.at(-1).text, "收到工具结果");
        assert(
            payloads[0]?.tools?.some((tool) => tool.name === "offline_echo"),
        );
        assert(
            JSON.stringify(payloads[1]?.messages).includes("工具回答：你好"),
        );
        assertEquals((await toggle(false)).status, 200);
        assertEquals(composition.toolPlugins(), []);
        assertEquals((await toggle(true)).status, 200);
        await composition.close();
        composition = await loadBuiltinComposition(options);
        app = server();
        cookie = await login();
        assertEquals(composition.toolPlugins()[0]?.manifest.id, manifest.id);
        const removed = await bridge("plugin", "DELETE", {
            pluginId: manifest.id,
        });
        assertEquals(removed.status, 200);
        assertEquals((await removed.json()).removed, true);
        assertEquals(composition.toolPlugins(), []);
        assertEquals((await (await bridge("plugins")).json()).plugins, []);
    } finally {
        await composition.close();
        chat.close();
    }
});

Deno.test("package HTTP boundary rejects malformed and oversized uploads without invoking installation", async () => {
    let installs = 0;
    const app = createServerApp({
        adminManagement: {
            installPlugin: () => {
                installs++;
                return Promise.resolve({ enabled: false });
            },
        },
    });
    const request = (body: BodyInit, type = "application/json") =>
        app.request("/admin/plugin-package", {
            method: "POST",
            headers: { "content-type": type },
            body,
        });
    assertEquals((await request("{}", "application/json-invalid")).status, 400);
    assertEquals((await request("{")).status, 400);
    assertEquals((await request(new Uint8Array([0xc3, 0x28]))).status, 400);
    assertEquals((await request("x".repeat(2 * 1024 * 1024 + 1))).status, 413);
    assertEquals(installs, 0);
    const failed = createServerApp({
        adminManagement: {
            installPlugin: () =>
                Promise.reject(new Error("private storage failure")),
        },
    });
    const response = await failed.request("/api/admin/plugin-package", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
    });
    assertEquals(response.status, 500);
    assertFalse((await response.text()).includes("private storage failure"));
});
