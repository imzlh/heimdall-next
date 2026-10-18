import { assert, assertEquals, assertThrows } from "@std/assert";
import {
    defaultDesktopBackend,
    desktopCommand,
    desktopDistributionName,
    desktopLaunchOptions,
} from "../scripts/desktop-command.ts";

Deno.test("desktop builds and bundle smoke default to the system WebView on every platform", () => {
    assertEquals(defaultDesktopBackend("windows"), "webview");
    assertEquals(defaultDesktopBackend("darwin"), "webview");
    assertEquals(defaultDesktopBackend("linux"), "webview");
    assertEquals(
        desktopDistributionName(undefined, "windows", "x86_64"),
        "windows-x86_64",
    );
    assertEquals(
        desktopDistributionName("cef", "windows", "x86_64"),
        "windows-x86_64-cef",
    );
    assertEquals(
        desktopDistributionName(undefined, "darwin", "aarch64"),
        "darwin-aarch64",
    );
});

for (const backend of ["cef", "webview"] as const) {
    Deno.test(`desktop ${backend} build embeds its backend for direct executable launches`, async () => {
        const args = await desktopCommand({
            backend,
            development: true,
            output: "dist/desktop/test/Heimdall",
            scriptArgs: ["--debug", "--data-dir", "data with spaces"],
        });
        const entrypoint = args.indexOf("desktop.ts");
        assert(entrypoint > 0);
        assertEquals(args[args.indexOf("--backend") + 1], backend);
        assertEquals(
            args[args.indexOf("--icon") + 1],
            Deno.build.os === "windows"
                ? "src/desktop/icon.ico"
                : "src/desktop/icon.png",
        );
        assert(args.slice(0, entrypoint).includes("--hmr"));
        assertEquals(args.slice(entrypoint + 1), [
            "--",
            `--native-backend=${backend}`,
            "--debug",
            "--data-dir",
            "data with spaces",
        ]);
    });
}

Deno.test("desktop launcher preserves application arguments while consuming backend selection", () => {
    assertEquals(desktopLaunchOptions(["--backend=webview", "--debug"]), {
        backend: "webview",
        scriptArgs: ["--debug"],
    });
    assertEquals(
        desktopLaunchOptions(["--data-dir", "a b", "--backend", "cef"]),
        {
            backend: "cef",
            scriptArgs: ["--data-dir", "a b"],
        },
    );
    assertThrows(() => desktopLaunchOptions(["--backend"]), Error);
    assertThrows(() => desktopLaunchOptions(["--backend", "unknown"]), Error);
});

Deno.test("Windows executable icon preserves the existing PNG artwork in a valid ICO entry", async () => {
    const [png, ico] = await Promise.all([
        Deno.readFile(new URL("../src/desktop/icon.png", import.meta.url)),
        Deno.readFile(new URL("../src/desktop/icon.ico", import.meta.url)),
    ]);
    const image = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const header = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    assertEquals(header.getUint16(0, true), 0);
    assertEquals(header.getUint16(2, true), 1);
    assertEquals(header.getUint16(4, true), 1);
    assertEquals(ico[6] || 256, image.getUint32(16));
    assertEquals(ico[7] || 256, image.getUint32(20));
    assertEquals(header.getUint16(10, true), 1);
    assertEquals(header.getUint16(12, true), 32);
    assertEquals(header.getUint32(14, true), png.length);
    assertEquals(header.getUint32(18, true), 22);
    assertEquals(ico.slice(22), png);
});
