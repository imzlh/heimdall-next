import {
    assert,
    assertEquals,
    assertRejects,
    assertStrictEquals,
} from "@std/assert";
import {
    readServerEnvironment,
    type ServerEnvironment,
} from "@heimdall/core/composition/runtime-env.ts";
import { startRuntime } from "@heimdall/core/runtime/server.ts";

function environmentAt(directory: string): ServerEnvironment {
    const defaults = readServerEnvironment(() => undefined, directory);
    return {
        ...defaults,
        kvPath: `${directory}/config.sqlite`,
        httpLog: false,
        runtimeSettings: { ...defaults.runtimeSettings, probeIntervalMs: 0 },
    };
}

Deno.test("embedded runtime returns its bound origin and releases storage and port", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-runtime-" });
    const environment = environmentAt(directory);
    try {
        for (let run = 0; run < 2; run++) {
            let listened: Deno.NetAddr | undefined;
            const runtime = await startRuntime({
                environment: { ...environment, hostname: "invalid.localhost" },
                hostname: "127.0.0.1",
                port: 0,
                onListen: (address) => {
                    listened = address;
                },
            });
            const client = Deno.createHttpClient({});
            try {
                assert(runtime.address.port > 0);
                assertEquals(runtime.address.hostname, "127.0.0.1");
                assertEquals(listened, runtime.address);
                assertEquals(
                    runtime.url,
                    `http://127.0.0.1:${runtime.address.port}`,
                );
                const health = await fetch(`${runtime.url}/health`, { client });
                assertEquals(health.status, 200);
                assertEquals(await health.json(), { status: "ok" });
            } finally {
                client.close();
                const closing = runtime.close();
                assertStrictEquals(runtime.close(), closing);
                await closing;
                await runtime.finished;
                await runtime[Symbol.asyncDispose]();
            }
            using _rebound = Deno.listen({
                hostname: runtime.address.hostname,
                port: runtime.address.port,
            });
        }
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("embedded runtime abort settles after storage cleanup", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-abort-" });
    const environment = environmentAt(directory);
    try {
        const controller = new AbortController();
        const runtime = await startRuntime({
            environment,
            port: 0,
            signal: controller.signal,
        });
        controller.abort();
        await runtime.finished;
        await runtime.close();
        // Reopening the same request store proves finished also released its lock.
        await using _restarted = await startRuntime({ environment, port: 0 });
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("embedded runtime rejects a cancelled start before opening storage", async () => {
    const controller = new AbortController();
    controller.abort(new Error("host closed during startup"));
    await assertRejects(
        () => startRuntime({ signal: controller.signal }),
        Error,
        "host closed during startup",
    );
});

Deno.test("failed bind and ready callback both release durable runtime resources", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-bind-" });
    const environment = environmentAt(directory);
    try {
        const occupied = Deno.listen({ hostname: "127.0.0.1", port: 0 });
        try {
            await assertRejects(
                () => startRuntime({ environment, port: occupied.addr.port }),
                Deno.errors.AddrInUse,
            );
        } finally {
            occupied.close();
        }
        await assertRejects(
            () =>
                startRuntime({
                    environment,
                    port: 0,
                    onListen: () => {
                        throw new Error("window failed to open");
                    },
                }),
            Error,
            "window failed to open",
        );
        await using _restarted = await startRuntime({ environment, port: 0 });
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("desktop runtime rejects public binds and missing admin credentials", async () => {
    const environment = readServerEnvironment(() => undefined);
    const desktopSession = {
        origin: "http://127.0.0.1:8088",
        bootstrapToken: crypto.randomUUID(),
    };
    await assertRejects(
        () =>
            startRuntime({
                environment: {
                    ...environment,
                    adminAuthToken: "private-token",
                },
                hostname: "0.0.0.0",
                desktopSession,
            }),
        TypeError,
        "loopback",
    );
    await assertRejects(
        () => startRuntime({ environment, desktopSession }),
        TypeError,
        "admin auth token",
    );
});

Deno.test("embedded runtime rejects invalid port and shutdown settings", async () => {
    for (const port of [-1, 65_536, 1.5, NaN]) {
        await assertRejects(() => startRuntime({ port }), RangeError, "port");
    }
    for (const shutdownTimeoutMs of [-1, Infinity, 1.5]) {
        await assertRejects(
            () => startRuntime({ shutdownTimeoutMs }),
            RangeError,
            "shutdownTimeoutMs",
        );
    }
});

Deno.test("embedded runtime bounds shutdown when a client leaves a request open", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heimdall-close-" });
    try {
        await using runtime = await startRuntime({
            environment: environmentAt(directory),
            port: 0,
            shutdownTimeoutMs: 25,
        });
        using connection = await Deno.connect({
            hostname: runtime.address.hostname,
            port: runtime.address.port,
        });
        await connection.write(new TextEncoder().encode(
            `POST /admin/session HTTP/1.1\r\nHost: ${
                new URL(runtime.url).host
            }\r\nOrigin: ${runtime.url}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n`,
        ));
        // The interim response proves the handler is waiting for the missing body.
        const response = new Uint8Array(128);
        const read = await connection.read(response);
        assert(read !== null);
        assert(
            new TextDecoder().decode(response.subarray(0, read)).includes(
                "100 Continue",
            ),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                runtime.close(),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error("runtime shutdown did not finish"),
                            ),
                        2_000,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("desktop runtime bootstraps an authenticated UI at its assigned origin", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "heimdall-desktop-runtime-",
    });
    let origin = "";
    const bootstrapToken = crypto.randomUUID();
    const environment = {
        ...environmentAt(directory),
        adminAuthToken: crypto.randomUUID(),
    };
    try {
        await using runtime = await startRuntime({
            environment,
            port: 0,
            desktopSession: { origin: () => origin, bootstrapToken },
        });
        origin = runtime.url;
        using client = Deno.createHttpClient({});
        const startup = await fetch(`${origin}/admin/desktop/bootstrap`, {
            client,
        });
        assertEquals(startup.status, 200);
        const document = await startup.text();
        assert(!document.includes(bootstrapToken));
        assert(!document.includes(environment.adminAuthToken));

        const exchange = await fetch(`${origin}/admin/desktop/bootstrap`, {
            client,
            method: "POST",
            headers: { origin },
            body: new URLSearchParams({ token: bootstrapToken }),
        });
        assertEquals(exchange.status, 204);
        const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
        assert(cookie);
        const chat = await fetch(`${origin}/admin/chat`, {
            client,
            headers: { cookie },
            redirect: "manual",
        });
        assertEquals(chat.status, 200);
        await chat.body?.cancel();

        const foreign = await fetch(`${origin}/admin/chat`, {
            client,
            headers: { cookie, origin: "https://foreign.example" },
            redirect: "manual",
        });
        assertEquals(foreign.status, 403);
        await foreign.body?.cancel();
        const health = await fetch(`${origin}/health`, { client });
        assertEquals(health.status, 200);
        await health.body?.cancel();
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
});
