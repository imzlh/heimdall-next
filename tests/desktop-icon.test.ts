import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

Deno.test({
    name:
        "desktop icon packaging verifies PE resources and rejects invalid ICO without changing the executable",
    ignore: Deno.build.os !== "windows",
    async fn() {
        const directory = await Deno.makeTempDir({
            prefix: "heimdall-icon-test-",
        });
        try {
            // Compile a tiny test-only launcher. Never edit or execute a system
            // utility or a running desktop bundle while testing resource updates.
            const fixtureScript = join(directory, "fixture.ps1");
            const executable = join(directory, "IconFixture.exe");
            await Deno.writeTextFile(
                fixtureScript,
                `param([string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -OutputType ConsoleApplication -OutputAssembly $Output -TypeDefinition 'public class IconFixture { public static void Main() {} }'
`,
            );
            const compile = await powershell(fixtureScript, [
                "-Output",
                executable,
            ]);
            assert(compile.success, new TextDecoder().decode(compile.stderr));
            const before = await Deno.readFile(executable);
            const icon = fileURLToPath(
                new URL("../src/desktop/icon.ico", import.meta.url),
            );
            const script = fileURLToPath(
                new URL("../scripts/desktop-icon.ps1", import.meta.url),
            );
            const update = await powershell(script, [
                "-Executable",
                executable,
                "-Icon",
                icon,
            ]);
            assert(update.success, new TextDecoder().decode(update.stderr));
            assert(
                new TextDecoder().decode(update.stdout).includes(
                    "Embedded and verified",
                ),
            );
            const patched = await Deno.readFile(executable);
            assertNotEquals(patched, before);
            assertEquals(patched.slice(0, 2), new Uint8Array([0x4d, 0x5a]));

            const invalid = await Deno.readFile(icon);
            new DataView(invalid.buffer, invalid.byteOffset, invalid.byteLength)
                .setUint32(18, 0xffff_ffff, true);
            const invalidIcon = join(directory, "invalid.ico");
            await Deno.writeFile(invalidIcon, invalid);
            const rejected = await powershell(script, [
                "-Executable",
                executable,
                "-Icon",
                invalidIcon,
            ]);
            assertEquals(rejected.success, false);
            assertEquals(await Deno.readFile(executable), patched);
            const leftovers = [];
            for await (const entry of Deno.readDir(directory)) {
                if (entry.name.startsWith(".heimdall-icon-")) {
                    leftovers.push(entry.name);
                }
            }
            assertEquals(leftovers, []);
        } finally {
            // This exact directory was allocated by makeTempDir above.
            await Deno.remove(directory, { recursive: true });
        }
    },
});

function powershell(
    script: string,
    args: string[],
): Promise<Deno.CommandOutput> {
    return new Deno.Command("powershell.exe", {
        args: [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script,
            ...args,
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
    }).output();
}
