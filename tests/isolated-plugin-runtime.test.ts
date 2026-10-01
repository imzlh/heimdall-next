import { assertEquals, assertRejects } from "@std/assert";
import { IsolatedPluginRuntime } from "../src/composition/isolated-plugin-runtime.ts";

function artifact(code: string) {
    return {
        manifest: {
            id: "test.worker",
            name: "test",
            version: "1.0.0",
            apiVersion: "1" as const,
            kind: "tool" as const,
            trust: "isolated" as const,
        },
        entrypoint: "plugin.js",
        bytes: new TextEncoder().encode(code),
    };
}

Deno.test("isolated worker executes JSON RPC and cannot inherit host permissions", async () => {
    const runtime = new IsolatedPluginRuntime();
    const privateModule = await Deno.makeTempFile({ suffix: ".mjs" });
    try {
        await Deno.writeTextFile(
            privateModule,
            "export default 'host-private-module';",
        );
        const fileUrl = new URL("file:///");
        fileUrl.pathname = privateModule.replaceAll("\\", "/");
        // A module cached by the host must not become readable in the worker.
        assertEquals(
            (await import(fileUrl.href)).default,
            "host-private-module",
        );
        await runtime.start(
            artifact(`export async function invoke(method, payload, context) {
            if (method === "env") return Deno.env.get("PATH");
            if (method === "read") return Deno.readTextFile("deno.json");
            if (method === "net") return fetch("http://127.0.0.1:65534/");
            if (method === "run") return new Deno.Command(${
                JSON.stringify(Deno.execPath())
            }, { args: ["eval", "console.log('unexpected execution')"] }).output();
            if (method === "import") return import(${
                JSON.stringify(fileUrl.href)
            });
            if (method === "permission") return (await Deno.permissions.request({ name: "read" })).state;
            if (method === "context") return context.request;
            return payload;
        }`),
        );
        assertEquals(
            await runtime.invoke({
                method: "echo",
                payload: { hello: "你好" },
            }),
            { hello: "你好" },
        );
        await assertRejects(
            () => runtime.invoke({ method: "env" }),
            Error,
            "Requires env access",
        );
        await assertRejects(
            () => runtime.invoke({ method: "read" }),
            Error,
            "Requires read access",
        );
        await assertRejects(
            () => runtime.invoke({ method: "net" }),
            Error,
            "Requires net access",
        );
        await assertRejects(
            () => runtime.invoke({ method: "run" }),
            Error,
            "Requires run access",
        );
        await assertRejects(
            () => runtime.invoke({ method: "import" }),
            Error,
            "Requires read access",
        );
        assertEquals(await runtime.invoke({ method: "permission" }), "denied");
        const request = {
            requestId: "request-17",
            metadata: {
                conversationId: "conversation-4",
                sessionId: "session-4",
                traceId: "trace-1",
            },
        };
        assertEquals(
            await runtime.invoke({ method: "context", request }),
            request,
        );
        const internalContext = {
            ...request,
            authorization: "private-host-credential",
            request: new Request("https://private.invalid", {
                headers: { authorization: "Bearer private-host-credential" },
            }),
            signal: new AbortController().signal,
        };
        assertEquals(
            await runtime.invoke({
                method: "context",
                request: internalContext,
            }),
            request,
        );
        assertEquals(await runtime.invoke({ method: "context" }), undefined);
    } finally {
        await runtime.stop();
        await Deno.remove(privateModule);
    }
});

Deno.test("isolated worker terminates synchronous runaway code and releases pending RPC", async () => {
    const runtime = new IsolatedPluginRuntime(300);
    try {
        assertEquals(runtime.isActive(), false);
        await runtime.start(
            artifact("export function invoke() { while (true) {} }"),
        );
        assertEquals(runtime.isActive(), true);
        await assertRejects(
            () => runtime.invoke({ method: "hang" }),
            Error,
            "timed out",
        );
        assertEquals(runtime.isActive(), false);
        await assertRejects(
            () => runtime.invoke({ method: "echo" }),
            Error,
            "not running",
        );
    } finally {
        await runtime.stop();
    }
});

