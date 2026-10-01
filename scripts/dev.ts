import { browserBuildCommands } from "./web-build.ts";

/** Supervise each browser entry and the server directly, without nested watchers. */
const commands = [
    ...await browserBuildCommands(true),
    ...(Deno.args.includes("--web-only") ? [] : [[
        "run",
        "--unstable-kv",
        "--unstable-worker-options",
        "--watch=main.ts,src,packages,plugins",
        "--watch-exclude=public",
        "--allow-net",
        "--allow-env",
        "--allow-read",
        "--allow-write",
        "./main.ts",
    ]]),
];
const children = commands.map((args) =>
    new Deno.Command(Deno.execPath(), {
        args,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    }).spawn()
);

function stop(): void {
    for (const child of children) {
        try {
            child.kill("SIGTERM");
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
    }
}

Deno.addSignalListener("SIGINT", stop);
try {
    const status = await Promise.race(children.map((child) => child.status));
    stop();
    await Promise.all(children.map((child) => child.status));
    Deno.exitCode = status.code;
} finally {
    Deno.removeSignalListener("SIGINT", stop);
}
