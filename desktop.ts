import { runDesktop, showDesktopError } from "@heimdall/core/desktop/app.ts";

if (import.meta.main) {
    try {
        await runDesktop();
    } catch (error) {
        await showDesktopError(error);
        Deno.exitCode = 1;
    }
}