Deno.test("caller abort preserves the watchdog for synchronous runaway code", async () => {
    const runtime = new IsolatedPluginRuntime(300);
    try {
        await runtime.start(
            artifact("export function invoke() { while (true) {} }"),
        );
        const controller = new AbortController();
        const result = assertRejects(
            () => runtime.invoke({ method: "hang", signal: controller.signal }),
            DOMException,
            "caller cancelled",
        );
        controller.abort(new DOMException("caller cancelled", "AbortError"));
        await result;
        // No further invocation may be needed to terminate the cancelled task.
        await new Promise((resolve) => setTimeout(resolve, 400));
        await assertRejects(
            () => runtime.invoke({ method: "echo" }),
            Error,
            "not running",
        );
        await runtime.start(
            artifact(
                "export function invoke(_method, payload) { return payload; }",
            ),
        );
        assertEquals(
            await runtime.invoke({ method: "echo", payload: "restarted" }),
            "restarted",
        );
    } finally {
        await runtime.stop();
    }
});

Deno.test("cooperative cancellation releases invocation slots and keeps the worker usable", async () => {
    const runtime = new IsolatedPluginRuntime();
    try {
        await runtime.start(
            artifact(`export function invoke(method, payload, { signal }) {
            if (method !== "wait") return payload;
            return new Promise((resolve) => signal.addEventListener("abort", () => resolve("cancelled"), { once: true }));
        }`),
        );
        for (let i = 0; i < 40; i++) {
            const controller = new AbortController();
            const result = assertRejects(
                () =>
                    runtime.invoke({
                        method: "wait",
                        signal: controller.signal,
                    }),
                DOMException,
                "caller cancelled",
            );
            controller.abort(
                new DOMException("caller cancelled", "AbortError"),
            );
            await result;
            assertEquals(
                await runtime.invoke({ method: "echo", payload: i }),
                i,
            );
        }
    } finally {
        await runtime.stop();
    }
});

function trackObjectURLs() {
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    const created: string[] = [];
    const revoked: string[] = [];
    URL.createObjectURL = (blob) => {
        const url = create(blob);
        created.push(url);
        return url;
    };
    URL.revokeObjectURL = (url) => {
        revoked.push(url);
        revoke(url);
    };
    return {
        created,
        revoked,
        restore: () => {
            URL.createObjectURL = create;
            URL.revokeObjectURL = revoke;
        },
    };
}

Deno.test("failed module initialization tears down the worker and revokes its module URLs", async () => {
    const urls = trackObjectURLs();
    const runtime = new IsolatedPluginRuntime(300);
    try {
        for (
            const code of [
                "export const missingInvoke = true;",
                "throw new Error('import failed'); export function invoke() {}",
                "export function invoke( {",
                "while (true) {} export function invoke() {}",
            ]
        ) {
            await assertRejects(() => runtime.start(artifact(code)), Error);
            assertEquals(runtime.isActive(), false);
            assertEquals(urls.revoked, urls.created);
            await assertRejects(
                () => runtime.invoke({ method: "echo" }),
                Error,
                "not running",
            );
        }
        await runtime.start(
            artifact("export function invoke() { return true; }"),
        );
        assertEquals(await runtime.invoke({ method: "echo" }), true);
        assertEquals(runtime.isActive(), true);
    } finally {
        await runtime.stop();
        urls.restore();
    }
    assertEquals(urls.revoked, urls.created);
    assertEquals(runtime.isActive(), false);
});

Deno.test("Worker construction failure releases URLs without requiring a later stop", async () => {
    const urls = trackObjectURLs();
    const WorkerConstructor = globalThis.Worker;
    const runtime = new IsolatedPluginRuntime();
    try {
        globalThis.Worker = new Proxy(WorkerConstructor, {
            construct() {
                throw new Error("worker construction failed");
            },
        });
        await assertRejects(
            () => runtime.start(artifact("export function invoke() {}")),
            Error,
            "worker construction failed",
        );
        assertEquals(urls.created.length, 2);
        assertEquals(urls.revoked, urls.created);
        await assertRejects(
            () => runtime.invoke({ method: "echo" }),
            Error,
            "not running",
        );
    } finally {
        globalThis.Worker = WorkerConstructor;
        await runtime.stop();
        urls.restore();
    }
});

