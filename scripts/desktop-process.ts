import { cp } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
    desktopDataDirectory,
    parseDesktopArguments,
} from "../src/desktop/config.ts";

/** Native windows are created before application JS; set their profile first. */
export async function desktopProcessOptions(
    scriptArgs: readonly string[] = [],
) {
    const options = parseDesktopArguments(scriptArgs);
    const dataDirectory = options.dataDirectory ?? desktopDataDirectory();
    const temporary = options.smoke
        ? await Deno.makeTempDir({ prefix: "heimdall-native-smoke-" })
        : undefined;
    const ownedTemporary = temporary
        ? await Deno.realPath(temporary)
        : undefined;
    const profile = temporary
        ? join(temporary, "profile")
        : Deno.env.get("WEBVIEW2_USER_DATA_FOLDER") ||
            join(dataDirectory, "webview");
    const report = temporary ? join(temporary, "report.json") : undefined;
    const env: Record<string, string> = {
        WEBVIEW2_USER_DATA_FOLDER: profile,
        HEIMDALL_DESKTOP_DATA_DIR: temporary
            ? join(temporary, "data")
            : dataDirectory,
    };
    if (report) env.HEIMDALL_DESKTOP_SMOKE_REPORT = report;
    // The native runtime changes cwd to its embedded filesystem. Resolve user
    // supplied data directories before launching it, while the CLI cwd is known.
    const args = [...scriptArgs];
    for (let index = 0; index < args.length; index++) {
        if (args[index] === "--data-dir") args[++index] = dataDirectory;
        else if (args[index]?.startsWith("--data-dir=")) {
            args[index] = `--data-dir=${dataDirectory}`;
        }
    }
    return {
        env,
        args,
        cwd: temporary,
        async isolateBundle(executable: string): Promise<string> {
            if (!temporary) return executable;
            const source = Deno.build.os === "darwin"
                ? dirname(dirname(dirname(executable)))
                : dirname(executable);
            const target = join(temporary, "bundle", basename(source));
            await cp(source, target, {
                recursive: true,
                // Browser state is not part of the generated application. Never
                // copy a user's existing portable profile into an acceptance run.
                filter: (path) => !basename(path).endsWith(".WebView2"),
            });
            return join(target, relative(source, executable));
        },
        async verifySmoke() {
            if (!report) return;
            const result = JSON.parse(await Deno.readTextFile(report)) as {
                status?: string;
                native?: boolean;
                error?: string;
                checks?: string[];
            };
            if (
                result.status !== "passed" ||
                result.native !== !options.headless
            ) {
                throw new Error(
                    result.error ??
                        "Native desktop smoke did not report success.",
                );
            }
            console.log("Native desktop smoke report verified.");
            return result;
        },
        async [Symbol.asyncDispose](): Promise<void> {
            if (!temporary || !ownedTemporary) return;
            // Remove only the exact directory created by this invocation, after
            // the backend exits and releases its native browser profile.
            if (await Deno.realPath(temporary) !== ownedTemporary) {
                throw new Error(
                    "Refusing to remove a replaced smoke directory.",
                );
            }
            for (let attempt = 0;; attempt++) {
                try {
                    await Deno.remove(ownedTemporary, { recursive: true });
                    return;
                } catch (error) {
                    if (error instanceof Deno.errors.NotFound) return;
                    if (attempt >= 9) throw error;
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
            }
        },
    };
}
