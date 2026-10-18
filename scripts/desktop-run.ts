import { join } from "node:path";
import {
    defaultDesktopBackend,
    desktopCommand,
    desktopLaunchOptions,
    desktopProjectRoot,
} from "./desktop-command.ts";
import { desktopProcessOptions } from "./desktop-process.ts";
import { embedDesktopExecutableIcon } from "./desktop-icon.ts";

const options = desktopLaunchOptions(Deno.args);
const backend = options.backend ?? defaultDesktopBackend();
const directory = join(
    desktopProjectRoot,
    "dist",
    "desktop",
    `local-${Deno.build.os}-${Deno.build.arch}-${backend}${
        options.scriptArgs?.includes("--smoke") ? "-smoke" : ""
    }`,
);
await Deno.mkdir(directory, { recursive: true });
const output = join(directory, "Heimdall");
const build = await new Deno.Command(Deno.execPath(), {
    args: await desktopCommand({ backend, output }),
    cwd: desktopProjectRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
}).output();
if (!build.success) Deno.exit(build.code || 1);
await using processOptions = await desktopProcessOptions(options.scriptArgs);

// Without --hmr the native CLI only packages; start the packaged launcher.
const executable = Deno.build.os === "windows"
    ? join(output, "Heimdall.exe")
    : Deno.build.os === "darwin"
    ? join(`${output}.app`, "Contents", "MacOS", "Heimdall")
    : join(output, "Heimdall");
await embedDesktopExecutableIcon(executable);
const result = await new Deno.Command(
    await processOptions.isolateBundle(executable),
    {
        args: processOptions.args,
        env: processOptions.env,
        cwd: directory,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    },
).output();
Deno.exitCode = result.code;
if (result.success) await processOptions.verifySmoke();
