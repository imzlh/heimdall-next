import { browserBuildCommands } from "./web-build.ts";
import {
    desktopCommand,
    desktopLaunchOptions,
    desktopProjectRoot,
} from "./desktop-command.ts";
import { desktopProcessOptions } from "./desktop-process.ts";

const options = desktopLaunchOptions(Deno.args);
if (options.scriptArgs?.includes("--smoke")) {
    throw new Error(
        "Use deno task desktop:smoke for isolated native acceptance checks.",
    );
}
await using processOptions = await desktopProcessOptions(options.scriptArgs);

/** Keep the native host and each browser bundle under one development command. */
const commands = [
    ...await browserBuildCommands(true),
    await desktopCommand({
        ...options,
        scriptArgs: processOptions.args,
        development: true,
    }),
];
const children = commands.map((args) =>
    new Deno.Command(Deno.execPath(), {
        args,
        cwd: desktopProjectRoot,
        env: processOptions.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    }).spawn()
);

let stopped = false;
function stop(): void {
    if (stopped) return;
    stopped = true;
    for (const child of children) {
        try {
            child.kill("SIGTERM");
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
    }
}

const signals: Deno.Signal[] = Deno.build.os === "windows"
    ? ["SIGINT"]
    : ["SIGINT", "SIGTERM"];
for (const signal of signals) Deno.addSignalListener(signal, stop);
try {
    const status = await Promise.race(children.map((child) => child.status));
    stop();
    await Promise.all(children.map((child) => child.status));
    Deno.exitCode = status.code;
    if (status.success) await processOptions.verifySmoke();
} finally {
    stop();
    for (const signal of signals) Deno.removeSignalListener(signal, stop);
}
