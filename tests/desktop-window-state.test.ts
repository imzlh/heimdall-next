import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import {
    createDesktopWindowStateStore,
    DEFAULT_DESKTOP_WINDOW_STATE,
    loadDesktopWindowState,
    sanitizeDesktopWindowState,
} from "@heimdall/core/desktop/window-state.ts";

Deno.test("desktop window state rejects invalid bounds and discards unsupported fields", () => {
    for (
        const value of [
            null,
            [],
            {},
            { width: "1280", height: 840 },
            { width: 1280.5, height: 840 },
            { width: 639, height: 840 },
            { width: 1280, height: 479 },
            { width: 16_385, height: 840 },
            { width: 1280, height: Infinity },
        ]
    ) {
        assertEquals(
            sanitizeDesktopWindowState(value),
            DEFAULT_DESKTOP_WINDOW_STATE,
        );
    }

    assertEquals(
        sanitizeDesktopWindowState({
            width: 1440,
            height: 900,
            x: -1920,
            y: 40,
            alwaysOnTop: true,
            maximized: true,
            token: "discarded",
        }),
        { width: 1440, height: 900, x: -1920, y: 40, alwaysOnTop: true },
    );
    for (
        const position of [{ x: 20 }, { x: 0, y: NaN }, { x: 100_001, y: 0 }]
    ) {
        assertEquals(
            sanitizeDesktopWindowState({
                width: 1280,
                height: 840,
                ...position,
                alwaysOnTop: "false",
            }),
            DEFAULT_DESKTOP_WINDOW_STATE,
        );
    }
});

Deno.test("desktop window state tolerates missing, corrupt and unsupported preference files", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "desktop-window-state-",
    });
    try {
        assertEquals(
            await loadDesktopWindowState(directory),
            DEFAULT_DESKTOP_WINDOW_STATE,
        );
        for (
            const content of [
                "{broken",
                "null",
                JSON.stringify({
                    version: 2,
                    window: { width: 900, height: 600 },
                }),
                JSON.stringify({ version: 1, window: { width: 1, height: 1 } }),
                " ".repeat(4097),
            ]
        ) {
            await Deno.writeTextFile(
                join(directory, "desktop-window.json"),
                content,
            );
            assertEquals(
                await loadDesktopWindowState(directory),
                DEFAULT_DESKTOP_WINDOW_STATE,
            );
        }
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("desktop window preferences save the newest concurrent state atomically and restore it", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "desktop-window-state-",
    });
    try {
        const dataDirectory = join(directory, "profile");
        const store = createDesktopWindowStateStore(dataDirectory);
        const old = store.save({ width: 1000, height: 700 });
        const latest = {
            width: 1440,
            height: 900,
            x: -1440,
            y: 60,
            alwaysOnTop: true,
        };
        const current = store.save(latest);
        assertEquals(
            old,
            current,
            "Concurrent saves share a completion for the latest state",
        );
        await current;
        assertEquals(await store.load(), latest);
        assertEquals(
            JSON.parse(
                await Deno.readTextFile(
                    join(dataDirectory, "desktop-window.json"),
                ),
            ),
            { version: 1, window: latest },
        );

        await store.save({ width: 1280, height: 840, alwaysOnTop: false });
        assertEquals(await store.load(), {
            width: 1280,
            height: 840,
            alwaysOnTop: false,
        });
        const files = [];
        for await (const entry of Deno.readDir(dataDirectory)) {
            files.push(entry.name);
        }
        assertEquals(
            files,
            ["desktop-window.json"],
            "Atomic saves must remove temporary files",
        );
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("desktop window preference write failures remain observable and do not poison later saves", async () => {
    const directory = await Deno.makeTempDir({
        prefix: "desktop-window-state-",
    });
    try {
        const dataDirectory = join(directory, "profile");
        await Deno.writeTextFile(dataDirectory, "blocks directory creation");
        const store = createDesktopWindowStateStore(dataDirectory);
        await assertRejects(() => store.save(DEFAULT_DESKTOP_WINDOW_STATE));
        await Deno.remove(dataDirectory);
        await store.save({ width: 1440, height: 900 });
        assertEquals(await store.load(), { width: 1440, height: 900 });
        assert(
            (await Deno.stat(join(dataDirectory, "desktop-window.json")))
                .isFile,
        );
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
});
