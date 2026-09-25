import { browserBuildCommands } from "./web-build.ts";

for (const args of await browserBuildCommands()) {
    const { success, code } = await new Deno.Command(Deno.execPath(), {
        args,
        stdout: "inherit",
        stderr: "inherit",
    }).output();
    if (!success) Deno.exit(code || 1);
}
