import { join } from "node:path";
import {
    defaultDesktopBackend,
    type DesktopBackend,
    desktopCommand,
    desktopDistributionName,
    desktopProjectRoot,
    readDesktopBackend,
} from "./desktop-command.ts";
import { embedDesktopExecutableIcon } from "./desktop-icon.ts";

let backend: DesktopBackend = defaultDesktopBackend();
for (let index = 0; index < Deno.args.length; index++) {
    const argument = Deno.args[index]!;
    if (argument === "--help" || argument === "-h") {
        console.log(
            `Usage: deno task desktop:build [--backend webview|cef]\nDefault backend on ${Deno.build.os}: ${defaultDesktopBackend()}`,
        );
        Deno.exit(0);
    } else if (argument === "--backend") {
        backend = readDesktopBackend(Deno.args[++index]);
    } else if (argument.startsWith("--backend=")) {
        backend = readDesktopBackend(argument.slice("--backend=".length));
    } else throw new Error(`Unknown desktop build argument: ${argument}`);
}

const platform = `${Deno.build.os}-${Deno.build.arch}`;
const distribution = join(
    desktopProjectRoot,
    "dist",
    "desktop",
    desktopDistributionName(backend),
);
// On Windows --output is a bundle directory, not an .exe filename.
const output = join(
    distribution,
    "Heimdall",
);
const bundle = Deno.build.os === "darwin" ? `${output}.app` : output;

await run(["task", "build:web"]);
await Deno.mkdir(distribution, { recursive: true });
console.log(`Building native Deno desktop (${backend}) for ${platform}...`);
await run(await desktopCommand({ backend, output }));
await embedDesktopExecutableIcon(join(output, "Heimdall.exe"));

await Deno.writeTextFile(
    join(distribution, "build-info.json"),
    JSON.stringify(
        {
            platform,
            backend,
            deno: Deno.version.deno,
            builtAt: new Date().toISOString(),
            application: bundle.slice(distribution.length + 1),
        },
        null,
        2,
    ) + "\n",
);
await Deno.copyFile(
    join(desktopProjectRoot, "docs", "desktop.md"),
    join(distribution, "README.md"),
);
console.log(`Desktop bundle: ${bundle}`);
if (Deno.build.os === "windows") {
    console.log(`Launch: ${join(output, "Heimdall.exe")}`);
}
console.log(
    "Distribute the complete bundle directory, including its runtime libraries.",
);

async function run(args: string[]): Promise<void> {
    const result = await new Deno.Command(Deno.execPath(), {
        args,
        cwd: desktopProjectRoot,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    }).output();
    if (!result.success) Deno.exit(result.code || 1);
}
