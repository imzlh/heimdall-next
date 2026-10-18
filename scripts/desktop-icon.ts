import { join } from "node:path";
import { desktopProjectRoot } from "./desktop-command.ts";

/** Deno 2.9.7 ships AppIcon.ico beside the launcher but does not embed it. */
export async function embedDesktopExecutableIcon(
    executable: string,
): Promise<void> {
    if (Deno.build.os !== "windows") return;
    const result = await new Deno.Command("powershell.exe", {
        args: [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            join(desktopProjectRoot, "scripts", "desktop-icon.ps1"),
            "-Executable",
            executable,
            "-Icon",
            join(desktopProjectRoot, "src", "desktop", "icon.ico"),
        ],
        cwd: desktopProjectRoot,
        stdin: "null",
        stdout: "inherit",
        stderr: "inherit",
    }).output();
    if (!result.success) {
        throw new Error(
            `Cannot embed the Windows executable icon (exit ${result.code}).`,
        );
    }
}