Deno.test("partial URL allocation failure releases already allocated resources", async () => {
    const urls = trackObjectURLs();
    const create = URL.createObjectURL;
    const runtime = new IsolatedPluginRuntime();
    try {
        URL.createObjectURL = (blob) => {
            if (urls.created.length === 1) {
                throw new Error("entry allocation failed");
            }
            return create(blob);
        };
        await assertRejects(
            () => runtime.start(artifact("export function invoke() {}")),
            Error,
            "entry allocation failed",
        );
        assertEquals(urls.created.length, 1);
        assertEquals(urls.revoked, urls.created);
    } finally {
        await runtime.stop();
        urls.restore();
    }
});

Deno.test("stopped and superseded startups cannot retain or terminate the replacement worker", async () => {
    const urls = trackObjectURLs();
    const runtime = new IsolatedPluginRuntime();
    try {
        const first = assertRejects(
            () =>
                runtime.start(
                    artifact(
                        "await new Promise(() => {}); export function invoke() {}",
                    ),
                ),
            Error,
            "restarted",
        );
        await runtime.start(
            artifact("export function invoke() { return 'replacement'; }"),
        );
        await first;
        assertEquals(await runtime.invoke({ method: "echo" }), "replacement");
        const stopped = assertRejects(
            () =>
                runtime.start(
                    artifact(
                        "await new Promise(() => {}); export function invoke() {}",
                    ),
                ),
            Error,
            "stopped",
        );
        await runtime.stop();
        await stopped;
        assertEquals(urls.revoked, urls.created);
        await assertRejects(
            () => runtime.invoke({ method: "echo" }),
            Error,
            "not running",
        );
    } finally {
        await runtime.stop();
        urls.restore();
    }
});

Deno.test("worker error and messageerror immediately notify observers after releasing resources", async () => {
    const urls = trackObjectURLs();
    const WorkerConstructor = globalThis.Worker;
    let worker: Worker | undefined;
    const runtime = new IsolatedPluginRuntime();
    const failures: string[] = [];
    const unsubscribe = runtime.onFailure((error) => {
        assertEquals(runtime.isActive(), false);
        assertEquals(urls.revoked, urls.created);
        failures.push(error.message);
    });
    try {
        globalThis.Worker = new Proxy(WorkerConstructor, {
            construct(target, args) {
                worker = Reflect.construct(target, args) as Worker;
                return worker;
            },
        });
        await runtime.start(artifact("export function invoke() {}"));
        worker!.dispatchEvent(new ErrorEvent("error", { cancelable: true }));
        assertEquals(failures, ["plugin worker failed"]);
        await runtime.start(artifact("export function invoke() {}"));
        worker!.dispatchEvent(new MessageEvent("messageerror"));
        assertEquals(failures, [
            "plugin worker failed",
            "plugin worker message failed",
        ]);
        unsubscribe();
        await runtime.start(artifact("export function invoke() {}"));
        await runtime.stop();
        assertEquals(failures.length, 2);
    } finally {
        globalThis.Worker = WorkerConstructor;
        unsubscribe();
        await runtime.stop();
        urls.restore();
    }
});

Deno.test("worker self-close is reported without waiting for another invocation", async () => {
    const runtime = new IsolatedPluginRuntime();
    const failure = Promise.withResolvers<Error>();
    runtime.onFailure(failure.resolve);
    try {
        await runtime.start(artifact(`export function invoke() {
            setTimeout(() => self.close(), 10);
            return "scheduled";
        }`));
        assertEquals(await runtime.invoke({ method: "close" }), "scheduled");
        assertEquals(
            (await failure.promise).message,
            "plugin worker closed unexpectedly",
        );
        assertEquals(runtime.isActive(), false);
    } finally {
        await runtime.stop();
    }
});

