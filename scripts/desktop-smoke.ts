import { join, resolve } from "node:path";
import {
    desktopDistributionName,
    desktopProjectRoot,
} from "./desktop-command.ts";
import { desktopProcessOptions } from "./desktop-process.ts";

const output = join(
    desktopProjectRoot,
    "dist",
    "desktop",
    desktopDistributionName(),
    "Heimdall",
);
const defaultExecutable = Deno.build.os === "windows"
    ? join(output, "Heimdall.exe")
    : Deno.build.os === "darwin"
    ? join(`${output}.app`, "Contents", "MacOS", "Heimdall")
    : join(output, "Heimdall");
if (Deno.args.length > 1) {
    throw new Error("Usage: deno task desktop:smoke:bundle [executable]");
}
const executable = resolve(Deno.args[0] ?? defaultExecutable);
await using processOptions = await desktopProcessOptions(["--smoke"]);
const result = await new Deno.Command(
    await processOptions.isolateBundle(executable),
    {
        args: processOptions.args,
        env: processOptions.env,
        // Prove packaged assets and plugins work independently of the source cwd.
        cwd: processOptions.cwd,
        stdin: "null",
        stdout: "inherit",
        stderr: "inherit",
    },
).output();
if (!result.success) {
    throw new Error(`Packaged desktop exited with code ${result.code}.`);
}
const report = await processOptions.verifySmoke();
if (!Deno.args.length) {
    await Deno.writeTextFile(
        join(output, "..", "smoke-result.json"),
        JSON.stringify(
            { ...report, checkedAt: new Date().toISOString() },
            null,
            2,
        ) + "\n",
    );
}
