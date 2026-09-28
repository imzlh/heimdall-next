import { assertEquals, assertRejects } from "@std/assert";
import { IsolatedPluginRuntime } from "../src/composition/isolated-plugin-runtime.ts";

function artifact(code: string) {
    return {
        manifest: { id: "test.worker", name: "test", version: "1.0.0", apiVersion: "1" as const, kind: "tool" as const, trust: "isolated" as const },
        entrypoint: "plugin.js", bytes: new TextEncoder().encode(code),
    };
}

Deno.test("isolated worker executes JSON RPC and cannot access host environment or files", async () => {
    const runtime = new IsolatedPluginRuntime();
    try {
        await runtime.start(artifact(`export async function invoke(method, payload) {
            if (method === "env") return Deno.env.get("PATH");
            if (method === "read") return Deno.readTextFile("deno.json");
            if (method === "import") return import("https://example.invalid/plugin.js");
            return payload;
        }`));
        assertEquals(await runtime.invoke({ method: "echo", payload: { hello: "你好" } }), { hello: "你好" });
        await assertRejects(() => runtime.invoke({ method: "env" }));
        await assertRejects(() => runtime.invoke({ method: "read" }));
        await assertRejects(() => runtime.invoke({ method: "import" }));
    } finally { await runtime.stop(); }
});

Deno.test("isolated worker terminates synchronous runaway code and releases pending RPC", async () => {
    const runtime = new IsolatedPluginRuntime(300);
    try {
        await runtime.start(artifact("export function invoke() { while (true) {} }"));
        await assertRejects(() => runtime.invoke({ method: "hang" }), Error, "timed out");
        await assertRejects(() => runtime.invoke({ method: "echo" }), Error, "not running");
    } finally { await runtime.stop(); }
});