Deno.test("idle watchdog detects a lost worker message handler without caller activity", async () => {
    const runtime = new IsolatedPluginRuntime(300, 20);
    const failure = Promise.withResolvers<Error>();
    runtime.onFailure(failure.resolve);
    try {
        await runtime.start(artifact(`export function invoke() {
            self.onmessage = null;
            return "detached";
        }`));
        assertEquals(await runtime.invoke({ method: "detach" }), "detached");
        assertEquals(
            (await failure.promise).message,
            "plugin invocation timed out",
        );
        assertEquals(runtime.isActive(), false);
    } finally {
        await runtime.stop();
    }
});

function forgedResponse(expression: string) {
    return artifact(`export function invoke() {
        self.onmessage = ({ data }) => self.postMessage(${expression});
        return "armed";
    }`);
}

Deno.test("host rejects forged non-JSON worker results independently of plugin bootstrap", async () => {
    const runtime = new IsolatedPluginRuntime();
    const failures: string[] = [];
    runtime.onFailure((error) => failures.push(error.message));
    try {
        for (
            const value of [
                "new Map([['secret', 'value']])",
                "new Date()",
                "new Uint8Array([1, 2])",
                "1n",
                "Infinity",
                "{ nested: undefined }",
                "new Array(2)",
                "(() => { const item = {}; item.self = item; return item; })()",
                "Array.from({ length: 66 }).reduce((item) => [item], null)",
            ]
        ) {
            await runtime.start(
                forgedResponse(`{ id: data.id, value: ${value} }`),
            );
            assertEquals(await runtime.invoke({ method: "arm" }), "armed");
            await assertRejects(
                () => runtime.invoke({ method: "forged" }),
                TypeError,
                "invalid JSON",
            );
            assertEquals(runtime.isActive(), false);
        }
        assertEquals(failures.length, 9);
    } finally {
        await runtime.stop();
    }
});

Deno.test("host measures exact UTF-8 JSON bytes for forged worker results", async () => {
    const runtime = new IsolatedPluginRuntime();
    try {
        await runtime.start(
            forgedResponse("{ id: data.id, value: data.payload }"),
        );
        await runtime.invoke({ method: "arm" });
        // Quotes and multibyte text both count toward the wire size.
        const boundary = "中".repeat(87_380) + "aa";
        assertEquals(
            new TextEncoder().encode(JSON.stringify(boundary)).byteLength,
            256 * 1024,
        );
        assertEquals(
            await runtime.invoke({ method: "forged", payload: boundary }),
            boundary,
        );
        await assertRejects(
            () => runtime.invoke({ method: "forged", payload: boundary + "a" }),
            TypeError,
            "exceeds 256 KiB",
        );
        assertEquals(runtime.isActive(), false);
        await runtime.start(
            forgedResponse("{ id: data.id, value: '\\u0000'.repeat(50_000) }"),
        );
        await runtime.invoke({ method: "arm" });
        await assertRejects(
            () => runtime.invoke({ method: "forged" }),
            TypeError,
            "exceeds 256 KiB",
        );
        assertEquals(runtime.isActive(), false);
    } finally {
        await runtime.stop();
    }
});

Deno.test("host rejects malformed forged envelopes and errors without leaving RPCs pending", async () => {
    const runtime = new IsolatedPluginRuntime();
    try {
        for (
            const response of [
                "null",
                "{ id: data.id, error: 123 }",
                "{ id: data.id, error: 'x'.repeat(1001) }",
                "{ id: data.id, unknown: true }",
            ]
        ) {
            await runtime.start(forgedResponse(response));
            await runtime.invoke({ method: "arm" });
            await assertRejects(
                () => runtime.invoke({ method: "forged" }),
                Error,
                "invalid",
            );
            assertEquals(runtime.isActive(), false);
        }
    } finally {
        await runtime.stop();
    }
});
