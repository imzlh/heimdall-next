import { browserBuildCommands, bundleIsFresh } from "./web-build.ts";

for (const args of await browserBuildCommands()) {
    const output = args[args.indexOf("--output") + 1];
    const config = args[args.indexOf("--config") + 1];
    const entry = args.at(-1);
    if (
        output && config && entry &&
        await bundleIsFresh(output, entry, config)
    ) {
        console.log(`up to date ${output}`);
        continue;
    }
    const { success, code } = await new Deno.Command(Deno.execPath(), {
        args,
        stdout: "inherit",
        stderr: "inherit",
    }).output();
    if (!success) Deno.exit(code || 1);
}
