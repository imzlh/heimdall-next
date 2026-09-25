import { readRetentionDays } from "./maintenance.ts";
import { readProbeInterval } from "./probe-loop.ts";
import type { RuntimeSettings } from "./runtime-settings.ts";
import { resolveTimeZone } from "../stats/calendar.ts";

/** Process configuration, parsed before any durable resources are opened. */
export interface ServerEnvironment {
    readonly hostname: string;
    readonly port: number;
    readonly kvPath?: string;
    readonly requestsPath: string;
    readonly chatPath: string;
    readonly retentionDays: number;
    /** IANA zone whose civil dates are the natural days in usage statistics. */
    readonly timeZone: string;
    readonly runtimeSettings: RuntimeSettings;
    readonly adminAuthToken?: string;
    readonly adminAssetsRoot?: string;
    readonly adminUiPolicyPath?: string;
}

export function readServerEnvironment(
    env: (name: string) => string | undefined = (name) => Deno.env.get(name),
    cwd: string = Deno.cwd(),
): ServerEnvironment {
    const optional = (name: string) => env(name)?.trim() || undefined;
    return {
        hostname: optional("HOST") ?? "127.0.0.1",
        port: readPort(env("PORT")),
        kvPath: optional("HEIMDALL_KV_PATH"),
        requestsPath: optional("HEIMDALL_REQUESTS_PATH") ??
            `${cwd}/data/requests.sqlite`,
        chatPath: optional("HEIMDALL_CHAT_PATH") ?? `${cwd}/data/chat.sqlite`,
        retentionDays: readRetentionDays(
            env("HEIMDALL_REQUEST_RETENTION_DAYS"),
        ),
        timeZone: readTimeZone(env("HEIMDALL_TIMEZONE")),
        runtimeSettings: {
            proxyKey: optional("HEIMDALL_PROXY_KEY") ?? "",
            limitPerMinute: readRateLimit(env("HEIMDALL_RATE_LIMIT")),
            probeIntervalMs: readProbeInterval(
                env("HEIMDALL_PROBE_INTERVAL_MS"),
            ),
        },
        adminAuthToken: optional("HEIMDALL_ADMIN_TOKEN"),
        adminAssetsRoot: optional("HEIMDALL_ADMIN_ASSETS"),
        adminUiPolicyPath: optional("HEIMDALL_UI_POLICY_PATH"),
    };
}

export function readPort(value: string | undefined): number {
    const port = Number(value ?? "8088");
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new RangeError("PORT must be an integer between 1 and 65535");
    }
    return port;
}

export function readRateLimit(value: string | undefined): number {
    if (value === undefined || value.trim().length === 0) return 120;
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 0 || limit > 100_000) {
        throw new RangeError(
            "HEIMDALL_RATE_LIMIT must be an integer from 0 to 100000",
        );
    }
    return limit;
}

/** Parse HEIMDALL_TIMEZONE. Empty or absent means the process time zone. */
export function readTimeZone(value: string | undefined): string {
    try {
        return resolveTimeZone(value);
    } catch {
        throw new RangeError(
            "HEIMDALL_TIMEZONE must be an IANA time zone such as Asia/Shanghai",
        );
    }
}
