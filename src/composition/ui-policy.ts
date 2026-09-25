import {
    isUiJsonObject,
    safeUiAssetPath,
} from "@heimdall/admin-contracts/ui.ts";
import type { UiPolicy } from "@heimdall/admin-contracts/ui.ts";

/** Explicit operator configuration. A plugin manifest can never grant itself trust. */
export async function loadUiPolicy(path?: string): Promise<UiPolicy> {
    if (!path) return {};
    using file = await Deno.open(path, { read: true });
    const bytes = new Uint8Array(16_385);
    let read = 0;
    while (read < bytes.length) {
        const count = await file.read(bytes.subarray(read));
        if (count === null) break;
        read += count;
    }
    if (read > 16_384) throw new TypeError("UI policy exceeds 16 KiB");
    return parseUiPolicy(
        JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
                bytes.subarray(0, read),
            ),
        ),
    );
}

export function parseUiPolicy(value: unknown): UiPolicy {
    if (
        !isUiJsonObject(value) ||
        Object.keys(value).some((key) =>
            !["trustedModules", "sandboxDocuments", "allowedActions"].includes(
                key,
            )
        )
    ) {
        throw new TypeError(
            "UI policy must contain only host asset and action allowlists",
        );
    }
    for (const [name, entries] of Object.entries(value)) {
        if (!isUiJsonObject(entries)) {
            throw new TypeError(`Invalid UI policy ${name}`);
        }
        for (const [key, item] of Object.entries(entries)) {
            if (
                !/^[a-zA-Z0-9][a-zA-Z0-9._-]*:[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(
                    key,
                )
            ) {
                throw new TypeError(
                    "UI policy keys must identify plugin:contribution",
                );
            }
            const valid = name === "allowedActions"
                ? Array.isArray(item) && item.length <= 32 &&
                    item.every((action) =>
                        typeof action === "string" &&
                        /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(action)
                    )
                : safeUiAssetPath(
                    item,
                    name === "trustedModules" ? "js" : "html",
                );
            if (!valid) throw new TypeError(`Invalid UI policy entry ${key}`);
        }
    }
    return JSON.parse(JSON.stringify(value)) as UiPolicy;
}
